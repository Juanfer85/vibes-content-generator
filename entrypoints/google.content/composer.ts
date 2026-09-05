import { sleep, nativeClick, nativeType } from './domUtils';

export function getComposer(): HTMLElement | null {
  // Google migro el editor de Slate.js a ProseMirror al mudar Flow de
  // labs.google a flow.google.com (2026-09): ya no existe el atributo
  // data-slate-editor, el nodo editable real es un <flow-rich-text-editor>
  // con un div.ProseMirror[contenteditable="true"] adentro.
  return document.querySelector<HTMLElement>(
    'flow-rich-text-editor .ProseMirror[contenteditable="true"]'
  );
}

// Google Flow uses Slate.js, which blocks synthetic (isTrusted: false) input
// events — text must go in via the native Chrome Debugger typing trick
// (nativeType), same as clicks use nativeClick. Image upload (video mode)
// happens separately in startFrame.ts, not here.
export async function fillSlateComposer(composer: HTMLElement, prompt: string): Promise<boolean> {
  const expected = prompt.trim();

  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    await sleep(100);

    composer.focus();
    await sleep(200);
    await nativeType(prompt);
    await sleep(400);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);

    if (composer.textContent.trim().includes(expected)) return true;
  }

  return false;
}

function getVisibleArrowButtons(): HTMLButtonElement[] {
  // El icono paso de <i>arrow_forward</i> (Material Icons clasico) a
  // <mat-icon class="google-symbols">arrow_forward</mat-icon> (Angular
  // Material) con el rediseno de flow.google.com (2026-09) -- el texto de
  // la ligadura no cambio, solo la etiqueta que lo envuelve.
  return Array.from(document.querySelectorAll('button')).filter(
    (b) =>
      b.querySelector('i, mat-icon')?.textContent?.trim() === 'arrow_forward' &&
      b.offsetParent !== null
  ) as HTMLButtonElement[];
}

// Clicks the submit button, handling both the collapsed (1 button) and
// expanded (2+ buttons) states of the Google Flow composer.
export async function submitPrompt(composer: HTMLElement): Promise<boolean> {
  const arrowBtns = getVisibleArrowButtons();
  if (arrowBtns.length === 0) return false;

  if (arrowBtns.length === 1) {
    // Collapsed state — simulate Enter to trigger expansion, then native-click
    // the button in the expanded state.
    const firstBtn = arrowBtns[0];
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    await sleep(500);

    await nativeClick(firstBtn);
    await sleep(2500);

    const currentBtns = getVisibleArrowButtons();
    if (currentBtns.length === 0) return false;
    await nativeClick(currentBtns[currentBtns.length - 1]);
    return true;
  }

  // Expanded state — native-click the last (submit) button directly.
  await nativeClick(arrowBtns[arrowBtns.length - 1]);
  return true;
}
