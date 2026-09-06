import { sleep, nativeClick, nativeType, waitFor } from './domUtils';

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

// UN SOLO clic. La version vieja tenia un baile de estados
// "colapsado/expandido": si encontraba un unico boton, mandaba Enter,
// clickeaba, esperaba 2.5s y VOLVIA A CLICKEAR. En el rediseno de
// flow.google.com (2026-09) hay un unico boton "Iniciar generación"
// siempre, asi que ese camino se tomaba siempre y enviaba DOS VECES:
// el primer envio salia bien (con el start frame adjunto), Flow consumia
// y limpiaba el frame, y el segundo clic disparaba una generacion extra
// SIN imagen adjunta -- animando cualquier otra cosa a partir del texto.
// Ese era el sintoma reportado: "sube la imagen pero anima otra distinta".
export async function submitPrompt(_composer: HTMLElement): Promise<boolean> {
  // Angular puede tardar un instante en habilitar el boton despues de que
  // el texto entra al editor.
  const btn = await waitFor(() => {
    const habilitados = getVisibleArrowButtons().filter((b) => !b.disabled);
    return habilitados[habilitados.length - 1] ?? null;
  }, 5000);
  if (!btn) return false;

  await nativeClick(btn);
  return true;
}
