// Materializa una imagen (que la extension solo tiene en memoria, como
// data URL) en un archivo real y temporal en disco, usando chrome.downloads
// -- la unica API que le da a una extension una ruta absoluta de verdad,
// que es lo que pide DOM.setFileInputFiles (ver nativeUploadFile en
// nativeInput.ts). El archivo se borra despues de usarlo.
//
// NO VERIFICADO EN VIVO todavia (2026-09-05): escrito a partir de la
// documentacion de chrome.downloads, sin probar contra la extension real.

const DOWNLOAD_WAIT_TIMEOUT_MS = 8000;
const TEMP_SUBFOLDER = 'vibes-flow-tmp';

export interface TempDownload {
  id: number;
  path: string;
}

export async function saveTempFileForUpload(
  dataUrl: string,
  uploadName: string
): Promise<TempDownload | null> {
  const filename = `${TEMP_SUBFOLDER}/${uploadName}`;

  let downloadId: number;
  try {
    downloadId = await browser.downloads.download({
      url: dataUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (path: string | null) => {
      if (settled) return;
      settled = true;
      browser.downloads.onChanged.removeListener(onChanged);
      resolve(path ? { id: downloadId, path } : null);
    };

    const onChanged = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        browser.downloads.search({ id: downloadId }).then((items) => {
          finish(items[0]?.filename ?? null);
        });
      } else if (delta.state?.current === 'interrupted') {
        finish(null);
      }
    };
    browser.downloads.onChanged.addListener(onChanged);

    // Por si ya termino antes de que el listener quedara puesto (archivos
    // chicos, puede pasar en el mismo tick).
    browser.downloads.search({ id: downloadId }).then((items) => {
      if (items[0]?.state === 'complete') finish(items[0].filename ?? null);
    });

    setTimeout(() => finish(null), DOWNLOAD_WAIT_TIMEOUT_MS);
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
