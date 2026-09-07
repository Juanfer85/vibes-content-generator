import { Actions, LogKinds, LogLevels } from '../../lib/types';
import { log } from './log';
import { aborted } from './abortState';
import {
  sleepAbortable,
  waitFor,
  nativeClick,
  nativeHover,
  nativeHoverClick,
} from './domUtils';
import {
  UPLOAD_WAIT_TIMEOUT_MS,
  MAX_UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_DELAY_MS,
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

// El botón "Iniciar"/"Finalizar" comparte la misma clase; se filtra por
// texto. Ya paso de "Inicial" a "Inicio" y ahora, VERIFICADO EN VIVO el
// 2026-09-07, de "Inicio" a "Iniciar" (con espacios alrededor en el
// textContent real, de ahi el trim()). Cada cambio de texto sin arreglar
// aca hace que isStartFrameAttached() de siempre `true` (nunca encuentra
// el boton "vacio"), lo que dispara en cascada el intento de "quitar el
// frame de la escena anterior" en TODAS las escenas del lote, aunque no
// haya nada realmente adjunto.
function findInitialFrameTrigger(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button.empty-chip')).find(
      (b) => b.textContent?.trim() === 'Iniciar'
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

// Quita la imagen ya adjunta. VERIFICADO EN VIVO el 2026-09-06: el chip es
// un `button.chip-container` con un <mat-icon>cancel</mat-icon> adentro;
// clickear ese icono lo quita y "Inicio" vuelve a aparecer como
// empty-chip.
async function detachStartFrame(): Promise<void> {
  const chip = document.querySelector<HTMLElement>('button.chip-container');
  const cancel = chip
    ? Array.from(chip.querySelectorAll<HTMLElement>('mat-icon')).find(
        (i) => i.textContent?.trim() === 'cancel'
      )
    : null;
  if (!cancel) return;
  await nativeClick(cancel);
  await waitFor(() => (isStartFrameAttached() ? null : true), 4000);
}

// Match por SUBSTRING del aria-label, no texto exacto: Flow ya le cambio la
// redaccion una vez sin avisar (de "Menu para anadir contenido multimedia" a
// "Agregar menu de contenido multimedia", verificado en vivo el 2026-09-07).
// "contenido multimedia" es la parte que sobrevivio a ese cambio -- con
// texto exacto, cualquier reordenamiento futuro de palabras vuelve a romper
// esto en cascada, igual que paso con "Inicio" -> "Iniciar".
function findAddMediaMenuButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'button[aria-label*="contenido multimedia"]'
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

// Ids de las imagenes que hay ahora mismo en la galeria del proyecto. Se
// usa para descubrir CUAL tile es el de la imagen recien subida: la nueva
// es, por definicion, el id que antes no estaba. Mucho mas confiable que
// buscarla por nombre (los titulos se truncan en pantalla).
function getImageMediaIds(): Set<string> {
  const ids = new Set<string>();
  document
    .querySelectorAll<HTMLElement>('flow-image-tile img[data-media-id]')
    .forEach((img) => {
      const id = img.getAttribute('data-media-id');
      if (id) ids.add(id);
    });
  return ids;
}

function findTileByMediaId(id: string): HTMLElement | null {
  const img = document.querySelector<HTMLElement>(`img[data-media-id="${CSS.escape(id)}"]`);
  return img?.closest<HTMLElement>('flow-tile-container') ?? null;
}

// Camino corto, confirmado en vivo el 2026-09-06: cada imagen de la
// galeria tiene un menu ⋮ con la opcion "Animar", que la pone sola como
// fotograma inicial. Reemplaza todo el rodeo anterior (abrir el panel
// "Selecciona una imagen de encuadre", buscarla en la lista, seleccionarla
// y confirmar), que era donde la imagen se perdia una y otra vez.
async function animarDesdeLaGaleria(tile: HTMLElement): Promise<boolean> {
  // Primer hover: hace que Flow renderice los controles del recuadro, para
  // poder leer la posicion real del ⋮.
  await nativeHover(tile);

  const menuBtn = await waitFor(
    () =>
      Array.from(tile.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.querySelector('mat-icon')?.textContent?.trim() === 'more_vert'
      ) ?? null,
    4000
  );
  if (!menuBtn) return false;

  // Hover + clic juntos: si van por separado, al soltar el depurador se
  // pierde el "mouse encima", el ⋮ se oculta y el clic cae sobre la imagen,
  // abriendola en el editor en vez de abrir el menu (visto en vivo).
  await nativeHoverClick(tile, menuBtn);

  const animar = await waitFor(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((i) =>
        hasText(i, 'Animar')
      ) ?? null,
    4000
  );
  if (!animar) return false;
  await nativeClick(animar);

  return !!(await waitFor(() => (isStartFrameAttached() ? true : null), 8000));
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

async function attemptUpload(
  imageBase64: string,
  imageName: string
): Promise<Attempt> {
  // Paso 1: subir el archivo a la biblioteca del proyecto.
  const idsAntes = getImageMediaIds();

  const addMediaBtn = findAddMediaMenuButton();
  if (!addMediaBtn) return failed('No se encontró el botón "+" del proyecto');
  await nativeClick(addMediaBtn);

  const uploadItem = await waitFor(() => findUploadMenuItem(), 4000);
  if (aborted) return ok(UploadResults.Aborted);
  if (!uploadItem) return failed('No se encontró "Subir" en el menú "+"');

  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const subido = await uploadViaNativeChannel(uploadItem, imageBase64, uploadName);
  if (aborted) return ok(UploadResults.Aborted);
  if (!subido) return failed('Falló la subida nativa (chrome.debugger)');

  // Paso 2: esperar a que la imagen aparezca en la galeria. DOM.setFileInputFiles
  // solo confirma que Chrome puso el archivo en el input -- no que Flow ya lo
  // haya leido y subido a su backend. Se espera al tile nuevo en vez de a un
  // tiempo fijo: el id que antes no estaba es, por definicion, el de esta
  // imagen (mas confiable que buscarla por nombre, que se trunca en pantalla).
  const idNuevo = await waitFor(() => {
    const nuevos = [...getImageMediaIds()].filter((id) => !idsAntes.has(id));
    return nuevos[0] ?? null;
  }, UPLOAD_WAIT_TIMEOUT_MS);
  if (aborted) return ok(UploadResults.Aborted);
  if (!idNuevo) return failed('La imagen subida no apareció en la galería');

  const tile = findTileByMediaId(idNuevo);
  if (!tile) return failed('No se encontró el recuadro de la imagen subida');

  // Paso 3: "Animar" desde el menu ⋮ del propio tile. Pone la imagen sola
  // como fotograma inicial, sin pasar por el panel de seleccion.
  const animado = await animarDesdeLaGaleria(tile);
  if (aborted) return ok(UploadResults.Aborted);
  if (!animado) return failed('No se pudo usar "Animar" sobre la imagen subida');

  return ok(UploadResults.Success);
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

// De que escena es la imagen que esta adjunta ahora mismo. Sin esto, el
// atajo "ya hay algo adjunto -> listo" haria que la escena 5 animara la
// imagen de la escena 3: cada escena tiene SU imagen, y adjuntar la
// equivocada es justo el error que se ve como "anima otra cosa".
let escenaDelFrameAdjunto: number | null = null;

// Se llama antes de CADA intento de generacion, no solo del primero: un
// intento fallido puede dejar el composer reseteado y sin la imagen, asi
// que hay que revisarlo (y volver a subirla si desaparecio) antes de cada
// reenvio, o se mandaria el prompt sin imagen de referencia.
export async function attachStartFrame(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<boolean> {
  if (isStartFrameAttached()) {
    // Reintento de la MISMA escena: la imagen que ya esta puesta sirve.
    if (escenaDelFrameAdjunto === sceneNumber) return true;
    // Sobro de una escena anterior: hay que sacarla antes de poner la que
    // corresponde, o esta escena se animaria con la imagen equivocada.
    await detachStartFrame();
    escenaDelFrameAdjunto = null;
    if (isStartFrameAttached()) {
      log({
        sceneNumber,
        step: 'No se pudo quitar el start frame de la escena anterior',
        kind: LogKinds.Error,
        level: LogLevels.Step,
      });
      return false;
    }
  }

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

  escenaDelFrameAdjunto = sceneNumber;
  log({ sceneNumber, step: 'Start frame subido', kind: LogKinds.Success, level: LogLevels.Step });
  return true;
}
