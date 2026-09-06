import { Actions } from '../../lib/types';
import type { ExtensionMessage } from '../../lib/types';

// Documento invisible, nunca mostrado al usuario -- ver offscreen.html y el
// comentario en downloadFile.ts para el motivo completo. Su unico trabajo es
// convertir un data: URL en un blob: URL, porque URL.createObjectURL()
// necesita un contexto con DOM (el service worker del background no lo
// tiene en Manifest V3).
browser.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.action !== Actions.ConvertDataUrlToBlobUrl) return;

    (async () => {
      try {
        const res = await fetch(message.dataUrl);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        sendResponse({ ok: true, blobUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return true; // respuesta asincrona
  }
);
