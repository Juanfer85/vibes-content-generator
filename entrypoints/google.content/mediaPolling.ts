import { Actions, BatchModes } from '../../lib/types';
import type { BatchMode } from '../../lib/types';
import {
  IMAGE_MEDIA_POLL_MAX_ATTEMPTS,
  VIDEO_MEDIA_POLL_MAX_ATTEMPTS,
  MAX_MEDIA_PER_BATCH,
  MEDIA_STABILIZE_MS,
  MEDIA_POLL_INTERVAL_MS,
} from './constants';
import { aborted } from './abortState';
import { sleep, waitFor, nativeHover } from './domUtils';

// SendPrompt's sendResponse already fired (instantly, before any of this
// ran) — every outcome from here on, success or failure, travels as its own
// independent message instead. `retryAfterMs` is this site's own rate-limit
// cooldown for the mode in question, so background.ts doesn't have to guess.
export async function reportSceneFailed(sceneNumber: number, reason: string, retryAfterMs: number) {
  await browser.runtime.sendMessage({
    action: Actions.SceneFailed,
    sceneNumber,
    reason,
    retryAfterMs,
  });
}

// ── Tile reading ───────────────────────────────────────────────────────────────

// El rediseno de flow.google.com (2026-09) quito el data-tile-id del
// contenedor envolvente (<flow-tile-container> / <flow-image-tile>, sin
// atributo identificador propio) y en su lugar el <img>/<video> final trae
// data-media-id="<uuid>" directo -- pero SOLO una vez que la media termino
// de generarse: mientras esta pendiente, la tarjeta muestra un <canvas> de
// esqueleto sin ningun atributo identificador. Por eso ya no hace falta
// (ni se puede) rastrear un estado "pending" por id propio: la sola
// aparicion de un data-media-id nuevo ES la senal de que esa generacion
// esta lista.
// Los VIDEOS no llevan data-media-id (verificado en vivo el 2026-09-06:
// los tiles de video son <flow-video-tile> y su unica marca propia es la
// URL de la miniatura, que si es unica por video). Ademas su <video> real
// ni siquiera existe en el DOM hasta que el mouse pasa por encima. Por eso
// se los rastrea aparte, por esa URL, y su src real se resuelve despues
// con un hover (ver resolverUrlDeVideo).
function getVideoThumbnailUrls(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('flow-video-tile img.thumbnail')
  )
    .map((img) => img.getAttribute('src') ?? '')
    .filter(Boolean);
}

function getAllTileIds(): Set<string> {
  const ids = new Set<string>();
  document.querySelectorAll<HTMLElement>('[data-media-id]').forEach((media) => {
    const id = media.getAttribute('data-media-id');
    if (id) ids.add(id);
  });
  getVideoThumbnailUrls().forEach((url) => ids.add(url));
  return ids;
}

// Pasa el mouse por encima del tile para que Flow cargue su <video> y
// devuelve la URL real. Sin esto no hay forma de bajar el video: el src
// solo existe despues del hover.
async function resolverUrlDeVideo(thumbnailUrl: string): Promise<string | null> {
  const img = Array.from(
    document.querySelectorAll<HTMLImageElement>('flow-video-tile img.thumbnail')
  ).find((i) => i.getAttribute('src') === thumbnailUrl);
  const tile = img?.closest<HTMLElement>('flow-video-tile');
  if (!tile) return null;

  await nativeHover(tile);
  const video = await waitFor(() => {
    const v = tile.querySelector<HTMLVideoElement>('video');
    const src = v?.currentSrc || v?.src;
    return src ? src : null;
  }, 8000);
  return video ?? null;
}

export function getMediaTileIds(): Set<string> {
  return getAllTileIds();
}

const TileStatuses = {
  Ready: 'ready',
  Failed: 'failed',
  Pending: 'pending',
} as const;

type TileState =
  | { status: typeof TileStatuses.Ready; isVideo: boolean; url: string }
  | { status: typeof TileStatuses.Failed }
  | { status: typeof TileStatuses.Pending };

// No hay (todavia) forma confirmada de detectar una tarjeta fallida bajo el
// rediseno -- la deteccion vieja (icono "warning" + .sc-101009f9-2, clases
// de styled-components) no aplica a la marca nueva de Angular Material y no
// hay evidencia de como se ve una tarjeta fallida ahora. Se deja sin
// detectar a proposito: una generacion que en verdad falla simplemente
// nunca aparece con data-media-id y cae en el mismo timeout que cualquier
// pendiente que tarda de mas (mas lento, pero no incorrecto). Si se
// encuentra el marcado real de fallo, se puede reincorporar aqui.
function esIdDeVideo(id: string): boolean {
  // Los ids de video son la URL de la miniatura; los de imagen, un uuid.
  return id.startsWith('http');
}

function getTileState(id: string): TileState {
  if (esIdDeVideo(id)) {
    // El tile de video ya existe con su miniatura cargada: eso alcanza para
    // darlo por listo. Su URL real se resuelve aparte, con hover, porque el
    // <video> no existe en el DOM hasta ese momento (ver resolverUrlDeVideo).
    const existe = getVideoThumbnailUrls().includes(id);
    return existe
      ? { status: TileStatuses.Ready, isVideo: true, url: id }
      : { status: TileStatuses.Pending };
  }

  const media = document.querySelector<HTMLImageElement | HTMLVideoElement>(
    `[data-media-id="${CSS.escape(id)}"]`
  );
  if (!media) return { status: TileStatuses.Pending };

  const img = media as HTMLImageElement;
  if (!img.complete || img.naturalWidth === 0 || !img.src) return { status: TileStatuses.Pending };
  return { status: TileStatuses.Ready, isVideo: false, url: img.src };
}

// Converts a blob: URL to a data URL so the extension popup can fetch it
// cross-origin (blob URLs are bound to the originating context).
export async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  const res = await fetch(blobUrl);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Batch waiting ──────────────────────────────────────────────────────────────

export const MediaPollStatuses = {
  Success: 'success',
  NoSuccess: 'no-success',
  Aborted: 'aborted',
} as const;

export type MediaPollResult =
  | { status: typeof MediaPollStatuses.Success; urls: string[] }
  | { status: typeof MediaPollStatuses.NoSuccess }
  | { status: typeof MediaPollStatuses.Aborted };

// Diffs the current tile ids against beforeIds to find this generation's
// results, and waits for every one of them to settle (ready or failed —
// none still pending). New ids can keep appearing over time (Google Flow
// sometimes delivers variants in separate batches), so once nothing's
// pending, the id count must also hold steady for MEDIA_STABILIZE_MS before
// calling it done — otherwise a variant whose wrapper hasn't even mounted
// yet gets abandoned.
export async function waitForNewMedia(
  beforeIds: Set<string>,
  mode: BatchMode = BatchModes.Image
): Promise<MediaPollResult> {
  const isVideo = mode === BatchModes.Video;
  const maxAttempts = isVideo ? VIDEO_MEDIA_POLL_MAX_ATTEMPTS : IMAGE_MEDIA_POLL_MAX_ATTEMPTS;

  let lastCount = 0;
  let stableSince: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    const newIds = [...getAllTileIds()].filter((id) => !beforeIds.has(id));
    const states = newIds.map((id) => getTileState(id));
    const stillPending = states.some((s) => s.status === TileStatuses.Pending);
    const readyUrls = states.flatMap((s) =>
      s.status === TileStatuses.Ready && s.isVideo === isVideo ? [s.url] : []
    );

    if (newIds.length !== lastCount) {
      // El conteo de ids nuevos cambió (llegó otro wrapper): reinicia la
      // ventana de estabilización.
      lastCount = newIds.length;
      stableSince = Date.now();
    }

    const reachedMax = newIds.length >= MAX_MEDIA_PER_BATCH;
    const isStable = stableSince !== null && Date.now() - stableSince >= MEDIA_STABILIZE_MS;

    if (!stillPending && (reachedMax || isStable)) {
      const urls = await resolverUrls(readyUrls, isVideo);
      return urls.length > 0
        ? { status: MediaPollStatuses.Success, urls }
        : { status: MediaPollStatuses.NoSuccess };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  // Timed out — whatever's ready counts as a partial success, same as
  // vibes.ai: at least 1 ready slot is enough, the rest are simply skipped.
  const finalIds = [...getAllTileIds()]
    .filter((id) => !beforeIds.has(id))
    .map((id) => getTileState(id))
    .flatMap((s) => (s.status === TileStatuses.Ready && s.isVideo === isVideo ? [s.url] : []));

  const finalUrls = await resolverUrls(finalIds, isVideo);
  return finalUrls.length > 0
    ? { status: MediaPollStatuses.Success, urls: finalUrls }
    : { status: MediaPollStatuses.NoSuccess };
}

// En modo video, lo que se junto hasta aca son URLs de MINIATURA: hay que
// pasar el mouse por cada tile para que Flow cargue su <video> y recien ahi
// se puede leer la URL real que se va a descargar. En modo imagen ya son
// las URLs finales y no hay nada que resolver.
async function resolverUrls(urls: string[], isVideo: boolean): Promise<string[]> {
  if (!isVideo) return urls;
  const resueltas: string[] = [];
  for (const thumbnailUrl of urls) {
    if (aborted) break;
    const real = await resolverUrlDeVideo(thumbnailUrl);
    if (real) resueltas.push(real);
  }
  return resueltas;
}
