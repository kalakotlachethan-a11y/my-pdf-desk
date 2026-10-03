/**
 * Vision pipeline: renders a single pdf.js page to a high-resolution base64
 * JPEG (scale >= 2.0) for the /api/parse-pdf vision (Gemini) path.
 */
export const VISION_RENDER_SCALE = 2;
/** Cap one chunk's base64 payload below Vercel's 4.5 MB request limit. */
export const VISION_CHUNK_MAX_B64 = 2_800_000;
export const VISION_CHUNK_MAX_PAGES = 8;

interface RenderablePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: Record<string, unknown>) => { promise: Promise<void> };
  cleanup: () => void;
}

export async function renderPageToJpeg(rawPage: unknown, scale = VISION_RENDER_SCALE): Promise<string> {
  const page = rawPage as RenderablePage;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();
  return dataUrl;
}

/** Split a full base64 list into payload-safe chunks for the vision API. */
export function chunkPageImages(images: string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const img of images) {
    if (cur.length >= VISION_CHUNK_MAX_PAGES || (cur.length > 0 && bytes + img.length > VISION_CHUNK_MAX_B64)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(img);
    bytes += img.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
