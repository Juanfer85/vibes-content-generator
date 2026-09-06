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

// VERIFICADO EN VIVO el 2026-09-06: al adjuntar una imagen, el
// `button.empty-chip` con texto "Inicio" DESAPARECE (queda solo el de
// "Fin") y en su lugar aparece un `button.chip-container` con la
// miniatura adentro. Su ausencia es entonces la señal de que ya hay algo
// adjunto. Antes esto miraba `button[data-card-open]`, atributo de la
// version vieja que ya no existe: daba siempre false, y por eso cada
// reintento volvia a subir un archivo nuevo (de ahi la pila de .jpg con
// nombre UUID acumulados en el proyecto).
function isStartFrameAttached(): boolean {
  return !findInitialFrameTrigger();
}

function findAddMediaMenuButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'button[aria-label="Menú para añadir contenido multimedia"]'
  );
}

// Comparacion por substring, no igualdad exacta: un boton/menuitem de
// Angular Material suele traer un <mat-icon> hermano cuyo texto de ligadura
// (ej. "upload") se concatena en el textContent junto con la etiqueta
// visible -- confirmado ya una vez con el boton de enviar ("arrow_forward" +
// "Enviar" pegados). La igualdad exacta se cae por eso, no porque el texto
// visible haya cambiado.
function hasText(el: Element, text: string): boolean {
  return !!el.textContent?.includes(text);
}

function findUploadMenuItem(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
      hasText(el, 'Subir')
    ) ?? null
  );
}

function isFramePickerOpen(): boolean {
  return Array.from(document.querySelectorAll('h2')).some((h) =>
    hasText(h, 'Selecciona una imagen de encuadre')
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
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      hasText(b, 'Añadir a petición')
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
//
// VERIFICADO EN VIVO el 2026-09-05: chrome.downloads.download() ignora el
// `uploadName` pedido y le pone al archivo su propio nombre (un data: URL
// termino en "descarga.jpg", un blob: URL en un UUID propio de Chrome) --
// asi que el nombre que Flow termina mostrando NO es `uploadName`, es el
// que devuelve el background como `realFileName`. Ese es el que hay que
// buscar despues en la lista, no el que se mando a pedir.
async function uploadViaNativeChannel(
  uploadButton: HTMLElement,
  imageBase64: string,
  uploadName: string
): Promise<string | null> {
  const { x, y } = centerOf(uploadButton);
  const respuesta = await browser.runtime.sendMessage({
    action: Actions.NativeUploadFile,
    imageBase64,
    uploadName,
    x,
    y,
  });
  if (!respuesta?.ok) return null;
  return (respuesta.realFileName as string | undefined) ?? uploadName;
}

const UploadResults = {
  Success: 'success',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

type UploadResult = (typeof UploadResults)[keyof typeof UploadResults];

// El resultado ahora viaja CON el motivo puntual del fallo (ver comentario
// mas abajo, en Attempt): un log aparte a nivel Detail queda pisado de
// inmediato por el "Subida fallo, reintentando" que loguea uploadWithRetries
// en ESE MISMO nivel -- batchStore.pushLog solo guarda el ultimo mensaje por
// nivel, no un historial. Por eso el motivo va DENTRO del unico mensaje de
// ese nivel, no en uno propio.
interface Attempt {
  result: UploadResult;
  reason?: string;
}

const ok = (result: UploadResult): Attempt => ({ result });
const failed = (reason: string): Attempt => ({ result: UploadResults.Failed, reason });

async function confirmSelection(): Promise<Attempt> {
  for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
    const confirmBtn = await waitFor(() => findAddToPromptButton());
    if (aborted) return ok(UploadResults.Aborted);
    if (!confirmBtn) return failed('No se encontró el botón "Añadir a petición"');
    await nativeClick(confirmBtn);

    const closed = await waitFor(
      () => (isFramePickerOpen() ? null : true),
      CONFIRM_CLOSE_TIMEOUT_MS
    );
    if (aborted) return ok(UploadResults.Aborted);
    if (closed) return ok(UploadResults.Success);
  }
  return failed('El panel no se cerró tras confirmar');
}

async function attemptUpload(
  imageBase64: string,
  imageName: string
): Promise<Attempt> {
  // Paso 1: subir el archivo a la biblioteca del proyecto.
  const addMediaBtn = findAddMediaMenuButton();
  if (!addMediaBtn) return failed('No se encontró el botón "+" del proyecto');
  await nativeClick(addMediaBtn);

  const uploadItem = await waitFor(() => findUploadMenuItem(), 4000);
  if (aborted) return ok(UploadResults.Aborted);
  if (!uploadItem) return failed('No se encontró "Subir" en el menú "+"');

  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const realFileName = await uploadViaNativeChannel(uploadItem, imageBase64, uploadName);
  if (aborted) return ok(UploadResults.Aborted);
  if (!realFileName) return failed('Falló la subida nativa (chrome.debugger)');

  // DOM.setFileInputFiles solo confirma que Chrome puso el archivo en el
  // input -- no que Flow ya lo haya leido, empezado a subir a su backend y
  // agregado a la biblioteca del proyecto. Confirmado en vivo el
  // 2026-09-05: sin esta pausa, el archivo NUNCA llega a aparecer ni
  // siquiera en la pestaña "Subidas" de Flow (no es que la busqueda
  // posterior falle: la subida en si no llega a completarse), muy
  // probablemente porque abrir "Inicio" justo despues interrumpe el
  // procesamiento que Flow dispara al detectar el cambio en el input.
  await sleepAbortable(2000);
  if (aborted) return ok(UploadResults.Aborted);

  // Paso 2: abrir "Inicio" y elegir el archivo recien subido de la lista.
  const trigger = findInitialFrameTrigger();
  if (!trigger) return failed('No se encontró el botón "Inicio"');
  await nativeClick(trigger);

  const opened = await waitFor(
    () => (isFramePickerOpen() ? true : null),
    UPLOAD_WAIT_TIMEOUT_MS
  );
  if (aborted) return ok(UploadResults.Aborted);
  if (!opened) return failed('No se abrió "Selecciona una imagen de encuadre"');

  const option = await waitFor(() => findUploadedOption(realFileName), UPLOAD_WAIT_TIMEOUT_MS);
  if (aborted) return ok(UploadResults.Aborted);
  if (!option) return failed('La imagen subida no apareció en la lista');
  await nativeClick(option);

  return confirmSelection();
}

async function uploadWithRetries(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<Attempt> {
  let attempt: Attempt = { result: UploadResults.Failed };

  for (let intento = 1; intento <= MAX_UPLOAD_ATTEMPTS; intento++) {
    if (aborted) return ok(UploadResults.Aborted);

    log({
      sceneNumber,
      step: 'Subiendo start frame',
      kind: LogKinds.Info,
      level: LogLevels.Detail,
      attempt: { current: intento, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_WAIT_TIMEOUT_MS,
    });
    attempt = await attemptUpload(imageBase64, imageName);

    switch (attempt.result) {
      case UploadResults.Success:
      case UploadResults.Aborted:
        return attempt;

      case UploadResults.Failed:
        if (intento >= MAX_UPLOAD_ATTEMPTS) return attempt;
        break;
    }

    log({
      sceneNumber,
      step: attempt.reason ? `Subida falló: ${attempt.reason}` : 'Subida falló, reintentando',
      kind: LogKinds.Retry,
      level: LogLevels.Detail,
      attempt: { current: intento, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_RETRY_DELAY_MS,
    });
    // Un intento fallido puede dejar algun panel abierto colgado.
    document.body.click();
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);
  }
  return attempt;
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

  const attempt = await uploadWithRetries(imageBase64, imageName, sceneNumber);
  if (attempt.result !== UploadResults.Success) {
    log({
      sceneNumber,
      step: attempt.reason
        ? `No se pudo adjuntar el start frame: ${attempt.reason}`
        : 'No se pudo adjuntar el start frame',
      kind: LogKinds.Error,
      level: LogLevels.Step,
    });
    return false;
  }

  log({ sceneNumber, step: 'Start frame subido', kind: LogKinds.Success, level: LogLevels.Step });
  return true;
}
