import { Actions, LogKinds, LogLevels, BatchModes, type BatchMode } from '../../lib/types';
import { GallerySelectors } from '../../lib/selectors/vibes';
import {
  MEDIA_POLL_INTERVAL_MS,
  BATCH_ID_CAPTURE_TIMEOUT_MS,
  MAX_GENERATION_ATTEMPTS,
  GENERATION_RETRY_DELAY_MS,
  READY_VIDEO_URL_PATTERN,
  GALLERY_NUDGE_AFTER_MS,
  GALLERY_NUDGE_EVERY_MS,
  GALLERY_NUDGE_MAX,
} from './constants';
import { aborted } from './abortState';
import { sleep, sleepAbortable, simulateClick } from './domUtils';
import { log } from './log';
import { takeAttemptFailure } from './attemptFailure';

// ── Gallery reading ────────────────────────────────────────────────────────────

// Every card currently in the DOM, regardless of state (ready/pending/failed)
// — the baseline used to recognize which mediaId is new once a fresh
// generation starts.
function getAllMediaIds(): Set<string> {
  const ids = new Set<string>();
  document.querySelectorAll<HTMLElement>(GallerySelectors.Thumbnail).forEach((card) => {
    const id = card.getAttribute('data-analytics-media-id');
    if (id) ids.add(id);
  });
  return ids;
}

function findNewMediaId(knownMediaIds: Set<string>): string | null {
  const cards = document.querySelectorAll<HTMLElement>(GallerySelectors.Thumbnail);
  for (const card of Array.from(cards)) {
    const id = card.getAttribute('data-analytics-media-id');
    if (id && !knownMediaIds.has(id)) return id;
  }
  return null;
}

const SlotStatuses = {
  Ready: 'ready',
  Failed: 'failed',
  Pending: 'pending',
} as const;

type SlotState =
  | { status: typeof SlotStatuses.Ready; url: string }
  | { status: typeof SlotStatuses.Failed }
  | { status: typeof SlotStatuses.Pending };

// Diagnostico (2026-09-18): cuando un batch de video termina con espacios
// sin resolver, no hay forma de saber desde afuera POR QUE. El usuario ve
// tarjetas en blanco que solo se pintan si abre una y vuelve -- la extension
// las da por pendientes porque `getSlotState` exige que el id aparezca mas de
// una vez, y una tarjeta sin pintar no lo cumple. Esto anota que hay de
// verdad en la pagina para cada espacio, sin cambiar el comportamiento.
function describeSlot(mediaId: string) {
  const escapedId = CSS.escape(mediaId);
  const repeats = document.querySelectorAll(`[data-analytics-media-id="${escapedId}"]`).length;
  const card = document.querySelector<HTMLElement>(
    `${GallerySelectors.Thumbnail}[data-analytics-media-id="${escapedId}"]`
  );
  if (!card) return { mediaId, repeats, card: false };
  const video = card.querySelector<HTMLVideoElement>('video');
  return {
    mediaId,
    repeats,
    card: true,
    canvas: !!card.querySelector('canvas'),
    img: !!card.querySelector('img'),
    video: !!video,
    videoSrc: video?.getAttribute('src')?.slice(0, 90) ?? null,
    readyState: video?.readyState ?? null,
    alto: Math.round(card.getBoundingClientRect().height),
    texto: (card.textContent ?? '').trim().slice(0, 40),
  };
}

// A slot's mediaId is stamped on more than one element once it's ready —
// vibes.ai adds hover-action buttons (favorite, delete) carrying the same
// id once the real image/video replaces the <canvas> loading skeleton, so
// that's the "ready" signal instead of img.complete timing. Anything that
// isn't ready and isn't an explicit "Couldn't generate" card is still
// mid-generation.
function getSlotState(mediaId: string, mode: BatchMode): SlotState {
  const escapedId = CSS.escape(mediaId);
  const repeats = document.querySelectorAll(`[data-analytics-media-id="${escapedId}"]`).length;
  const card = document.querySelector<HTMLElement>(
    `${GallerySelectors.Thumbnail}[data-analytics-media-id="${escapedId}"]`
  );

  if (repeats > 1 && card) {
    // Which element actually holds the real content depends on the mode —
    // a video card's thumbnail <img> can be a generic loading placeholder
    // (same src across every card in the batch) that's "complete" long
    // before the real <video> mounts, so it must never stand in for one.
    let url: string | false = false;
    if (mode === BatchModes.Image) {
      const img = card.querySelector<HTMLImageElement>('img[data-nimg="fill"]');
      url = !!img && img.complete && img.naturalWidth > 0 && img.src;
    } else {
      const video = card.querySelector<HTMLVideoElement>('video[src]');
      // El src final de fbcdn ES la prueba de que el archivo existe:
      // vibes.ai no lo asigna mientras el video se genera (hasta entonces
      // la tarjeta lleva un <canvas> de esqueleto).
      //
      // Ya NO se mira `readyState` (2026-09-17). Sube de 0 solo cuando el
      // navegador descarga datos de verdad, y la galeria monta sus <video>
      // sin cargarlos mientras estan fuera de foco. Resultado: el batch se
      // quedaba en Pending hasta agotar el tiempo aunque los 4 clips ya
      // estuvieran listos, y solo se desbloqueaba si alguien abria un clip
      // a mano y volvia -- eso era lo que forzaba la descarga.
      const videoReady = !!video && READY_VIDEO_URL_PATTERN.test(video.src);
      if (videoReady && video.readyState === HTMLMediaElement.HAVE_NOTHING) {
        // Empuja la carga para que los clips se vean en la galeria sin que
        // el usuario tenga que abrir uno. No condiciona el resultado.
        video.preload = 'metadata';
        video.load();
      }
      url = videoReady && video.src;
    }
    if (url) return { status: SlotStatuses.Ready, url };
  }

  if (card) {
    const failed = Array.from(card.querySelectorAll<HTMLElement>('span')).some(
      (el) => el.textContent?.trim() === "Couldn't generate"
    );
    if (failed) return { status: SlotStatuses.Failed };
  }

  return { status: SlotStatuses.Pending };
}

// Hace lo mismo que el usuario a mano: abrir una tarjeta y volver, para que
// vibes.ai redibuje la galeria. Sin selectores del boton "volver" (no los
// conocemos): se usa el historial del navegador, protegido para no sacar al
// usuario del proyecto. Solo vuelve atras si el clic realmente cambio la URL;
// si no cambio (p. ej. un panel superpuesto) cierra con Escape, y si despues de
// volver la URL no coincide con la de partida, lo deja anotado y no toca mas.
async function nudgeGallery(preferredMediaId: string): Promise<void> {
  const escaped = CSS.escape(preferredMediaId);
  const card =
    document.querySelector<HTMLElement>(
      `${GallerySelectors.Thumbnail}[data-analytics-media-id="${escaped}"]`
    ) ?? document.querySelector<HTMLElement>(GallerySelectors.Thumbnail);
  if (!card) {
    console.warn('[nudgeGallery] no hay ninguna tarjeta que abrir');
    return;
  }

  const urlAntes = location.href;
  await simulateClick(card);
  if (aborted) return;

  if (location.href !== urlAntes) {
    history.back();
    await sleep(2000);
    console.warn('[nudgeGallery] abrio y volvio', {
      urlAntes,
      urlDespues: location.href,
      coincide: location.href === urlAntes,
    });
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(1000);
    console.warn('[nudgeGallery] el clic no cambio la URL, se cerro con Escape', { urlAntes });
  }
}

// ── Batch waiting ──────────────────────────────────────────────────────────────

const BatchResults = {
  Success: 'success',
  NoSuccess: 'no-success',
  Aborted: 'aborted',
} as const;

type BatchResult =
  | { status: typeof BatchResults.Success; urls: string[] }
  | { status: typeof BatchResults.NoSuccess }
  | { status: typeof BatchResults.Aborted };

async function waitForBatch(
  mode: BatchMode,
  knownMediaIds: Set<string>,
  settleTimeoutMs: number
): Promise<BatchResult> {
  // Phase 1: capture this generation's batch id — the first fresh mediaId to
  // appear (any state) tells us which batch to track, since generation runs
  // strictly one batch at a time, never in parallel.
  let batchId: string | null = null;
  const captureDeadline = Date.now() + BATCH_ID_CAPTURE_TIMEOUT_MS;
  while (!batchId) {
    if (aborted) return { status: BatchResults.Aborted };

    const newId = findNewMediaId(knownMediaIds);
    if (newId) {
      batchId = newId.split('-content-')[0];
      break;
    }
    if (Date.now() > captureDeadline) return { status: BatchResults.NoSuccess };

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  // Phase 2: poll the batch's up to 4 slots until either every one of them
  // has settled (ready or failed — none still pending) or the settle window
  // runs out, whichever comes first.
  const slotIds = [0, 1, 2, 3].map((n) => `${batchId}-content-${n}`);
  const deadline = Date.now() + settleTimeoutMs;
  let nudges = 0;

  while (true) {
    if (aborted) return { status: BatchResults.Aborted };

    const states = slotIds.map((id) => getSlotState(id, mode));
    const stillPending = states.some((s) => s.status === SlotStatuses.Pending);
    const readyUrls = states.flatMap((s) => (s.status === SlotStatuses.Ready ? [s.url] : []));

    // Solo video, que es donde se documento el fallo de repintado.
    const elapsedMs = Date.now() - (deadline - settleTimeoutMs);
    if (
      mode === BatchModes.Video &&
      stillPending &&
      nudges < GALLERY_NUDGE_MAX &&
      elapsedMs >= GALLERY_NUDGE_AFTER_MS + nudges * GALLERY_NUDGE_EVERY_MS &&
      Date.now() < deadline
    ) {
      nudges++;
      console.warn('[waitForBatch] refrescando la galeria', { intento: nudges, elapsedMs });
      await nudgeGallery(slotIds[0]);
      continue;
    }

    if (!stillPending || Date.now() >= deadline) {
      // Diagnostico (2026-09-14): sin esto, un "NoSuccess" no dice si el
      // batch de verdad fallo (4 slots Failed) o si simplemente se agoto el
      // tiempo con slots todavia Pending -- que es indistinguible desde
      // afuera de "sigue generando en bucle" pero tiene una causa y un fix
      // muy distintos (ver el comentario de IMAGE_BATCH_SETTLE_TIMEOUT_MS).
      if (states.some((st) => st.status !== SlotStatuses.Ready)) {
        console.warn('[waitForBatch] espacios sin resolver', {
          batchId,
          modo: mode,
          listos: readyUrls.length,
          detalle: slotIds
            .map((id, i) => ({ estado: states[i].status, ...describeSlot(id) }))
            .filter((d) => d.estado !== SlotStatuses.Ready),
        });
      }
      if (readyUrls.length === 0) {
        console.warn('[waitForBatch] NoSuccess', {
          batchId,
          settleTimeoutMs,
          elapsedMs: Date.now() - (deadline - settleTimeoutMs),
          estados: states.map((s) => s.status),
        });
      }
      return readyUrls.length > 0
        ? { status: BatchResults.Success, urls: readyUrls }
        : { status: BatchResults.NoSuccess };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
}

// ── Failure reporting ────────────────────────────────────────────────────────

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

// ── Retry loop ─────────────────────────────────────────────────────────────────

// Owns the whole fill+click→wait cycle, attempt 1 included — a failed first
// attempt is just attempt 1 of the same loop, not a special dead-end case. A
// batch counts as successful once at least 1 of its up to 4 slots is ready —
// the rest are simply skipped, not treated as a reason to retry.
export async function generateWithRetries(
  sceneNumber: number,
  mode: BatchMode,
  generateAttempt: () => Promise<boolean>,
  retryAfterMs: number,
  settleTimeoutMs: number
) {
  let seenMediaIds = getAllMediaIds();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    if (attempt > 1) {
      log({
        sceneNumber,
        step: 'Reintentando generación',
        kind: LogKinds.Retry,
        level: LogLevels.Step,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
        cooldownMs: GENERATION_RETRY_DELAY_MS,
      });
      await sleepAbortable(GENERATION_RETRY_DELAY_MS);
      if (aborted) return;
    }

    const attempted = await generateAttempt();
    if (!attempted) {
      await reportSceneFailed(
        sceneNumber,
        takeAttemptFailure() ?? 'Botón Generate no disponible.',
        retryAfterMs
      );
      return;
    }

    log({
      sceneNumber,
      step: 'Esperando generación',
      kind: LogKinds.Info,
      level: LogLevels.Step,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: BATCH_ID_CAPTURE_TIMEOUT_MS + settleTimeoutMs,
    });

    const result = await waitForBatch(mode, seenMediaIds, settleTimeoutMs);

    switch (result.status) {
      case BatchResults.Aborted:
        return;

      case BatchResults.Success:
        log({
          sceneNumber,
          step: `${result.urls.length} archivo(s) listo(s), descargando`,
          kind: LogKinds.Success,
          level: LogLevels.Step,
        });
        await browser.runtime.sendMessage({
          action: Actions.DownloadMediaDirect,
          urls: result.urls,
          sceneNumber,
        });
        return;

      case BatchResults.NoSuccess:
        seenMediaIds = getAllMediaIds();
        if (attempt >= MAX_GENERATION_ATTEMPTS) {
          log({
            sceneNumber,
            step: 'Generación falló tras todos los intentos',
            kind: LogKinds.Error,
            level: LogLevels.Step,
          });
          await reportSceneFailed(
            sceneNumber,
            'Generación falló tras todos los intentos.',
            retryAfterMs
          );
          return;
        }
        break;
    }
  }
}
