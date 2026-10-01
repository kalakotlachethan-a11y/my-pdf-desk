/**
 * Vercel Serverless Function: POST /api/parse-pdf
 * Server-side PDF parsing (replaces client-side pdf.js parsing when deployed
 * on Vercel). Accepts multipart/form-data with a `file` field (application/pdf)
 * and returns structured JSON: per-page text, vector-detected tables, embedded
 * images (base64), page dimensions and document metadata.
 *
 * The frontend calls this first; when the endpoint is unavailable (e.g. the
 * static GitHub Pages deploy) it transparently falls back to local parsing.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// Payload guards: keep the JSON response sane for the browser.
const MAX_IMAGE_B64 = 900_000; // ~900 KB base64 per image
const MAX_TOTAL_IMAGES_B64 = 3_500_000;
const MAX_IMAGES = 12;
const MAX_ITEMS_PER_PAGE = 4000;
const MAX_LINES_PER_PAGE = 4000;

/**
 * Positioned-text + vector-geometry pass (pdf.js, already a project dependency).
 * The client uses this to run its exact-fidelity layout/table reconstruction on
 * server-parsed data. Returns [] when unavailable — the text path still works.
 */
async function extractGeometry(buffer) {
  const pages = [];
  // Pin pdf.js to its own worker file (pdf-parse's bundled pdf.js leaves a
  // default relative path in place that can resolve to the wrong version).
  try {
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
  } catch {
    // Keep the library default when resolution fails.
  }
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false });
  const doc = await loadingTask.promise;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const styles = tc.styles ?? {};
      const items = [];
      for (const item of tc.items) {
        if (items.length >= MAX_ITEMS_PER_PAGE) break;
        if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
        const t = item.transform ?? [1, 0, 0, 1, 0, 0];
        const family = styles[item.fontName]?.fontFamily ?? '';
        items.push({
          str: item.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          w: item.width ?? 0,
          size: Math.abs(t[3] ?? t[0] ?? 10),
          font: family,
        });
      }

      // Vector border lines for table detection: bbox of every path op
      // (pdf.js 5+/6 encodes constructPath as [minMaxId, flatPath, Float32Array bbox]).
      const lines = [];
      try {
        const ops = await page.getOperatorList();
        for (let k = 0; k < ops.fnArray.length; k++) {
          if (lines.length >= MAX_LINES_PER_PAGE) break;
          const args = ops.argsArray[k];
          if (!Array.isArray(args) || !(args[2] instanceof Float32Array) || args[2].length < 4) continue;
          const minX = args[2][0], minY = args[2][1], maxX = args[2][2], maxY = args[2][3];
          if (![minX, minY, maxX, maxY].every(Number.isFinite)) continue;
          const w = maxX - minX, h = maxY - minY;
          if (w >= 3000 || h >= 3000) continue;
          if (h < 1.2) lines.push({ x1: minX, y1: minY, x2: maxX, y2: minY });
          else if (w < 1.2) lines.push({ x1: minX, y1: minY, x2: minX, y2: maxY });
          else if (w < viewport.width * 0.92 && h < viewport.height * 0.92) {
            lines.push({ x1: minX, y1: minY, x2: maxX, y2: minY });
            lines.push({ x1: maxX, y1: minY, x2: maxX, y2: maxY });
            lines.push({ x1: minX, y1: maxY, x2: maxX, y2: maxY });
            lines.push({ x1: minX, y1: minY, x2: minX, y2: maxY });
          }
        }
      } catch {
        // Operator introspection denied — tables stay text.
      }

      pages.push({ num: i, width: viewport.width, height: viewport.height, items, lines });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

function collectImages(imagesResult) {
  const out = [];
  let total = 0;
  try {
    const pages = Array.isArray(imagesResult?.pages) ? imagesResult.pages : [];
    for (const page of pages) {
      const imgs = Array.isArray(page?.images) ? page.images : [];
      for (const img of imgs) {
        if (out.length >= MAX_IMAGES) return out;
        const dataUrl = typeof img?.dataUrl === 'string' ? img.dataUrl : null;
        if (!dataUrl || !dataUrl.startsWith('data:image/')) continue;
        if (dataUrl.length > MAX_IMAGE_B64) continue;
        if (total + dataUrl.length > MAX_TOTAL_IMAGES_B64) continue;
        total += dataUrl.length;
        out.push({
          num: page.num,
          dataUrl,
          width: img.width ?? null,
          height: img.height ?? null,
        });
      }
    }
  } catch {
    // Images are best-effort; text/tables remain the priority.
  }
  return out;
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. POST a multipart/form-data form with a `file` field.' }, 405);
  }

  let file;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (!candidate || typeof candidate === 'string') {
      return json({ error: 'Missing PDF file. Send multipart/form-data with a `file` field.' }, 400);
    }
    file = candidate;
  } catch {
    return json({ error: 'Could not read the upload. Please retry with a valid PDF file.' }, 400);
  }

  if (file.size > 40 * 1024 * 1024) {
    return json({ error: 'This PDF is too large for server processing (limit 40 MB).' }, 413);
  }

  let buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return json({ error: 'Could not read the uploaded file.' }, 400);
  }

  // Signature check: a valid PDF starts with "%PDF-".
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return json({ error: 'This file is not a valid PDF document.' }, 400);
  }

  let parser;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });

    // NOTE: pdf-parse v2 shares one pdf.js worker per instance — calls must run
    // sequentially (parallel calls throw "Cannot transfer object of unsupported type").
    const infoResult = await parser.getInfo({ parsePageInfo: true });
    const textResult = await parser.getText();
    const tableResult = await parser.getTable().catch(() => null);

    // Per-page geometry from getInfo (falls back to A4 portrait).
    const geoByNum = new Map();
    for (const page of infoResult?.pages ?? []) {
      if (page && typeof page.width === 'number' && typeof page.height === 'number') {
        geoByNum.set(page.pageNumber ?? page.num, { width: page.width, height: page.height });
      }
    }

    const pages = (textResult?.pages ?? []).map(p => ({
      num: p.num,
      text: typeof p.text === 'string' ? p.text : '',
      width: geoByNum.get(p.num)?.width ?? 595,
      height: geoByNum.get(p.num)?.height ?? 842,
    }));

    const tables = (tableResult?.pages ?? [])
      .map(p => ({ num: p.num, cells: (p.tables ?? []).map(t => (Array.isArray(t) ? t.map(row => (Array.isArray(row) ? row.map(c => String(c ?? '')) : [])) : [])) }))
      .filter(p => p.cells.length > 0);

    let images = [];
    try {
      const imageResult = await parser.getImage({ imageDataUrl: true, imageThreshold: 28 });
      images = collectImages(imageResult);
    } catch {
      images = [];
    }

    // Positioned geometry pass (best-effort; client falls back to text mode).
    // pdf-parse registers its bundled pdf.js worker handler on globalThis; a
    // different pdf.js major version then fails its version check. Clearing the
    // globals lets the project's pdf.js run its own worker cleanly.
    delete globalThis.pdfjs;
    delete globalThis.pdfjsWorker;
    let geometry = [];
    try {
      geometry = await extractGeometry(buffer);
    } catch {
      geometry = [];
    }

    return json({
      ok: true,
      numpages: textResult?.total ?? pages.length,
      title: infoResult?.info?.Title ?? null,
      author: infoResult?.info?.Author ?? null,
      pages,
      tables,
      images,
      geometry,
    });
  } catch (err) {
    const message = String(err?.message ?? err ?? 'unknown');
    if (/password|encrypt/i.test(message)) {
      return json({ error: 'This PDF is password-protected. Remove the password and try again.' }, 400);
    }
    if (/structure|corrupt|damaged|invalid/i.test(message)) {
      return json({ error: 'This PDF appears to be corrupted and could not be parsed.' }, 422);
    }
    return json({ error: 'The PDF could not be processed on the server. Please try again.' }, 500);
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }
}
