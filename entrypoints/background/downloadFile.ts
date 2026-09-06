// Materializa una imagen (que la extension solo tiene en memoria, como
// data URL) en un archivo real y temporal en disco, usando chrome.downloads
// -- la unica API que le da a una extension una ruta absoluta de verdad,
// que es lo que pide DOM.setFileInputFiles (ver nativeUploadFile en
// nativeInput.ts). El archivo se borra despues de usarlo.
//
// VERIFICADO EN VIVO el 2026-09-05, DOS VECES: chrome.downloads.download()
// IGNORA el nombre de archivo pedido en el `filename`, tanto para un
// data: URL (termino en "descarga.jpg", el generico localizado de Chrome)
// como para un blob: URL creado en un offscreen document (termino en un
// UUID propio de Chrome, ej. "341bef5f-....jpg") -- no se pudo confirmar
// la causa exacta (¿alguna politica o configuracion de este Chrome en
// particular?), pero en ambos casos el archivo SI se sube bien a Flow, solo
// que con OTRO nombre. La solucion no es seguir peleando por controlar el
// nombre: es usar el nombre real que Chrome termina poniendo (que al menos
// es unico por ser un UUID propio) para buscarlo despues en la lista de
// Flow, en vez del nombre que se pidio.
import { Actions } from '../../lib/types';

const DOWNLOAD_WAIT_TIMEOUT_MS = 8000;
const TEMP_SUBFOLDER = 'vibes-flow-tmp';
const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreenDocument(): Promise<void> {
  if (await browser.offscreen.hasDocument()) return;
  await browser.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification:
      'Convertir la imagen del start frame a blob: URL para que chrome.downloads.download() respete el nombre de archivo pedido.',
  });
}

async function dataUrlToBlobUrl(dataUrl: string): Promise<string | null> {
  await ensureOffscreenDocument();
  const respuesta = await browser.runtime.sendMessage({
    action: Actions.ConvertDataUrlToBlobUrl,
    dataUrl,
  });
  if (!respuesta?.ok) {
    console.error('[dataUrlToBlobUrl] el offscreen document no pudo convertir:', respuesta);
    return null;
  }
  return respuesta.blobUrl as string;
}

export interface TempDownload {
  id: number;
  path: string;
  // El nombre real que Chrome le puso al archivo (ultimo segmento de
  // `path`), casi nunca igual al que se pidio -- ver comentario de arriba.
  // Es lo que hay que buscar despues en la lista de Flow, no `uploadName`.
  realFileName: string;
}

function extractFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function saveTempFileForUpload(
  dataUrl: string,
  uploadName: string
): Promise<TempDownload | null> {
  const filename = `${TEMP_SUBFOLDER}/${uploadName}`;

  const blobUrl = await dataUrlToBlobUrl(dataUrl);
  if (!blobUrl) return null;

  let downloadId: number;
  try {
    downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (err) {
    console.error('[saveTempFileForUpload] downloads.download() falló:', err, { filename });
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (path: string | null) => {
      if (settled) return;
      settled = true;
      browser.downloads.onChanged.removeListener(onChanged);
      resolve(path ? { id: downloadId, path, realFileName: extractFileName(path) } : null);
    };

    const onChanged = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        browser.downloads.search({ id: downloadId }).then((items) => {
          console.log('[saveTempFileForUpload] descarga completa:', {
            filenamePedido: filename,
            rutaReal: items[0]?.filename,
            mime: items[0]?.mime,
            bytesReceived: items[0]?.bytesReceived,
          });
          finish(items[0]?.filename ?? null);
        });
      } else if (delta.state?.current === 'interrupted') {
        console.error('[saveTempFileForUpload] descarga interrumpida:', delta);
        finish(null);
      }
    };
    browser.downloads.onChanged.addListener(onChanged);

    // Por si ya termino antes de que el listener quedara puesto (archivos
    // chicos, puede pasar en el mismo tick).
    browser.downloads.search({ id: downloadId }).then((items) => {
      if (items[0]?.state === 'complete') {
        console.log('[saveTempFileForUpload] descarga ya estaba completa:', {
          filenamePedido: filename,
          rutaReal: items[0].filename,
        });
        finish(items[0].filename ?? null);
      }
    });

    setTimeout(() => {
      console.error('[saveTempFileForUpload] timeout esperando que termine la descarga');
      finish(null);
    }, DOWNLOAD_WAIT_TIMEOUT_MS);
  });
}

export async function cleanupTempDownload(download: TempDownload): Promise<void> {
  try {
    await browser.downloads.removeFile(download.id);
  } catch {
    // El archivo puede ya no existir; no es motivo de error.
  }
  try {
    await browser.downloads.erase({ id: download.id });
  } catch {
    // Best-effort: limpiar el historial de descargas no es critico.
  }
}
