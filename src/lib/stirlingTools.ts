/**
 * Stirling-PDF parity tools: Organize / Convert / Security-Info / Misc engines.
 * All processing is client-side on top of pdf-lib + pdf.js already in the bundle.
 * Every exported function matches the `processTool` signature:
 *   (files: File[], options: Record<string, string>) => Promise<ProcessedResult>
 */
import { PDFDocument, StandardFonts, degrees, rgb, PDFFont, PDFName, PDFDict, PDFStream, PDFArray } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import JSZip from 'jszip';

export interface ProcessedFile {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

export interface ProcessedResult {
  files: ProcessedFile[];
  message: string;
  originalSize: number;
  newSize: number;
}

type Options = Record<string, string>;

const pdfMime = 'application/pdf';
const txtMime = 'text/plain;charset=utf-8';

function baseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '') || 'document';
}

async function save(doc: PDFDocument, fileName: string): Promise<ProcessedFile> {
  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: new Blob([bytes as unknown as BlobPart], { type: pdfMime }), fileName, mimeType: pdfMime };
}

async function load(file: File): Promise<PDFDocument> {
  return PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, throwOnInvalidObject: false });
}

function zipResult(files: ProcessedFile[], message: string, originalSize: number): ProcessedResult | Promise<ProcessedResult> {
  if (files.length === 1) {
    return { files, message, originalSize, newSize: files[0].blob.size };
  }
  const zip = new JSZip();
  for (const f of files) zip.file(f.fileName, f.blob);
  return zip.generateAsync({ type: 'blob' }).then((blob): ProcessedResult => {
    const name = `stirling-output-${Date.now()}.zip`;
    return { files: [{ blob, fileName: name, mimeType: 'application/zip' }], message: `${message} (${files.length} files zipped)`, originalSize, newSize: blob.size };
  });
}

/* ============================================================
 * ORGANIZE GROUP
 * ============================================================ */

/** Overlay PDFs: stamp content of each overlay file onto the base file's pages (sequential or interleaved). */
export async function overlayPdfs(files: File[], options: Options): Promise<ProcessedResult> {
  const base = await load(files[0]);
  const mode = options.overlayMode ?? 'sequential'; // sequential | interleaved
  const onTop = (options.overlayPosition ?? 'foreground') === 'foreground';
  for (let f = 1; f < files.length; f++) {
    const overlayDoc = await load(files[f]);
    const overlayPages = await base.embedPages(overlayDoc.getPages());
    const basePages = base.getPages();
    for (let i = 0; i < basePages.length; i++) {
      if (i >= overlayPages.length && mode === 'interleaved') break;
      const embedded = overlayPages[mode === 'interleaved' ? i : Math.min(i, overlayPages.length - 1)];
      if (!embedded) break;
      if (onTop) basePages[i].drawPage(embedded);
      else basePages[i].drawPage(embedded, { x: 0, y: 0, width: basePages[i].getWidth(), height: basePages[i].getHeight() });
    }
  }
  const out = await save(base, `${baseName(files[0].name)}-overlay.pdf`);
  return { files: [out], message: `Overlaid ${files.length - 1} PDF${files.length > 2 ? 's' : ''} onto ${files.length - 1 === 0 ? 'the' : 'the base'} document.`, originalSize: files[0].size, newSize: out.blob.size };
}

/** Crop pages by percentages from each edge. */
export async function cropPdf(files: File[], options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const top = Number(options.cropTop ?? 0), bottom = Number(options.cropBottom ?? 0);
  const left = Number(options.cropLeft ?? 0), right = Number(options.cropRight ?? 0);
  const pages = doc.getPages();
  for (const page of pages) {
    const w = page.getWidth(), h = page.getHeight();
    const x = w * (left / 100);
    const y = h * (bottom / 100);
    page.setCropBox(x, y, Math.max(10, w - x - w * (right / 100)), Math.max(10, h - y - h * (top / 100)));
  }
  const out = await save(doc, `${baseName(files[0].name)}-cropped.pdf`);
  return { files: [out], message: `Cropped ${pages.length} page${pages.length === 1 ? '' : 's'} (T${top}% B${bottom}% L${left}% R${right}%).`, originalSize: files[0].size, newSize: out.blob.size };
}

/** Multi-page layout: place N pages per sheet (n-up). */
export async function multiPageLayout(files: File[], options: Options): Promise<ProcessedResult> {
  const src = await load(files[0]);
  const cols = Number(options.layoutCols ?? 2);
  const rows = Number(options.layoutRows ?? 1);
  const srcPages = await src.embedPages(src.getPages());
  const first = src.getPage(0);
  const pw = first.getWidth(), ph = first.getHeight();
  const out = await PDFDocument.create();
  const per = cols * rows;
  for (let start = 0; start < srcPages.length; start += per) {
    const group = srcPages.slice(start, start + per);
    const landscape = cols >= rows;
    const sheet = out.addPage(landscape ? [ph * cols, pw * rows] : [pw * cols, ph * rows]);
    group.forEach((embedded, idx) => {
      const cx = idx % cols, cy = Math.floor(idx / cols);
      const cellW = sheet.getWidth() / cols, cellH = sheet.getHeight() / rows;
      const scale = Math.min(cellW / pw, cellH / ph) * 0.98;
      const w = pw * scale, h = ph * scale;
      sheet.drawPage(embedded, {
        x: cx * cellW + (cellW - w) / 2,
        y: sheet.getHeight() - (cy + 1) * cellH + (cellH - h) / 2,
        width: w,
        height: h,
      });
    });
  }
  const out2 = await save(out, `${baseName(files[0].name)}-${cols}x${rows}-layout.pdf`);
  return { files: [out2], message: `Arranged ${srcPages.length} pages into ${cols}×${rows} grid (${out.getPageCount()} sheets).`, originalSize: files[0].size, newSize: out2.blob.size };
}

/** Scale page contents by a percentage, keeping page count. */
export async function scalePdf(files: File[], options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const factor = (Number(options.scalePercent ?? options.scaleFactor ?? 100) / 100);
  const out = await PDFDocument.create();
  const pages = await out.embedPages(doc.getPages());
  for (const embedded of pages) {
    const w = embedded.width * factor, h = embedded.height * factor;
    const sheet = out.addPage([w, h]);
    sheet.drawPage(embedded, { x: 0, y: 0, width: w, height: h });
  }
  const out2 = await save(out, `${baseName(files[0].name)}-scaled.pdf`);
  return { files: [out2], message: `Scaled ${pages.length} pages to ${Math.round(factor * 100)}%.`, originalSize: files[0].size, newSize: out2.blob.size };
}

/** Split a PDF into chunks that stay under a target size. */
export async function splitBySize(files: File[], options: Options): Promise<ProcessedResult> {
  const src = await load(files[0]);
  const limitBytes = Number(options.maxSizeMb ?? 5) * 1024 * 1024;
  const pageCount = src.getPageCount();
  const parts: ProcessedFile[] = [];
  let start = 0;
  while (start < pageCount) {
    let end = start + 1;
    let best = end;
    // exponential + binary search for max pages fitting the limit
    while (end <= pageCount) {
      const part = await PDFDocument.create();
      const idxs = Array.from({ length: end - start }, (_, k) => start + k);
      const copied = await part.copyPages(src, idxs);
      copied.forEach(p => part.addPage(p));
      const bytes = await part.save();
      if (bytes.byteLength <= limitBytes) { best = end; end++; }
      else break;
    }
    const part = await PDFDocument.create();
    const idxs = Array.from({ length: best - start }, (_, k) => start + k);
    const copied = await part.copyPages(src, idxs);
    copied.forEach(p => part.addPage(p));
    parts.push(await save(part, `${baseName(files[0].name)}-part${parts.length + 1}.pdf`));
    start = best;
  }
  return zipResult(parts, `Split into ${parts.length} size-limited PDFs.`, files[0].size);
}

/** Flatten form fields and annotations into page content. */
export async function flattenPdf(files: File[], _options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const form = doc.getForm();
  try { form.flatten(); } catch { /* no form present */ }
  const out = await save(doc, `${baseName(files[0].name)}-flattened.pdf`);
  return { files: [out], message: 'Form fields and annotations flattened into page content.', originalSize: files[0].size, newSize: out.blob.size };
}

/** Repair a damaged PDF by full re-parse and re-save. */
export async function repairPdf(files: File[], _options: Options): Promise<ProcessedResult> {
  // pdf.js tolerates broken xref/table structures that pdf-lib rejects.
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const out = await PDFDocument.create();
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const sheet = out.addPage([viewport.width, viewport.height]);
    // content copy is not byte-safe for damaged files; embed rendered page instead
    const scale = 2;
    const vp2 = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp2.width); canvas.height = Math.ceil(vp2.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp2 } as never).promise;
    const png = canvas.toDataURL('image/png');
    const embedded = await out.embedPng(png);
    sheet.drawImage(embedded, { x: 0, y: 0, width: sheet.getWidth(), height: sheet.getHeight() });
    canvas.width = 0; canvas.height = 0;
    page.cleanup();
  }
  const out2 = await save(out, `${baseName(files[0].name)}-repaired.pdf`);
  return { files: [out2], message: `Recovered ${parsed.numPages} pages from the damaged file (rendered-copy repair).`, originalSize: files[0].size, newSize: out2.blob.size };
}

/** Remove annotations (links, comments, highlights) from all pages. */
export async function removeAnnotations(files: File[], _options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  let removed = 0;
  for (const page of doc.getPages()) {
    try {
      // pdf-lib: access the Annots array indirectly through the page node
      const annots = (page.node as unknown as { Annots?: () => unknown }).Annots?.();
      if (annots) {
        (page.node as unknown as { delete: (key: string) => void }).delete('Annots');
        removed++;
      }
    } catch { /* page has no annots */ }
  }
  const out = await save(doc, `${baseName(files[0].name)}-no-annotations.pdf`);
  return { files: [out], message: removed ? `Removed annotations from ${removed} page${removed === 1 ? '' : 's'}.` : 'No annotations found — file re-saved clean.', originalSize: files[0].size, newSize: out.blob.size };
}

/* ============================================================
 * SECURITY / INFO GROUP
 * ============================================================ */

export interface PdfInfo {
  pageCount: number;
  pageSize: string;
  title: string;
  author: string;
  subject: string;
  creator: string;
  producer: string;
  creationDate: string;
  modDate: string;
  hasFormFields: boolean;
  fileSize: string;
}

/** Extract document info (used by the Get PDF Info tool). */
export async function getPdfInfo(files: File[], _options: Options): Promise<ProcessedResult> {
  const file = files[0];
  const doc = await load(file);
  const first = doc.getPage(0);
  const size = first.getSize();
  const orient = size.width > size.height ? ' landscape' : '';
  const info: PdfInfo = {
    pageCount: doc.getPageCount(),
    pageSize: `${Math.round(size.width)} × ${Math.round(size.height)} pt${orient}`,
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
    creationDate: doc.getCreationDate()?.toISOString() ?? '',
    modDate: doc.getModificationDate()?.toISOString() ?? '',
    hasFormFields: doc.getForm().getFields().length > 0,
    fileSize: `${(file.size / 1024).toFixed(1)} KB`,
  };
  const report = Object.entries(info).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
  return {
    files: [{ blob: new Blob([report], { type: txtMime }), fileName: `${baseName(file.name)}-info.txt`, mimeType: txtMime }],
    message: `Extracted metadata for ${info.pageCount} pages.`,
    originalSize: file.size,
    newSize: report.length,
  };
}

/** Edit PDF metadata (title, author, subject, dates). */
export async function editMetadata(files: File[], options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const setOrRemove = (value: string, setter: (v: string) => void, remover: () => void) => {
    if (value) setter(value); else remover();
  };
  setOrRemove(options.metaTitle ?? '', v => doc.setTitle(v), () => doc.setTitle(''));
  setOrRemove(options.metaAuthor ?? '', v => doc.setAuthor(v), () => doc.setAuthor(''));
  setOrRemove(options.metaSubject ?? '', v => doc.setSubject(v), () => doc.setSubject(''));
  setOrRemove(options.metaKeywords ?? '', v => doc.setKeywords(v.split(',').map(k => k.trim()).filter(Boolean)), () => doc.setKeywords([]));
  if (options.setDates === 'now') {
    const now = new Date();
    doc.setCreationDate(now);
    doc.setModificationDate(now);
  }
  const out = await save(doc, `${baseName(files[0].name)}-metadata.pdf`);
  return { files: [out], message: 'Metadata updated.', originalSize: files[0].size, newSize: out.blob.size };
}

/* ============================================================
 * VISUAL FILTER GROUP (show-javascript-free page filters)
 * ============================================================ */

/** Apply grayscale / contrast / brightness to every page via re-render. */
export async function filterPdfPages(files: File[], options: Options): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const filter = options.pageFilter ?? 'grayscale';
  const out = await PDFDocument.create();
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.filter = filter === 'grayscale' ? 'grayscale(1)'
      : filter === 'contrast' ? 'contrast(1.6)'
      : filter === 'brightness' ? 'brightness(1.4)'
      : filter === 'invert' ? 'invert(1)'
      : 'none';
    await page.render({ canvasContext: ctx, viewport: vp } as never).promise;
    if (filter === 'replace-color') {
      // map near-white to transparent, then paint a solid background color
      const hex = options.replaceWith ?? '#FFFFFF';
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) {
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    const embedded = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.92));
    const sheet = out.addPage([vp.width / 2, vp.height / 2]);
    sheet.drawImage(embedded, { x: 0, y: 0, width: sheet.getWidth(), height: sheet.getHeight() });
    canvas.width = 0; canvas.height = 0;
    page.cleanup();
  }
  const out2 = await save(out, `${baseName(files[0].name)}-${filter}.pdf`);
  return { files: [out2], message: `Applied ${filter} filter to ${parsed.numPages} pages.`, originalSize: files[0].size, newSize: out2.blob.size };
}

/* ============================================================
 * CONVERT GROUP
 * ============================================================ */

/** PDF → plain text (per-page). */
export async function pdfToTextTool(files: File[], _options: Options): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const chunks: string[] = [];
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const tc = await page.getTextContent();
    chunks.push(`---- Page ${p} ----\n` + tc.items.map(i => ('str' in i ? i.str : '')).join(' '));
    page.cleanup();
  }
  const text = chunks.join('\n\n');
  return {
    files: [{ blob: new Blob([text], { type: txtMime }), fileName: `${baseName(files[0].name)}.txt`, mimeType: txtMime }],
    message: `Extracted ${text.length.toLocaleString()} characters of text.`,
    originalSize: files[0].size,
    newSize: text.length,
  };
}

/** PDF → HTML with selectable text. */
export async function pdfToHtml(files: File[], _options: Options): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body: string[] = [];
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = new Map<number, Array<{ x: number; str: string }>>();
    for (const item of tc.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y)!.push({ x: item.transform[4], str: item.str });
    }
    const html = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, spans]) => {
        const left = Math.min(...spans.map(s => s.x));
        const text = spans.sort((a, b) => a.x - b.x).map(s => s.str).join(' ');
        return `    <div style="position:absolute;left:${left.toFixed(0)}px;top:${(vp.height - y).toFixed(0)}px;white-space:pre-wrap;">${esc(text)}</div>`;
      })
      .join('\n');
    body.push(`  <section class="page" style="width:${vp.width.toFixed(0)}px;height:${vp.height.toFixed(0)}px;position:relative;">\n${html}\n  </section>`);
    page.cleanup();
  }
  const html = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${esc(baseName(files[0].name))}</title>\n<style>body{margin:0;background:#555}section.page{background:#fff;margin:16px auto;box-shadow:0 2px 8px rgba(0,0,0,.4);overflow:hidden}div{font-family:sans-serif;color:#111;font-size:12px}</style>\n</head>\n<body>\n${body.join('\n')}\n</body>\n</html>`;
  return {
    files: [{ blob: new Blob([html], { type: 'text/html;charset=utf-8' }), fileName: `${baseName(files[0].name)}.html`, mimeType: 'text/html;charset=utf-8' }],
    message: `Converted ${parsed.numPages} pages to HTML with positioned selectable text.`,
    originalSize: files[0].size,
    newSize: html.length,
  };
}

/** PDF → CSV/XML of all text lines (spreadsheet-friendly). */
export async function pdfToCsvXml(files: File[], options: Options): Promise<ProcessedResult> {
  const format = options.csvFormat ?? 'csv';
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const rows: Array<{ page: number; line: number; text: string }> = [];
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const tc = await page.getTextContent();
    const ys = new Set<number>();
    for (const item of tc.items) if ('str' in item && item.str.trim()) ys.add(Math.round(item.transform[5]));
    const sorted = [...ys].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i++) {
      const y = sorted[i];
      const lineText = tc.items.filter(it => 'str' in it && Math.abs(it.transform[5] - y) < 1).map(it => ('str' in it ? it.str : '')).join('').trim();
      if (lineText) rows.push({ page: p, line: i + 1, text: lineText });
    }
    page.cleanup();
  }
  let content: string;
  let mime: string;
  let ext: string;
  if (format === 'xml') {
    content = '<?xml version="1.0" encoding="UTF-8"?>\n<document>\n' +
      rows.map(r => `  <line page="${r.page}" number="${r.line}">${r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</line>`).join('\n') +
      '\n</document>';
    mime = 'application/xml'; ext = 'xml';
  } else {
    content = 'page,line,text\n' + rows.map(r => `${r.page},${r.line},"${r.text.replace(/"/g, '""')}"`).join('\n');
    mime = 'text/csv'; ext = 'csv';
  }
  return {
    files: [{ blob: new Blob([content], { type: mime }), fileName: `${baseName(files[0].name)}.${ext}`, mimeType: mime }],
    message: `Extracted ${rows.length} lines as ${format.toUpperCase()}.`,
    originalSize: files[0].size,
    newSize: content.length,
  };
}

/** Text/Markdown/HTML → PDF. */
export async function textToPdf(files: File[], options: Options): Promise<ProcessedResult> {
  const file = files[0];
  const raw = await file.text();
  const isHtml = /\.html?$/i.test(file.name) || /^\s*<!doctype html|<html/i.test(raw);
  const out = await PDFDocument.create();
  const [regular, bold, mono] = await Promise.all([
    out.embedFont(StandardFonts.Helvetica),
    out.embedFont(StandardFonts.HelveticaBold),
    out.embedFont(StandardFonts.Courier),
  ]);
  const font = { regular, bold, mono };
  const size = Number(options.fontSize ?? 12);
  const lineHeight = size * 1.45;
  const margin = 56;
  const width = 595.28, height = 841.89;
  let page = out.addPage([width, height]);
  let cursorY = height - margin;

  const drawLine = (text: string, fontSize: number, bold = false, mono = false) => {
    const f = mono ? font.mono : bold ? font.bold : font.regular;
    if (cursorY < margin) {
      page = out.addPage([width, height]);
      cursorY = height - margin;
    }
    page.drawText(text, { x: margin, y: cursorY, size: fontSize, font: f, color: rgb(0.1, 0.1, 0.1) });
    cursorY -= lineHeight * (fontSize / size);
  };
  const wrap = (text: string, fontSize: number, f: PDFFont, maxWidth: number): string[] => {
    const words = text.split(/(\s+)/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const candidate = line + w;
      if (f.widthOfTextAtSize(candidate, fontSize) > maxWidth && line.trim()) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else line = candidate;
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines;
  };

  const sanitize = (s: string) => s.replace(/[\t\u000b\f\r\u00a0\u2000-\u200b]/g, ' ').replace(/[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g, '');
  const drawWrapped = (text: string, fontSize: number, bold = false, mono = false, indent = 0) => {
    const f = mono ? font.mono : bold ? font.bold : font.regular;
    for (const line of wrap(sanitize(text), fontSize, f, width - margin * 2 - indent)) {
      drawLine(line, fontSize, bold, mono);
    }
  };

  if (isHtml) {
    // Strip tags, keep block structure
    const blocks = raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => `\n@@H${lvl}@@${t.replace(/<[^>]+>/g, '').trim()}\n`)
      .replace(/<(p|div|li|tr)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `\n${t.replace(/<[^>]+>/g, ' ').trim()}\n`)
      .replace(/<[^>]+>/g, ' ');
    for (const block of blocks.split('\n')) {
      const t = block.trim();
      if (!t) continue;
      const heading = /^@@H([1-6])@@(.*)$/.exec(t);
      if (heading) {
        drawWrapped(heading[2], Math.max(12, 24 - Number(heading[1]) * 2), true);
      } else drawWrapped(t, size);
    }
  } else {
    // Markdown-lite: # headings, - lists, `code`, **bold** ignored for font mixing simplicity
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.trim()) { cursorY -= lineHeight * 0.5; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { drawWrapped(h[2], Math.max(12, 24 - h[1].length * 2), true); continue; }
      const list = /^[-*+]\s+(.*)$/.exec(line);
      if (list) { drawWrapped('• ' + list[1], size); continue; }
      const code = /^```/.test(line);
      if (code) continue;
      drawWrapped(line, /^ {4,}/.test(rawLine) ? size - 1 : size, false, /^ {4,}/.test(rawLine));
    }
  }
  const out2 = await save(out, `${baseName(file.name)}.pdf`);
  return { files: [out2], message: `Created a ${out.getPageCount()}-page PDF from ${isHtml ? 'HTML' : 'text/markdown'}.`, originalSize: file.size, newSize: out2.blob.size };
}

/* ============================================================
 * SECURITY / SANITIZE
 * ============================================================ */

/** Sanitize: strip JavaScript, metadata, links and embedded files. */
export async function sanitizePdf(files: File[], options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const catalog = doc.catalog;
  let removed = 0;
  if (options.removeJs !== 'false') {
    if (catalog.get(PDFName.of('Names'))) { catalog.delete(PDFName.of('Names')); removed++; }
    if (catalog.get(PDFName.of('JavaScript'))) { catalog.delete(PDFName.of('JavaScript')); removed++; }
    if (catalog.get(PDFName.of('OpenAction'))) { catalog.delete(PDFName.of('OpenAction')); removed++; }
    if (catalog.get(PDFName.of('AA'))) { catalog.delete(PDFName.of('AA')); removed++; }
  }
  if (options.removeMetadata !== 'false') {
    if (catalog.get(PDFName.of('Metadata'))) { catalog.delete(PDFName.of('Metadata')); removed++; }
  }
  if (options.removeEmbedded !== 'false') {
    const namesRef = catalog.get(PDFName.of('Names'));
    const names = namesRef ? doc.context.lookupMaybe(namesRef, PDFDict) : undefined;
    if (names && names.delete(PDFName.of('EmbeddedFiles'))) removed++;
  }
  if (options.removeLinks !== 'false') {
    for (const page of doc.getPages()) {
      const annotsRef = page.node.Annots();
      const annots = annotsRef ? doc.context.lookupMaybe(annotsRef, PDFArray) : undefined;
      if (annots) {
        const kept = [];
        for (const ref of annots.asArray()) {
          const a = doc.context.lookupMaybe(ref, PDFDict);
          if (!a) { kept.push(ref); continue; }
          const st = a.get(PDFName.of('Subtype'));
          const isJsAction = !!a.get(PDFName.of('AA'));
          if (st !== PDFName.of('Link') && !isJsAction) kept.push(ref);
          else removed++;
        }
        if (kept.length !== annots.size()) page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
      }
      if (page.node.get(PDFName.of('AA'))) page.node.delete(PDFName.of('AA'));
      if (options.removeMetadata !== 'false' && page.node.get(PDFName.of('Metadata'))) { page.node.delete(PDFName.of('Metadata')); removed++; }
    }
  }
  const out = await save(doc, `${baseName(files[0].name)}-sanitized.pdf`);
  return { files: [out], message: `Sanitized the PDF — removed ${removed} JavaScript/metadata/link/embedded-file items.`, originalSize: files[0].size, newSize: out.blob.size };
}

/* ============================================================
 * MISC GROUP
 * ============================================================ */

/** Extract all embedded raster images from the PDF. */
export async function extractImages(files: File[]): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const out: ProcessedFile[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    try {
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject && ops.fnArray[i] !== pdfjsLib.OPS.paintInlineImageXObject) continue;
        const name = ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject ? null : String(ops.argsArray[i][0]);
        const dedupeKey = `${p}:${name}`;
        if (name && seen.has(name)) continue;
        if (name) seen.add(name);
        try {
          const img: any = name ? await page.objs.get(name) : ops.argsArray[i][0];
          const canvas = document.createElement('canvas');
          if (img?.bitmap) {
            canvas.width = img.bitmap.width; canvas.height = img.bitmap.height;
            canvas.getContext('2d')!.drawImage(img.bitmap, 0, 0);
          } else if (img?.data) {
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            const raw: Uint8Array = img.data;
            const rgba = new Uint8ClampedArray(img.width * img.height * 4);
            const comps = raw.length / (img.width * img.height);
            for (let px = 0; px < img.width * img.height; px++) {
              if (comps >= 4) { rgba[px * 4] = raw[px * 4]; rgba[px * 4 + 1] = raw[px * 4 + 1]; rgba[px * 4 + 2] = raw[px * 4 + 2]; rgba[px * 4 + 3] = raw[px * 4 + 3]; }
              else if (comps === 3) { rgba[px * 4] = raw[px * 3]; rgba[px * 4 + 1] = raw[px * 3 + 1]; rgba[px * 4 + 2] = raw[px * 3 + 2]; rgba[px * 4 + 3] = 255; }
              else { rgba[px * 4] = rgba[px * 4 + 1] = rgba[px * 4 + 2] = raw[px]; rgba[px * 4 + 3] = 255; }
            }
            ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
          } else continue;
          const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
          if (blob && blob.size > 1024) out.push({ blob, fileName: `page${p}-image-${out.length + 1}.png`, mimeType: 'image/png' });
        } catch { /* image object unavailable — skip */ }
        void dedupeKey;
      }
    } finally {
      page.cleanup();
    }
  }
  if (!out.length) throw new Error('No embedded raster images were found in this PDF (it may be pure text/vector art).');
  return zipResult(out, `Extracted ${out.length} embedded images.`, files[0].size);
}

/** Remove every raster image XObject from the PDF (text/vector kept). */
export async function removeImages(files: File[], _options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  let removed = 0;
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    if (!res) continue;
    const xobj = doc.context.lookup(res.get(PDFName.of('XObject')), PDFDict);
    if (!xobj) continue;
    for (const [key, ref] of [...xobj.entries()]) {
      const sm = doc.context.lookup(ref);
      if (sm instanceof PDFStream) {
        const subtype = sm.dict.get(PDFName.of('Subtype'));
        if (subtype === PDFName.of('Image')) { xobj.delete(key); removed++; }
      }
    }
  }
  const out = await save(doc, `${baseName(files[0].name)}-no-images.pdf`);
  return { files: [out], message: `Removed ${removed} images; all text and vector content kept.`, originalSize: files[0].size, newSize: out.blob.size };
}

/** Remove blank pages (near-white pages detected by pixel sampling). */
export async function removeBlankPages(files: File[], _options: Options): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const keep: number[] = [];
  for (let p = 1; p <= parsed.numPages; p++) {
    const page = await parsed.getPage(p);
    const vp = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, vp.width | 0); canvas.height = Math.max(1, vp.height | 0);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas, canvasContext: ctx, viewport: vp } as never).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) inked++;
    }
    if (inked / (px.length / 4) > 0.001) keep.push(p);
    page.cleanup();
  }
  if (!keep.length) throw new Error('Every page looks blank — nothing kept. If this is a scanned PDF, run OCR first.');
  if (keep.length === parsed.numPages) {
    return { files: [{ blob: files[0].slice(0), fileName: files[0].name, mimeType: pdfMime }], message: 'No blank pages found — file unchanged.', originalSize: files[0].size, newSize: files[0].size };
  }
  const doc = await PDFDocument.create();
  const src = await load(files[0]);
  const pages = await doc.copyPages(src, keep.map(n => n - 1));
  pages.forEach(pg => doc.addPage(pg));
  const out = await save(doc, `${baseName(files[0].name)}-no-blanks.pdf`);
  return { files: [out], message: `Removed ${parsed.numPages - keep.length} blank page(s); kept ${keep.length}.`, originalSize: files[0].size, newSize: out.blob.size };
}

/** Rename the PDF based on its first text line (Stirling auto-rename). */
export async function autoRenamePdf(files: File[], _options: Options): Promise<ProcessedResult> {
  const data = new Uint8Array(await files[0].arrayBuffer());
  const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  let title = '';
  const page = await parsed.getPage(1);
  const tc = await page.getTextContent();
  for (const item of tc.items) {
    const str = 'str' in item ? item.str.trim() : '';
    if (str.length >= 3) { title = str; break; }
  }
  page.cleanup();
  const safe = (title || baseName(files[0].name)).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'document';
  const out = { blob: files[0].slice(0), fileName: `${safe}.pdf`, mimeType: pdfMime };
  return { files: [out], message: `Renamed to "${safe}.pdf" from the first line of text.`, originalSize: files[0].size, newSize: files[0].size };
}

/** Compare the text of two PDFs and produce a diff report. */
export async function comparePdfs(files: File[], _options: Options): Promise<ProcessedResult> {
  if (files.length !== 2) throw new Error('Select exactly two PDF files to compare.');
  const textOf = async (file: File): Promise<string[]> => {
    const data = new Uint8Array(await file.arrayBuffer());
    const parsed = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const lines: string[] = [];
    for (let p = 1; p <= parsed.numPages; p++) {
      const page = await parsed.getPage(p);
      const tc = await page.getTextContent();
      lines.push(`---- Page ${p} ----`);
      lines.push(tc.items.map(i => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim());
      page.cleanup();
    }
    return lines.filter(Boolean);
  };
  const [aLines, bLines] = [await textOf(files[0]), await textOf(files[1])];
  const setB = new Set(bLines.map(l => l.trim()).filter(l => l && !l.startsWith('----')));
  const setA = new Set(aLines.map(l => l.trim()).filter(l => l && !l.startsWith('----')));
  const onlyA = [...setA].filter(l => !setB.has(l));
  const onlyB = [...setB].filter(l => !setA.has(l));
  const report = [`PDF comparison report`, `A: ${files[0].name} (${aLines.filter(l => l.startsWith('----')).length} pages)`, `B: ${files[1].name} (${bLines.filter(l => l.startsWith('----')).length} pages)`, '', `Lines only in A (${onlyA.length}):`, ...onlyA.map(l => `  - ${l}`), '', `Lines only in B (${onlyB.length}):`, ...onlyB.map(l => `  + ${l}`)].join('\n');
  const identical = onlyA.length === 0 && onlyB.length === 0;
  return {
    files: [{ blob: new Blob([report], { type: txtMime }), fileName: `compare-${baseName(files[0].name)}-vs-${baseName(files[1].name)}.txt`, mimeType: txtMime }],
    message: identical ? 'The two PDFs have identical text content.' : `Found ${onlyA.length} line(s) only in A and ${onlyB.length} only in B.`,
    originalSize: files[0].size + files[1].size,
    newSize: report.length,
  };
}

/** Stamp text or an image onto pages at a chosen position (Stirling stamp). */
export async function stampPdf(files: File[], options: Options): Promise<ProcessedResult> {
  const doc = await load(files[0]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const [ix, iy] = (options.position || '1-1').split('-').map(v => Number(v) || 1);
  const margin = 30;
  const color = options.color === 'red' ? rgb(0.8, 0.1, 0.1) : options.color === 'blue' ? rgb(0.1, 0.25, 0.7) : rgb(0.1, 0.1, 0.1);
  let stamped = 0;
  const imagePart = options.stampImage && options.stampImage !== 'none' ? files.find(f => f.type.startsWith('image/')) : undefined;
  let embedded: Awaited<ReturnType<typeof doc.embedPng>> | undefined;
  if (imagePart) embedded = imagePart.type === 'image/png' ? await doc.embedPng(await imagePart.arrayBuffer()) : await doc.embedJpg(await imagePart.arrayBuffer());
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const x = ix === 0 ? margin : ix === 1 ? width / 2 : width - margin;
    const y = iy === 0 ? margin : iy === 1 ? height / 2 : height - margin;
    const align = ix === 1 ? 'center' : ix === 2 ? 'right' : 'left';
    if (embedded) {
      const scale = Math.min(140 / embedded.width, 140 / embedded.height, 1);
      const w = embedded.width * scale, h = embedded.height * scale;
      page.drawImage(embedded, { x: align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, y: iy === 0 ? y : y - h, width: w, height: h, opacity: 0.9 });
    } else {
      const text = options.stampText || 'STAMP';
      const size = 22;
      const tw = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x, y: iy === 0 ? y : y - size, size, font, color, opacity: 0.85, rotate: degrees(Number(options.rotation ?? 0)) });
    }
    stamped++;
    if (options.pages === 'first') break;
  }
  const out = await save(doc, `${baseName(files[0].name)}-stamped.pdf`);
  return { files: [out], message: `Stamped ${stamped} page(s).`, originalSize: files[0].size, newSize: out.blob.size };
}
