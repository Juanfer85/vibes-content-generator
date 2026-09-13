// ── Network helpers ───────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 60000;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBlobWithRetry(url: string): Promise<Blob | null> {
  // data: URLs don't need a network request — decode them directly.
  if (url.startsWith('data:')) {
    try {
      const res = await fetch(url);
      return await res.blob();
    } catch {
      return null;
    }
  }

  // Se guarda la ultima causa para poder decirla al rendirse: sin esto, una
  // descarga que agota los 3 intentos devuelve null en silencio absoluto y no
  // queda rastro de si fue 403 (URL de Flow expirada), timeout o red caida.
  let ultimaCausa = 'sin detalle';

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.ok) return await resp.blob();
      ultimaCausa = `HTTP ${resp.status}`;
    } catch (err) {
      ultimaCausa = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    if (attempt < FETCH_RETRIES - 1) await sleep(RETRY_BACKOFF_MS[attempt]);
  }

  console.error(
    `[fetchBlobWithRetry] se agotaron los ${FETCH_RETRIES} intentos, ultima causa: ${ultimaCausa}`,
    { url }
  );
  return null;
}

// ── File system helpers ───────────────────────────────────────────────────────

export async function writeBlobToFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ── Watermark removal ─────────────────────────────────────────────────────────

// Vibes.ai stamps a "Meta AI" watermark in the bottom-right corner.
// Blurring that region makes it illegible without altering the image framing.
export async function blurWatermarkCorner(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0);

    const regionW = Math.round(bitmap.width * 0.22);
    const regionH = Math.round(bitmap.height * 0.07);
    const x = bitmap.width - regionW;
    const y = bitmap.height - regionH;

    ctx.filter = 'blur(14px)';
    ctx.drawImage(canvas, x, y, regionW, regionH, x, y, regionW, regionH);
    ctx.filter = 'none';

    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch {
    return blob;
  }
}

// ── Marco blanco (deteccion por pixeles) ────────────────────────────────────────

// Umbral de brillo (0-255) para considerar un pixel "casi blanco".
const WHITE_BORDER_BRIGHTNESS_MIN = 235;
// Desviacion estandar maxima de brillo dentro de la franja: un marco real es
// PLANO (mismo blanco en todo el borde). Un cielo o ventana brillante tiene
// textura/gradiente y su desviacion es mucho mas alta, aunque tambien sea
// clara -- esto evita marcar como "marco" una escena legitimamente luminosa.
const WHITE_BORDER_STDDEV_MAX = 15;
// Ancho de la franja muestreada en cada borde, como fraccion del lado corto.
const WHITE_BORDER_STRIP_FRACTION = 0.02;

function stripStats(data: Uint8ClampedArray): { mean: number; stdDev: number } {
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 4) {
    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sumSq += (brightness - mean) ** 2;
  }
  return { mean, stdDev: Math.sqrt(sumSq / n) };
}

// Detecta el marco blanco de "pagina de comic" que Flow y Vibes empezaron a
// dibujar cada vez mas seguido (2026-09-13), pese a la instruccion anti-panel
// del estilo -- el fix de prompt reduce la frecuencia pero no la elimina, asi
// que este filtro es la ultima linea de defensa antes de que una imagen
// invalida entre al pipeline y se gasten pasos (o creditos, en el caso de
// Kie) corrigiendo algo que se pudo descartar aqui mismo.
//
// Revisa una franja delgada pegada a CADA uno de los 4 bordes: un marco real
// es blanco Y PLANO en los cuatro a la vez. Exigir las dos condiciones (brillo
// alto Y desviacion baja) en los CUATRO bordes evita falsos positivos en
// escenas legitimamente luminosas (cielo, ventana) que son claras pero tienen
// textura, no un borde limpio y uniforme.
export async function hasWhiteBorder(blob: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);

    const { width: w, height: h } = bitmap;
    const strip = Math.max(2, Math.round(Math.min(w, h) * WHITE_BORDER_STRIP_FRACTION));

    const franjas = [
      ctx.getImageData(0, 0, w, strip), // arriba
      ctx.getImageData(0, h - strip, w, strip), // abajo
      ctx.getImageData(0, 0, strip, h), // izquierda
      ctx.getImageData(w - strip, 0, strip, h), // derecha
    ];

    return franjas.every(({ data }) => {
      const { mean, stdDev } = stripStats(data);
      return mean >= WHITE_BORDER_BRIGHTNESS_MIN && stdDev <= WHITE_BORDER_STDDEV_MAX;
    });
  } catch {
    // Fallar abierto: un error del detector no debe bloquear una imagen
    // buena. El costo de un falso negativo ocasional es mucho menor que el
    // de tirar imagenes validas por un fallo del propio filtro.
    return false;
  }
}

// Elige, de una lista de blobs candidatos (en el orden en que Vibes/Flow los
// entrego), el primero SIN marco blanco -- preserva el criterio determinista
// existente ("el primero que sirva", nunca al azar) y solo agrega el filtro
// de validez encima. `null` si ninguno pasa: el llamador decide que hacer
// (ver Actions.SceneFailed en App.tsx), nunca se elige uno malo por defecto.
export async function pickFirstWithoutWhiteBorder(blobs: Blob[]): Promise<Blob | null> {
  for (const blob of blobs) {
    if (!(await hasWhiteBorder(blob))) return blob;
  }
  return null;
}
