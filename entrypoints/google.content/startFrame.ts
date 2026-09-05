import { Actions, LogKinds, LogLevels } from '../../lib/types';
import { log } from './log';
import { aborted } from './abortState';
import { sleepAbortable, waitFor, nativeClick } from './domUtils';
import {
  UPLOAD_WAIT_TIMEOUT_MS,
  MAX_UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_DELAY_MS,
  MAX_CONFIRM_ATTEMPTS,
  CONFIRM_CLOSE_TIMEOUT_MS,
} from './constants';

// El rediseno de flow.google.com (2026-09) cambio el flujo entero de
// adjuntar un start frame. Antes, abrir "Inicio" abria un panel que TENIA
// adentro un boton de subir archivos, con un <input type="file"> oculto y
// persistente al que se le podia inyectar el archivo directo. Ahora son
// DOS pasos separados, confirmados en vivo el 2026-09-05:
//
//   1. El menu "+" del proyecto ("Menu para anadir contenido multimedia",
//      arriba de la lista de medios) -> "Subir". Esto sube el archivo a la
//      biblioteca de medios del PROYECTO ENTERO, no a esta escena. Es acá
//      donde de verdad se abre el selector nativo del sistema operativo, y
//      no hay ningun input persistente al que inyectarle el archivo (ver
//      nativeUploadFile en el background).
//   2. RECIEN AHI "Inicio" abre "Selecciona una imagen de encuadre", un
//      panel que solo deja ELEGIR entre imagenes que ya estan en la
//      biblioteca del proyecto (generadas en Flow, o subidas en el paso
//      1) -- no tiene ninguna forma de subir un archivo nuevo desde aca.
//
// El nombre de archivo subido en el paso 1 sobrevive tal cual como titulo
// visible (`span.asset-title`) del resultado en el paso 2 -- a diferencia
// de las imagenes generadas en Flow, que llevan un titulo descriptivo
// generado por IA. Por eso se sube con un nombre unico (uuid + nombre
// original) y se busca ese mismo texto despues, en vez de tener que
// distinguir por contenido visual.

// El botón "Inicio"/"Fin" comparte la misma clase; se filtra por texto.
// Antes decia "Inicial"; el rediseno lo renombro a "Inicio".
function findInitialFrameTrigger(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button.empty-chip')).find(
      (b) => b.textContent?.trim() === 'Inicio'
    ) ?? null
  );
}

// NO VERIFICADO EN VIVO: no hay evidencia todavia de como se ve "Inicio"
// una vez que YA tiene una imagen adjunta bajo el rediseno nuevo, asi que
// esto probablemente siempre da false (el atributo data-card-open era de
// la version vieja). El efecto practico es que attachStartFrame() puede
// volver a subir y elegir la imagen aunque ya estuviera adjunta -- mas
// lento en un reintento, pero no incorrecto.
function isStartFrameAttached(): boolean {
  return !!document.querySelector('button[data-card-open]');
}

function findAddMediaMenuButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'button[aria-label="Menú para añadir contenido multimedia"]'
  );
}

function findUploadMenuItem(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (el) => el.textContent?.trim() === 'Subir'
    ) ?? null
  );
}

function isFramePickerOpen(): boolean {
  return Array.from(document.querySelectorAll('h2')).some(
    (h) => h.textContent?.trim() === 'Selecciona una imagen de encuadre'
  );
}

function findUploadedOption(uploadName: string): HTMLElement | null {
  const title = Array.from(document.querySelectorAll<HTMLElement>('.asset-title')).find(
    (span) => span.textContent?.trim() === uploadName
  );
  return title?.closest<HTMLElement>('button[role="option"]') ?? null;
}

function findAddToPromptButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Añadir a petición'
    ) ?? null
  );
}

function centerOf(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

// El clic que abre el selector de archivos va por un canal propio
// (NativeUploadFile), en la MISMA sesion de chrome.debugger que intercepta
// el dialogo -- no puede ser un nativeClick suelto de domUtils.ts, porque
// la intercepcion tiene que estar activa ANTES de que el clic dispare el
// dialogo nativo.
async function uploadViaNativeChannel(
  uploadButton: HTMLElement,
  imageBase64: string,
  uploadName: string
): Promise<boolean> {
  const { x, y } = centerOf(uploadButton);
  const respuesta = await browser.runtime.sendMessage({
    action: Actions.NativeUploadFile,
    imageBase64,
    uploadName,
    x,
    y,
  });
  return !!respuesta?.ok;
}

const UploadResults = {
  Success: 'success',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

type UploadResult = (typeof UploadResults)[keyof typeof UploadResults];

async function confirmSelection(): Promise<UploadResult> {
  for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
    const confirmBtn = await waitFor(() => findAddToPromptButton());
    if (aborted) return UploadResults.Aborted;
    if (!confirmBtn) return UploadResults.Failed;
    await nativeClick(confirmBtn);

    const closed = await waitFor(
      () => (isFramePickerOpen() ? null : true),
      CONFIRM_CLOSE_TIMEOUT_MS
    );
    if (aborted) return UploadResults.Aborted;
    if (closed) return UploadResults.Success;
  }
  return UploadResults.Failed;
}

async function attemptUpload(imageBase64: string, imageName: string): Promise<UploadResult> {
  // Paso 1: subir el archivo a la biblioteca del proyecto.
  const addMediaBtn = findAddMediaMenuButton();
  if (!addMediaBtn) return UploadResults.Failed;
  await nativeClick(addMediaBtn);

  const uploadItem = await waitFor(() => findUploadMenuItem(), 4000);
  if (aborted) return UploadResults.Aborted;
  if (!uploadItem) return UploadResults.Failed;

  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const uploaded = await uploadViaNativeChannel(uploadItem, imageBase64, uploadName);
  if (aborted) return UploadResults.Aborted;
  if (!uploaded) return UploadResults.Failed;

  // Paso 2: abrir "Inicio" y elegir el archivo recien subido de la lista.
  const trigger = findInitialFrameTrigger();
  if (!trigger) return UploadResults.Failed;
  await nativeClick(trigger);

  const opened = await waitFor(
    () => (isFramePickerOpen() ? true : null),
    UPLOAD_WAIT_TIMEOUT_MS
  );
  if (aborted) return UploadResults.Aborted;
  if (!opened) return UploadResults.Failed;

  const option = await waitFor(() => findUploadedOption(uploadName), UPLOAD_WAIT_TIMEOUT_MS);
  if (aborted) return UploadResults.Aborted;
  if (!option) return UploadResults.Failed;
  await nativeClick(option);

  return confirmSelection();
}

async function uploadWithRetries(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<UploadResult> {
  let result: UploadResult = UploadResults.Failed;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (aborted) return UploadResults.Aborted;

    log({
      sceneNumber,
      step: 'Subiendo start frame',
      kind: LogKinds.Info,
      level: LogLevels.Detail,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_WAIT_TIMEOUT_MS,
    });
    result = await attemptUpload(imageBase64, imageName);

    switch (result) {
      case UploadResults.Success:
      case UploadResults.Aborted:
        return result;

      case UploadResults.Failed:
        if (attempt >= MAX_UPLOAD_ATTEMPTS) return result;
        break;
    }

    log({
      sceneNumber,
      step: 'Subida falló, reintentando',
      kind: LogKinds.Retry,
      level: LogLevels.Detail,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_RETRY_DELAY_MS,
    });
    // Un intento fallido puede dejar algun panel abierto colgado.
    document.body.click();
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);
  }
  return result;
}

// Idempotent — safe to call before every generation attempt, not just the
// first. A failed generation can reset the composer and drop the attached
// frame, so a retry needs it re-checked (and re-uploaded if it's gone)
// before resubmitting, or it'd send the prompt with no reference image.
export async function attachStartFrame(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<boolean> {
  if (isStartFrameAttached()) return true;

  log({ sceneNumber, step: 'Adjuntando start frame', kind: LogKinds.Info, level: LogLevels.Step });

  const result = await uploadWithRetries(imageBase64, imageName, sceneNumber);
  if (result !== UploadResults.Success) {
    log({
      sceneNumber,
      step: 'No se pudo adjuntar el start frame',
      kind: LogKinds.Error,
      level: LogLevels.Step,
    });
    return false;
  }

  log({ sceneNumber, step: 'Start frame subido', kind: LogKinds.Success, level: LogLevels.Step });
  return true;
}
