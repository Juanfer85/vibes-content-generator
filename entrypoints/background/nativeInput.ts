// Simulates real OS-level mouse/keyboard input via the Chrome DevTools
// Protocol debugger — some sites' React handlers ignore synthetic DOM events
// (element.click(), KeyboardEvent) but do respond to actual input dispatched
// this way.

export async function nativeClick(tabId: number, x: number, y: number) {
  try {
    await browser.debugger.attach({ tabId }, '1.3');
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.detach({ tabId });
  } catch {
    // Debugger attach can fail if the tab is already attached; silently ignore.
  }
}

export async function nativeType(tabId: number, text: string) {
  try {
    await browser.debugger.attach({ tabId }, '1.3');
    await browser.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    await browser.debugger.detach({ tabId });
  } catch {
    // Silently ignore
  }
}

// ── Subida de archivo interceptando el selector nativo ──────────────────────
//
// El rediseno de flow.google.com (2026-09) quito el <input type="file">
// persistente que la version vieja encontraba e inyectaba por DataTransfer:
// ahora "Subir" crea el input al vuelo, ligado a abrir de una el selector
// nativo del sistema operativo, y lo destruye apenas se resuelve. No hay
// ninguna ventana para tocarlo por DOM (confirmado en vivo con un
// MutationObserver: aparece una sola vez y desaparece sin dejar margen).
//
// La salida es la misma que usa Playwright por debajo: interceptar el
// dialogo A NIVEL DE PROTOCOLO con el mismo chrome.debugger que ya usan
// nativeClick/nativeType, en vez de tocar el DOM.
// `DOM.setFileInputFiles` pide una ruta real en disco -- ver
// `saveTempFileForUpload` en downloadFile.ts para como se consigue esa
// ruta a partir de la imagen que la extension solo tiene en memoria.
//
// NO VERIFICADO EN VIVO todavia (escrito el 2026-09-05 a partir de la
// evidencia del DOM real y de como Chrome DevTools Protocol expone este
// mecanismo; falta probarlo contra la extension de verdad).
export async function nativeUploadFile(
  tabId: number,
  x: number,
  y: number,
  absolutePath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onEvent = (
      source: Browser.debugger.DebuggerSession,
      method: string,
      params?: object
    ) => {
      if (source.tabId !== tabId || method !== 'Page.fileChooserOpened') return;
      const backendNodeId = (params as { backendNodeId?: number } | undefined)
        ?.backendNodeId;
      if (!backendNodeId) {
        void finish(false);
        return;
      }
      browser.debugger
        .sendCommand({ tabId }, 'DOM.setFileInputFiles', {
          files: [absolutePath],
          backendNodeId,
        })
        .then(() => finish(true))
        .catch(() => finish(false));
    };

    const finish = async (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      browser.debugger.onEvent.removeListener(onEvent);
      try {
        await browser.debugger.sendCommand(
          { tabId },
          'Page.setInterceptFileChooserDialog',
          { enabled: false }
        );
      } catch {
        // El tab puede haber navegado o el debugger ya soltarse solo.
      }
      try {
        await browser.debugger.detach({ tabId });
      } catch {
        // Ignorado: puede que ya estuviera desconectado.
      }
      resolve(result);
    };

    void (async () => {
      try {
        await browser.debugger.attach({ tabId }, '1.3');
        await browser.debugger.sendCommand({ tabId }, 'Page.enable', {});
        await browser.debugger.sendCommand(
          { tabId },
          'Page.setInterceptFileChooserDialog',
          { enabled: true }
        );
        browser.debugger.onEvent.addListener(onEvent);
        await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      } catch {
        void finish(false);
        return;
      }
      timeoutId = setTimeout(() => void finish(false), 8000);
    })();
  });
}
