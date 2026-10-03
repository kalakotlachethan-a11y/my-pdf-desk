/**
 * Vercel Serverless Function: POST /api/parse-pdf
 *
 * Two request modes:
 * 1. application/json { pages: ["data:image/jpeg;base64,...", ...] }
 *    → Vision (multimodal Gemini) extraction: every page image is analyzed
 *      with 100%-fidelity structure (text, tables, code, scanned content) and
 *      returned as structured JSON. Used by the PDF → Word vision pipeline.
 * 2. multipart/form-data with a `file` field (application/pdf)
 *    → pdf-parse server extraction: per-page text, vector tables, images,
 *      positioned geometry and metadata for the local-quality reconstruction.
 *
 * The frontend calls this first; when the endpoint is unavailable (e.g. the
 * static GitHub Pages deploy) it transparently falls back to local parsing/OCR.
 */

import { PDFParse } from 'pdf-parse';
import { GoogleGenerativeAI } from '@google/generative-ai';
/**
 * pdf.js under Node needs DOMMatrix/ImageData/Path2D globals; Vercel's Linux
 * runtime has none, so its module init throws ("DOMMatrix is not defined").
 * @napi-rs/canvas supplies them; pdf.js itself is imported lazily so the
 * globals are installed before its module evaluates.
 */
import * as pdfjsWorker from 'pdfjs-dist5/legacy/build/pdf.worker.mjs';

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try {
        const canvas = await import('@napi-rs/canvas');
        if (typeof globalThis.DOMMatrix === 'undefined' && canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
        if (typeof globalThis.ImageData === 'undefined' && canvas.ImageData) globalThis.ImageData = canvas.ImageData;
        if (typeof globalThis.Path2D === 'undefined' && canvas.Path2D) globalThis.Path2D = canvas.Path2D;
      } catch {
        // Geometry pass degrades gracefully; the text path still works.
      }
      globalThis.pdfjsWorker = pdfjsWorker;
      return import('pdfjs-dist5/legacy/build/pdf.mjs');
    })();
  }
  return pdfjsPromise;
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};
export const POST = handler;
export const GET = handler;

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

const VISION_MAX_PAGES = 16;
const VISION_MAX_PAGE_B64 = 4_000_000; // ~3 MB binary per page image

const VISION_SYSTEM_PROMPT =
  'You are an elite, comprehensive document interpretation engine. You are analyzing full visual page scans of a document. ' +
  '- Extract and process all content with 100% fidelity. ' +
  '- Do not alter the structural positions, columns, tables, headers, or signatures. ' +
  '- Retain all code blocks, execution script details, file paths, and alphanumeric text fields exactly as they visually appear on the pages. ' +
  '- Provide a deep, complete, and un-truncated analytical breakdown based strictly on what is visible in the provided page image frames.';

const VISION_TASK_PROMPT =
  'Transcribe this document page (or pages, in order) with 100% visual fidelity into structured Markdown.\n' +
  'Rules:\n' +
  '1. Output ONLY the document content, starting with a level-1 heading per page: "# Page N" (N = 1-based page number).\n' +
  '2. Reproduce every heading, paragraph, list, table, code block, terminal output, caption, signature line, and header/footer line exactly as it appears — same words, same casing, same punctuation, same numbers.\n' +
  '3. Tables MUST be output as GitHub Markdown tables preserving every row/column; keep merged-header wording verbatim.\n' +
  '4. Code MUST be output in fenced blocks with the correct language tag (e.g. ```java), preserving indentation and line breaks exactly. Never merge or re-wrap code lines.\n' +
  '5. Preserve reading order left-to-right, top-to-bottom; keep multi-column content in visual column order.\n' +
  '6. Do NOT summarize, translate, correct, omit, or add anything. If something is illegible, output [illegible].\n' +
  '7. Do not wrap the whole answer in a code block.';

/**
 * Vision path: convert base64 page images to Gemini inlineData parts and run a
 * single multimodal request. Returns { markdown, model, numpages } or throws —
 * the caller maps failures to friendly errors.
 */
async function runVisionExtraction(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return json({ error: 'Missing page images. Send { pages: ["data:image/jpeg;base64,...", ...] } as JSON.' }, 400);
  }
  if (pages.length > VISION_MAX_PAGES) {
    return json({ error: `Too many pages for vision processing (limit ${VISION_MAX_PAGES}). Try splitting the document.` }, 413);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Vision processing is not configured on this deployment.' }, 503);
  }

  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    const dataUrl = typeof pages[i] === 'string' ? pages[i] : '';
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) {
      return json({ error: `Page ${i + 1} is not a valid base64 image data URL (jpeg/png/webp).` }, 400);
    }
    if (match[2].length > VISION_MAX_PAGE_B64) {
      return json({ error: `Page ${i + 1} image is too large. Please retry — the page was rendered at a lower resolution.` }, 413);
    }
    parts.push({ inlineData: { data: match[2], mimeType: match[1] } });
  }
  parts.push({ text: VISION_TASK_PROMPT });

  // Model fallback chain: availability differs per key/region — try each in
  // order (env override first) and use the first that actually responds.
  const modelCandidates = [
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ].filter(Boolean);
  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    let text = '';
    let lastModel = modelCandidates[0];
    let lastError = null;
    for (const modelName of modelCandidates) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: VISION_SYSTEM_PROMPT,
          generationConfig: { temperature: 0, maxOutputTokens: 65536 },
        });
        const result = await model.generateContent(parts);
        text = result?.response?.text?.() ?? '';
        lastModel = modelName;
        lastError = null;
        if (text.trim()) break;
      } catch (err) {
        lastError = err;
        const message = String(err?.message ?? err ?? '');
        console.error(`Gemini model ${modelName} failed:`, message.slice(0, 300));
        // Try the next candidate on availability errors; rethrow auth/safety.
        if (/api.?key|permission|unauthenticated|401|403|safety|blocked/i.test(message)) throw err;
        if (!/no longer available|not found|404|high demand|503|overload|unavailable|429|quota|resource.exhausted/i.test(message)) throw err;
      }
    }
    if (lastError || !text.trim()) {
      return json({ error: 'The vision engine is unavailable right now (high demand or retired models). Please try again in a moment.' }, 503);
    }
    return { markdown: text, model: lastModel, numpages: pages.length };
  } catch (err) {
    const message = String(err?.message ?? err ?? '');
    console.error('Gemini vision failed:', message);
    if (/api.?key|permission|unauthenticated|401|403/i.test(message)) {
      return json({ error: 'Vision processing is not authorized on this deployment.' }, 503);
    }
    if (/safety|blocked/i.test(message)) {
      return json({ error: 'The vision engine could not process this document due to its content policy.' }, 422);
    }
    return json({ error: 'The vision engine could not process this document. Please try again.' }, 502);
  }
}

/**
 * Positioned-text + vector-geometry pass (pdf.js, already a project dependency).
 * The client uses this to run its exact-fidelity layout/table reconstruction on
 * server-parsed data. Returns [] when unavailable — the text path still works.
 */
async function extractGeometry(buffer) {
  const pdfjs = await loadPdfjs();
  const pages = [];
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

// Vercel's Node runtime ignores a Response returned from a (req,res)-style
// default export — the named HTTP-method exports below are the documented
// Web-standard style, and MUST be the only handler exports.
async function handler(request) {
  const contentType = request.headers.get('content-type') ?? '';

  // ---- Vision mode: JSON page images → Gemini multimodal extraction ----
  if (contentType.includes('application/json')) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body.' }, 400);
    }
    const pages = body?.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return json({ error: 'Missing page images. Send { pages: ["data:image/jpeg;base64,...", ...] } as JSON.' }, 400);
    }
    try {
      const vision = await runVisionExtraction(pages);
      if (vision instanceof Response) return vision;
      return json({ ok: true, ...vision });
    } catch (err) {
      console.error('Vision handler failed:', err);
      return json({ error: 'The vision engine could not process this document. Please try again.' }, 502);
    }
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. POST a multipart/form-data form with a `file` field, or JSON page images.' }, 405);
  }

  let file;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (!candidate || typeof candidate === 'string') {
      return json({ error: 'Missing PDF file. Send multipart/form-data with a `file` field.' }, 400);
    }
    file = candidate;
  } catch (e) {
    console.error('formData parse failed:', e);
    return json({ error: 'Could not read the upload. Please retry with a valid PDF file.', detail: e?.message ? String(e.message) : undefined }, 400);
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
    console.error('PDF processing failed:', err);
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
