import { Actions } from '../../lib/types';
import { aborted } from './abortState';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function waitFor<T>(check: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const existing = check();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const result = check();
      if (result || aborted || Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(result ?? null);
      }
    }, 200);
  });
}

export async function sleepAbortable(ms: number) {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

// Uses the Chrome Debugger API to dispatch a trusted (isTrusted=true) mouse
// click, which is required to pass Google Flow's synthetic-event guards.
export async function nativeClick(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  await browser.runtime.sendMessage({ action: Actions.NativeClick, x, y });
  await sleep(300);
}

// Hover real sobre un elemento. flow.google.com carga el <video> de cada
// resultado SOLO cuando el mouse pasa por encima, y un mouseenter sintetico
// no alcanza (ver nativeHover en background/nativeInput.ts).
export async function nativeHover(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  await browser.runtime.sendMessage({ action: Actions.NativeHover, x, y });
  await sleep(300);
}

// Hover sobre un elemento y clic sobre otro, en la MISMA sesion de
// depurador. Necesario para los controles que Flow solo muestra al pasar
// el mouse (el ⋮ de cada recuadro): si el hover y el clic van en sesiones
// separadas, al soltar el depurador se pierde el "mouse encima", el boton
// se oculta y el clic termina cayendo sobre la imagen de abajo.
export async function nativeHoverClick(
  hoverTarget: HTMLElement,
  clickTarget: HTMLElement
): Promise<void> {
  const h = hoverTarget.getBoundingClientRect();
  const c = clickTarget.getBoundingClientRect();
  await browser.runtime.sendMessage({
    action: Actions.NativeHoverClick,
    hoverX: Math.round(h.left + h.width / 2),
    hoverY: Math.round(h.top + h.height / 2),
    clickX: Math.round(c.left + c.width / 2),
    clickY: Math.round(c.top + c.height / 2),
  });
  await sleep(400);
}

export async function nativeType(text: string): Promise<void> {
  await browser.runtime.sendMessage({ action: Actions.NativeType, text });
  await sleep(100);
}

// Utilidad para convertir base64 a File real (necesario para inyectarlo en DataTransfer)
export async function base64ToFile(base64: string, filename: string): Promise<File> {
  const res = await fetch(base64);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type });
}

export function findButtonByTextSubstring(
  text: string,
  exact: boolean = false
): HTMLElement | null {
  return Array.from(
    document.querySelectorAll('button, div[role="button"], span[role="button"]')
  ).find((el) => {
    if ((el as HTMLElement).offsetParent === null) return false;
    const elText = el.textContent?.trim().toLowerCase() ?? '';
    return exact ? elText === text.toLowerCase() : elText.includes(text.toLowerCase());
  }) as HTMLElement | null;
}
