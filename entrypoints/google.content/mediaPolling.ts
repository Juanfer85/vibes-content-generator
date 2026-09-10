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

// VERIFICADO EN VIVO el 2026-09-06: la galeria usa scroll virtual (Angular
// CDK) -- las miniaturas viejas se DESMONTAN del DOM cuando quedan fuera de
// la ventana renderizada, y se pueden volver a MONTAR despues si el layout
// se reacomoda. Comparar "que hay ahora" contra un Set de "que habia antes"
// (como se hace mas abajo para imagenes, con data-media-id) es fragil para
// video: si una miniatura VIEJA que no estaba montada cuando se capturo
// `beforeIds` se vuelve a montar mientras se espera, el diff la confunde
// con LA NUEVA de verdad. Esto fue la causa real de los videos duplicados
// del 2026-09-06 (varias escenas seguidas terminaron con el video de una
// escena anterior, reaparecida por el scroll virtual).
//
// La salida: Flow ordena "Recientes" primero, asi que el video nuevo
// SIEMPRE aparece en la POSICION 0 de la lista -- la unica posicion
// garantizada de estar siempre montada, sin importar el scroll virtual. Se
// espera a que esa posicion cambie de valor Y se mantenga estable unos
// segundos (Flow puede mostrar un resultado parcial antes del definitivo).
//
// Asume "x1" (una sola salida por envio), que es la configuracion en uso
// actualmente. Con "Numero de salidas" en x2 o mas, esto solo capturaria
// UNA de las variantes -- si algun dia se usa asi, hay que revisar esto.
//
// SEGUNDA BARRERA (2026-09-10): el chequeo de posicion 0 solo no alcanza.
// Verificado en vivo sobre idea_000024: las escenas 3 y 5 de un lote de 12
// terminaron con el MISMO video (byte a byte), con la escena 4 -- en el
// medio -- perfectamente distinta. Eso descarta la reaparicion en el vecino
// inmediato; lo que explica el patron es que el thumbnail de la escena 3
// volvio a aparecer en la posicion 0 momentaneamente mientras se esperaba la
// escena 5 (el mismo reacomodo del scroll virtual que motivo el fix
// original, solo que dos escenas mas tarde). Flow nunca reutiliza la url de
// un video real para una generacion nueva, asi que un thumbnail que ya se le
// asigno a OTRA escena de esta misma sesion de pagina no puede ser de
// verdad "nuevo": se descarta y se sigue esperando, en vez de aceptarlo.
const thumbnailsYaUsados = new Set<string>();

async function waitForTopVideoChange(urlAntes: string | null): Promise<string | null> {
  let ultimoTop: string | null = null;
  let estableDesde: number | null = null;

  for (let intento = 0; intento < VIDEO_MEDIA_POLL_MAX_ATTEMPTS; intento++) {
    if (aborted) return null;

    const topActual = getVideoThumbnailUrls()[0] ?? null;
    const esNuevo =
      topActual !== null && topActual !== urlAntes && !thumbnailsYaUsados.has(topActual);

    if (esNuevo) {
      if (topActual !== ultimoTop) {
        ultimoTop = topActual;
        estableDesde = Date.now();
      } else if (estableDesde !== null && Date.now() - estableDesde >= MEDIA_STABILIZE_MS) {
        thumbnailsYaUsados.add(topActual);
        return topActual;
      }
    } else {
      ultimoTop = null;
      estableDesde = null;
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
  if (ultimoTop) thumbnailsYaUsados.add(ultimoTop);
  return ultimoTop; // lo mejor que se vio, aunque no llegara a estabilizar
}

// Diffs the current tile ids against beforeIds to find this generation's
// results, and waits for every one of them to settle (ready or failed —
// none still pending). New ids can keep appearing over time (Google Flow
// sometimes delivers variants in separate batches), so once nothing's
// pending, the id count must also hold steady for MEDIA_STABILIZE_MS before
// calling it done — otherwise a variant whose wrapper hasn't even mounted
// yet gets abandoned.
//
// Los VIDEOS usan un camino aparte (waitForTopVideoChange, arriba) en vez
// de este diff por conjunto: ver el comentario de esa funcion para el
// motivo. `beforeIds` se ignora para video a proposito.
export async function waitForNewMedia(
  beforeIds: Set<string>,
  mode: BatchMode = BatchModes.Image
): Promise<MediaPollResult> {
  const isVideo = mode === BatchModes.Video;

  if (isVideo) {
    const topAntes = getVideoThumbnailUrls()[0] ?? null;
    const nuevaThumb = await waitForTopVideoChange(topAntes);
    if (aborted) return { status: MediaPollStatuses.Aborted };
    if (!nuevaThumb) return { status: MediaPollStatuses.NoSuccess };
    const real = await resolverUrlDeVideo(nuevaThumb);
    return real
      ? { status: MediaPollStatuses.Success, urls: [real] }
      : { status: MediaPollStatuses.NoSuccess };
  }

  // De aca para abajo, solo modo imagen (el video ya salio por su propio
  // camino arriba). Se sigue filtrando por "no es id de video" por las
  // dudas, aunque en la practica los ids de video no deberian mezclarse
  // aca -- no cuesta nada la guardia.
  let lastCount = 0;
  let stableSince: number | null = null;

  for (let attempt = 0; attempt < IMAGE_MEDIA_POLL_MAX_ATTEMPTS; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    const newIds = [...getAllTileIds()]
      .filter((id) => !beforeIds.has(id))
      .filter((id) => !esIdDeVideo(id));
    const states = newIds.map((id) => getTileState(id));
    const stillPending = states.some((s) => s.status === TileStatuses.Pending);
    const readyUrls = states.flatMap((s) => (s.status === TileStatuses.Ready ? [s.url] : []));

    if (newIds.length !== lastCount) {
      // El conteo de ids nuevos cambió (llegó otro wrapper): reinicia la
      // ventana de estabilización.
      lastCount = newIds.length;
      stableSince = Date.now();
    }

    const reachedMax = newIds.length >= MAX_MEDIA_PER_BATCH;
    const isStable = stableSince !== null && Date.now() - stableSince >= MEDIA_STABILIZE_MS;

    if (!stillPending && (reachedMax || isStable)) {
      return readyUrls.length > 0
        ? { status: MediaPollStatuses.Success, urls: readyUrls }
        : { status: MediaPollStatuses.NoSuccess };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  // Timed out — whatever's ready counts as a partial success, same as
  // vibes.ai: at least 1 ready slot is enough, the rest are simply skipped.
  const finalUrls = [...getAllTileIds()]
    .filter((id) => !beforeIds.has(id))
    .filter((id) => !esIdDeVideo(id))
    .map((id) => getTileState(id))
    .flatMap((s) => (s.status === TileStatuses.Ready ? [s.url] : []));

  return finalUrls.length > 0
    ? { status: MediaPollStatuses.Success, urls: finalUrls }
    : { status: MediaPollStatuses.NoSuccess };
}
