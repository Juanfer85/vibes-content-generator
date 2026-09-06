// Simulates real OS-level mouse/keyboard input via the Chrome DevTools
// Protocol debugger — some sites' React handlers ignore synthetic DOM events
// (element.click(), KeyboardEvent) but do respond to actual input dispatched
// this way.

// chrome.debugger solo permite UNA sesion adjunta por pestaña desde esta
// extension a la vez. nativeUploadFile se queda adjuntado hasta 8s esperando
// Page.fileChooserOpened; si nativeClick/nativeType de OTRO paso cae en ese
// margen, su propio attach() falla ("Another debugger is already attached")
// -- probable causa de los fallos intermitentes vistos en vivo el
// 2026-09-05 (a veces "Subir" no aparece, a veces la imagen subida no
// aparece en la lista: distinto punto cada vez, tal como se espera de una
// condicion de carrera). Reintentar el attach un par de veces con una
// pausa corta le da tiempo a la sesion anterior a soltarse.
async function attachWithRetry(tabId: number, maxAttempts = 3): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await browser.debugger.attach({ tabId }, '1.3');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

export async function nativeClick(tabId: number, x: number, y: number) {
  try {
    await attachWithRetry(tabId);
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
  } catch (err) {
    // Debugger attach can fail if the tab is already attached (por ejemplo,
    // si nativeUploadFile todavia no solto el suyo) -- se sigue ignorando
    // para no interrumpir el batch, pero ahora queda en consola para poder
    // diagnosticar fallos intermitentes en vez de adivinar a ciegas.
    console.error('[nativeClick] falló:', err);
  }
}

// Hover real. Hace falta porque flow.google.com carga el <video> de cada
// resultado SOLO cuando el mouse pasa por encima (verificado en vivo el
// 2026-09-06: sin hover no hay ni un solo <video> en el DOM, con hover
// aparece con su src real). Un mouseenter sintetico no alcanza.
export async function nativeHover(tabId: number, x: number, y: number) {
  try {
    await attachWithRetry(tabId);
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await browser.debugger.detach({ tabId });
  } catch (err) {
    console.error('[nativeHover] falló:', err);
  }
}

// Hover + clic en UNA SOLA sesion de depurador. Hace falta porque al
// soltar el depurador se pierde el estado de "mouse encima": los botones
// que Flow solo muestra al pasar el mouse (el ⋮ de cada recuadro) se
// vuelven a ocultar, y el clic siguiente atraviesa hasta la imagen de
// abajo, abriendola en vez de abrir el menu (visto en vivo el 2026-09-06).
export async function nativeHoverClick(
  tabId: number,
  hoverX: number,
  hoverY: number,
  clickX: number,
  clickY: number
) {
  try {
    await attachWithRetry(tabId);
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: hoverX,
      y: hoverY,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Un segundo movimiento, ya sobre el boton: algunos menus solo se
    // activan cuando el puntero entra en el boton mismo.
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clickX,
      y: clickY,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.detach({ tabId });
  } catch (err) {
    console.error('[nativeHoverClick] falló:', err);
  }
}

export async function nativeType(tabId: number, text: string) {
  try {
    await attachWithRetry(tabId);
    await browser.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    await browser.debugger.detach({ tabId });
  } catch (err) {
    console.error('[nativeType] falló:', err);
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
// VERIFICADO PARCIALMENTE EN VIVO (2026-09-05): el mecanismo de
// intercepcion + DOM.setFileInputFiles SI funciona (la imagen aparece
// subida en Flow), pero el flujo completo falla de forma intermitente en
// puntos distintos entre reintentos, incluso con el flag
// --silent-debugger-extension-api puesto. Sospecha principal sin
// confirmar: esta funcion mantiene el debugger ATTACHED durante todo el
// tiempo que espera el evento Page.fileChooserOpened (hasta 8s); si algun
// nativeClick/nativeType de OTRO paso se dispara en ese margen, su propio
// intento de attach() falla ("Another debugger is already attached") y
// quedaba silenciosamente ignorado -- de ahi el logging nuevo de arriba.
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
        console.error(
          '[nativeUploadFile] Page.fileChooserOpened sin backendNodeId:',
          params
        );
        void finish(false);
        return;
      }
      browser.debugger
        .sendCommand({ tabId }, 'DOM.setFileInputFiles', {
          files: [absolutePath],
          backendNodeId,
        })
        .then(() => finish(true))
        .catch((err) => {
          console.error('[nativeUploadFile] DOM.setFileInputFiles falló:', err);
          finish(false);
        });
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
      } catch (err) {
        // El tab puede haber navegado o el debugger ya soltarse solo.
        console.error('[nativeUploadFile] no se pudo desactivar la intercepción:', err);
      }
      try {
        await browser.debugger.detach({ tabId });
      } catch (err) {
        console.error('[nativeUploadFile] detach falló:', err);
      }
      resolve(result);
    };

    void (async () => {
      try {
        await attachWithRetry(tabId);
        await browser.debugger.sendCommand({ tabId }, 'Page.enable', {});
        // DOM.setFileInputFiles pertenece al dominio DOM, no a Page: sin
        // habilitarlo, el comando puede devolver exito sin surtir efecto
        // real sobre el nodo (backendNodeId existe igual, pero el dominio
        // que lo resuelve no estaba activo). Coincide exactamente con el
        // sintoma visto en vivo el 2026-09-05: la intercepcion reporta
        // exito pero el archivo nunca llega a subirse en Flow.
        await browser.debugger.sendCommand({ tabId }, 'DOM.enable', {});
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
      } catch (err) {
        console.error('[nativeUploadFile] falló antes de abrir el diálogo:', err);
        void finish(false);
        return;
      }
      timeoutId = setTimeout(() => {
        console.error('[nativeUploadFile] timeout esperando Page.fileChooserOpened');
        void finish(false);
      }, 8000);
    })();
  });
}
