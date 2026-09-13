import { PDFDocument, PDFImage, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';
import { PDFDocument as SecurePdfDocument } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth/mammoth.browser';
import { createWorker as createOcrWorker } from 'tesseract.js';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
  verifyReport?: VerifyReport;
}

type Options = Record<string, string>;

const pdfMime = 'application/pdf';
const zipMime = 'application/zip';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function bytesToBlobPart(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function downloadProcessedFile(file: ProcessedFile) {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function baseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '') || 'document';
}

function dataUrlToFile(dataUrl: string, name = 'image') {
  const comma = dataUrl.indexOf(',');
  const mime = /data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}



function totalSize(files: File[]) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function output(fileName: string, blob: Blob, message: string, files: File[]): ProcessedResult {
  return {
    files: [{ blob, fileName, mimeType: blob.type || 'application/octet-stream' }],
    message,
    originalSize: totalSize(files),
    newSize: blob.size,
  };
}

function ensureFiles(files: File[]) {
  if (!files.length) throw new Error('Please upload at least one file.');
}

async function loadPdf(file: File) {
  return PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
}

/** Render every page of a PDF to JPEG blobs via pdf.js (used by compress + unlock). */
async function renderPdfToJpegs(file: File, scale: number, quality: number, password = '') {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...(password ? { password } : {}) });
  const pdf = await loadingTask.promise;
  const entries: ProcessedFile[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is not available in this browser.');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport } as never).promise;
      entries.push({ blob: await canvasToBlob(canvas, 'image/jpeg', quality), fileName: `${baseName(file.name)}-page-${i}.jpg`, mimeType: 'image/jpeg' });
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return entries;
}

/** Rebuild a PDF from rendered JPEG pages, keeping the smaller of original vs rebuilt. */
async function rebuildPdfFromRenders(files: File[], file: File, scale: number, quality: number, suffix: string, verb: string) {
  const entries = await renderPdfToJpegs(file, scale, quality);
  if (!entries.length) throw new Error('This PDF has no pages to process.');
  const doc = await PDFDocument.create();
  for (const entry of entries) {
    const image = await doc.embedJpg(await entry.blob.arrayBuffer());
    const { width, height } = image.scale(1);
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await doc.save({ useObjectStreams: true });
  const rebuilt = new Blob([bytesToBlobPart(bytes)], { type: pdfMime });
  if (rebuilt.size < file.size) {
    return output(`${baseName(file.name)}-${suffix}.pdf`, rebuilt, `${verb} the PDF: ${formatSize(file.size)} → ${formatSize(rebuilt.size)} (${Math.round((1 - rebuilt.size / file.size) * 100)}% smaller).`, files);
  }
  const original = await loadPdf(file);
  const saved = await original.save({ useObjectStreams: true });
  const resaved = new Blob([bytesToBlobPart(saved)], { type: pdfMime });
  return output(`${baseName(file.name)}-${suffix}.pdf`, resaved.size < file.size ? resaved : new Blob([await file.arrayBuffer()], { type: pdfMime }), `This PDF is already well optimized — kept ${resaved.size < file.size ? `a structurally resaved copy (${formatSize(resaved.size)})` : 'the original file'} at ${formatSize(Math.min(file.size, resaved.size))}. No meaningful compression was possible without visible quality loss.`, files);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function savePdf(doc: PDFDocument, fileName: string, message: string, files: File[]) {
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return output(fileName, new Blob([bytesToBlobPart(bytes)], { type: pdfMime }), message, files);
}

async function copyPages(sourceFile: File, pageIndexes?: number[]) {
  const source = await loadPdf(sourceFile);
  const target = await PDFDocument.create();
  const indexes = pageIndexes ?? source.getPageIndices();
  const copied = await target.copyPages(source, indexes);
  copied.forEach(page => target.addPage(page));
  return target;
}

function parsePageList(input: string | undefined, pageCount: number, fallback: number[]) {
  if (!input?.trim()) return fallback.filter(i => i >= 0 && i < pageCount);
  const result = new Set<number>();
  for (const part of input.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawStart, rawEnd] = trimmed.split('-').map(v => Number.parseInt(v.trim(), 10));
    if (!Number.isFinite(rawStart)) continue;
    const start = Math.max(1, rawStart);
    const end = Math.min(pageCount, Number.isFinite(rawEnd) ? rawEnd : rawStart);
    for (let page = start; page <= end; page += 1) result.add(page - 1);
  }
  return [...result].sort((a, b) => a - b);
}

function wrapText(text: string, maxChars = 82) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const HEADING_SIZES: Record<string, number> = { 1: 20, 2: 17, 3: 15, 4: 13, 5: 12, 6: 11 };

type FontSet = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };

function fontFor(fonts: FontSet, bold: boolean, italic: boolean) {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

/** Strip characters the standard PDF fonts cannot encode (e.g. CJK), keeping common typographic marks. */
function pdfSafeText(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\u0000-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2022\u2026]/g, '');
}

async function imageToPngDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Convert document HTML (from Word/Excel/PowerPoint converters) into a typeset PDF with real headings, tables, lists and images. */
async function htmlToPdf(html: string, title: string, sourceFiles: File[]) {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-10000px';
  container.innerHTML = html;
  document.body.appendChild(container);

  try {
    const doc = await PDFDocument.create();
    const fonts: FontSet = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      italic: await doc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const pageWidth = 595;
    const pageHeight = 842;
    const marginX = 56;
    const marginTop = 64;
    const marginBottom = 56;
    const contentWidth = pageWidth - marginX * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - marginTop;

    const ensureSpace = (needed: number) => {
      if (y - needed < marginBottom) {
        page = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - marginTop;
      }
    };

    const drawImageElement = async (img: Element) => {
      const src = img.getAttribute('src');
      if (!src) return;
      const dataUrl = await imageToPngDataUrl(src);
      if (!dataUrl) return;
      const bytes = await (await fetch(dataUrl)).arrayBuffer();
      const image = dataUrl.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const scaled = image.scaleToFit(contentWidth, 260);
      ensureSpace(scaled.height + 16);
      page.drawImage(image, { x: marginX + (contentWidth - scaled.width) / 2, y: y - scaled.height, width: scaled.width, height: scaled.height });
      y -= scaled.height + 16;
    };

    const wrapByWidth = (text: string, font: PDFFont, size: number, maxWidth: number) => {
      const words = text.split(/\s+/).filter(Boolean);
      if (!words.length) return [''];
      const lines: string[] = [];
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
      return lines;
    };

    const drawTable = async (table: Element) => {
      const rows = Array.from(table.querySelectorAll('tr'))
        .map(row => Array.from(row.querySelectorAll('th,td')).map(cell => pdfSafeText((cell.textContent ?? '').replace(/\s+/g, ' ').trim())))
        .filter(row => row.length);
      if (!rows.length) return;
      const columns = Math.max(...rows.map(row => row.length));
      const size = 8.5;
      const padding = 4;
      const natural = Array.from({ length: columns }, (_, column) =>
        Math.max(...rows.map(row => fonts.bold.widthOfTextAtSize(row[column] || ' ', size))) + padding * 2);
      const totalNatural = natural.reduce((sum, width) => sum + width, 0);
      const widths = totalNatural > contentWidth
        ? natural.map(width => (width / totalNatural) * contentWidth)
        : natural.map((width, index) => (index === columns - 1 ? contentWidth - (totalNatural - width) : width));
      const rowHeights = rows.map(row => {
        let maxHeight = size + padding * 2;
        row.forEach((cell, index) => {
          const lines = wrapByWidth(cell, fonts.regular, size, Math.max(10, widths[index] - padding * 2)).length;
          maxHeight = Math.max(maxHeight, lines * size * 1.25 + padding * 2);
        });
        return maxHeight;
      });

      rows.forEach((row, rowIndex) => {
        const rowHeight = rowHeights[rowIndex];
        if (y - rowHeight < marginBottom) {
          page = doc.addPage([pageWidth, pageHeight]);
          y = pageHeight - marginTop;
        }
        const header = rowIndex === 0;
        const font = header ? fonts.bold : fonts.regular;
        if (header) page.drawRectangle({ x: marginX, y: y - rowHeight, width: contentWidth, height: rowHeight, color: rgb(0.94, 0.95, 0.97) });
        let x = marginX;
        row.forEach((cell, columnIndex) => {
          const cellWidth = widths[columnIndex];
          const lines = wrapByWidth(cell, font, size, Math.max(10, cellWidth - padding * 2));
          lines.forEach((lineText, lineIndex) => {
            page.drawText(lineText, { x: x + padding, y: y - padding - size - lineIndex * size * 1.25, size, font, color: rgb(0.16, 0.18, 0.22) });
          });
          x += cellWidth;
        });
        let gridX = marginX;
        for (let column = 0; column <= columns; column += 1) {
          page.drawLine({ start: { x: gridX, y }, end: { x: gridX, y: y - rowHeight }, thickness: 0.5, color: rgb(0.8, 0.82, 0.85) });
          if (column < columns) gridX += widths[column];
        }
        page.drawLine({ start: { x: marginX, y }, end: { x: marginX + contentWidth, y }, thickness: 0.5, color: rgb(0.8, 0.82, 0.85) });
        page.drawLine({ start: { x: marginX, y: y - rowHeight }, end: { x: marginX + contentWidth, y: y - rowHeight }, thickness: 0.5, color: rgb(0.8, 0.82, 0.85) });
        y -= rowHeight;
      });
      y -= 10;
    };

    const drawBlockRuns = async (element: Element, size: number, opts: { indent?: number; bullet?: string; forceBold?: boolean } = {}) => {
      const indent = opts.indent ?? 0;
      const lineHeight = size * 1.45;
      ensureSpace(lineHeight);
      if (opts.bullet) {
        page.drawText(opts.bullet, { x: marginX + Math.max(0, indent - 12), y: y - size, size: Math.min(size, 10), font: fonts.regular, color: rgb(0.16, 0.18, 0.22) });
      }
      const spaceWidth = fonts.regular.widthOfTextAtSize(' ', size);
      let x = marginX + indent;
      let lineStarted = false;
      const nextLine = () => {
        y -= lineHeight;
        ensureSpace(lineHeight);
        x = marginX + indent;
        lineStarted = false;
      };
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName.toLowerCase() === 'img') {
          await drawImageElement(child as Element);
          continue;
        }
        const runs: Array<{ text: string; bold: boolean; italic: boolean }> = [];
        const walkRuns = (node: Node, bold: boolean, italic: boolean) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = pdfSafeText(node.textContent?.replace(/\s+/g, ' ') ?? '');
            if (text) runs.push({ text, bold, italic });
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = (node as Element).tagName.toLowerCase();
          if (tag === 'br') { runs.push({ text: '\n', bold, italic }); return; }
          const nextBold = bold || tag === 'b' || tag === 'strong';
          const nextItalic = italic || tag === 'i' || tag === 'em';
          node.childNodes.forEach(grand => walkRuns(grand, nextBold, nextItalic));
        };
        walkRuns(child, !!opts.forceBold, false);
        for (const run of runs) {
          const font = fontFor(fonts, run.bold, run.italic);
          for (const [segmentIndex, segment] of run.text.split('\n').entries()) {
            if (segmentIndex > 0) nextLine();
            for (const word of segment.split(/(\s+)/)) {
              if (!word) continue;
              const isSpace = /^\s+$/.test(word);
              const width = font.widthOfTextAtSize(isSpace ? ' ' : word, size);
              if (!isSpace && lineStarted && x - marginX + width > contentWidth) nextLine();
              if (!(isSpace && !lineStarted)) {
                page.drawText(isSpace ? ' ' : word, { x, y: y - size, size, font, color: rgb(0.16, 0.18, 0.22) });
                x += isSpace ? spaceWidth : width;
                lineStarted = true;
              }
            }
          }
        }
      }
      y -= lineHeight;
    };

    const walk = async (element: Element, listDepth = 0) => {
      for (const child of Array.from(element.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'p') {
          if (!(child.textContent ?? '').trim() && !child.querySelector('img')) continue;
          await drawBlockRuns(child, 11);
          y -= 6;
        } else if (/^h[1-6]$/.test(tag)) {
          const size = HEADING_SIZES[tag[1]] ?? 12;
          await drawBlockRuns(child, size, { forceBold: true });
          y -= 8;
        } else if (tag === 'ul' || tag === 'ol') {
          let itemNumber = 1;
          for (const li of Array.from(child.children)) {
            if (li.tagName.toLowerCase() !== 'li') continue;
            const nested = Array.from(li.children).filter(n => ['ul', 'ol'].includes(n.tagName.toLowerCase()));
            nested.forEach(n => n.remove());
            await drawBlockRuns(li, 11, { indent: 14 + listDepth * 14, bullet: tag === 'ul' ? '•' : `${itemNumber}.` });
            for (const nestedList of nested) await walk(nestedList, listDepth + 1);
            itemNumber += 1;
          }
          y -= 4;
        } else if (tag === 'table') {
          await drawTable(child);
        } else if (tag === 'img') {
          await drawImageElement(child);
        } else if (['div', 'section', 'article', 'blockquote', 'pre'].includes(tag)) {
          await walk(child, listDepth);
        }
      }
    };

    await walk(container);

    const pageCount = doc.getPageCount();
    return savePdf(doc, `${safeFileStem(title)}.pdf`, `Converted "${title}" into a ${pageCount}-page PDF with headings, paragraphs, tables, lists and images rendered from the document structure. Exact Word layout is not replicated.`, sourceFiles);
  } finally {
    container.remove();
  }
}

function safeFileStem(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'processed-file';
}

/** Extract text with paragraph breaks inferred from baseline gaps (heading/keyword callers rely on it). */
async function extractPdfText(file: File) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter(item => 'str' in item && item.str.trim());
    if (!items.length) {
      pages.push(`Page ${i}\n`);
      continue;
    }
    const paragraphs: string[] = [];
    let current = '';
    let lastY: number | null = null;
    let lastHeight = 10;
    for (const item of items) {
      if (!('str' in item)) continue;
      const transform = item.transform as number[];
      const y = Math.round(transform[5] ?? 0);
      lastHeight = Math.abs(transform[3] ?? 10);
      const gap = lastY === null ? 0 : Math.abs(lastY - y);
      if (lastY !== null && gap > lastHeight * 1.9) {
        if (current.trim()) paragraphs.push(current.trim());
        current = item.str;
      } else {
        const needsSpace = current.length > 0 && !/\s$/.test(current) && !/^\s/.test(item.str);
        current += (needsSpace ? ' ' : '') + item.str;
      }
      lastY = y;
    }
    if (current.trim()) paragraphs.push(current.trim());
    pages.push(`Page ${i}\n${paragraphs.join('\n\n')}`);
  }
  return pages.join('\n\n');
}

async function zipFiles(name: string, entries: ProcessedFile[], originalFiles: File[], message: string) {
  const zip = new JSZip();
  entries.forEach(entry => zip.file(entry.fileName, entry.blob));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return output(name, new Blob([blob], { type: zipMime }), message, originalFiles);
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality = 0.88) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to render image output.'));
    }, mimeType, quality);
  });
}

async function pdfToImages(file: File, mimeType: 'image/jpeg' | 'image/png') {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const entries: ProcessedFile[] = [];

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available in this browser.');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport } as never).promise;
    const blob = await canvasToBlob(canvas, mimeType);
    entries.push({ blob, fileName: `${baseName(file.name)}-page-${i}.${extension}`, mimeType });
  }

  if (entries.length === 1) {
    return output(entries[0].fileName, entries[0].blob, `Rendered 1 PDF page as ${extension.toUpperCase()}.`, [file]);
  }
  return zipFiles(`${baseName(file.name)}-${extension}-pages.zip`, entries, [file], `Rendered ${entries.length} PDF pages as ${extension.toUpperCase()} files.`);
}

async function imagesToPdf(files: File[]) {
  const doc = await PDFDocument.create();
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const isPng = file.type.includes('png') || file.name.toLowerCase().endsWith('.png');
    const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const { width, height } = image.scale(1);
    const page = doc.addPage([width, height]);
    if (isPng) page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return savePdf(doc, `${baseName(files[0].name)}.pdf`, `Created a PDF with ${files.length} image page${files.length > 1 ? 's' : ''}, preserving original order and dimensions.`, files);
}

async function compressImages(files: File[], options: Options) {
  const quality = { low: 0.86, medium: 0.65, high: 0.42 }[options.compression ?? 'medium'] ?? 0.65;
  const maxSide = { low: 2200, medium: 1800, high: 1400 }[options.compression ?? 'medium'] ?? 1800;
  const entries: ProcessedFile[] = [];

  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Could not read ${file.name} as an image.`));
        img.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is not available in this browser.');
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      entries.push({ blob, fileName: `${baseName(file.name)}-compressed.jpg`, mimeType: 'image/jpeg' });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  if (entries.length === 1) return output(entries[0].fileName, entries[0].blob, 'Compressed the uploaded image.', files);
  return zipFiles('compressed-images.zip', entries, files, `Compressed ${entries.length} images.`);
}

async function mergePdfs(files: File[]) {
  const merged = await PDFDocument.create();
  for (const file of files) {
    const source = await loadPdf(file);
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach(page => merged.addPage(page));
  }
  return savePdf(merged, 'merged.pdf', `Merged ${files.length} PDFs into one document.`, files);
}

async function splitPdf(file: File, options: Options) {
  const source = await loadPdf(file);
  const pageCount = source.getPageCount();
  const rangeText = (options.ranges ?? '').trim();
  const entries: ProcessedFile[] = [];

  if (rangeText) {
    const groups = parsePageList(rangeText, pageCount, []);
    if (!groups.length) throw new Error('No valid page ranges found. Use formats like 1-3,5.');
    for (const part of rangeText.split(',')) {
      const indexes = parsePageList(part, pageCount, []);
      if (!indexes.length) continue;
      const doc = await copyPages(file, indexes);
      const label = indexes.length === 1 ? `page-${indexes[0] + 1}` : `pages-${indexes[0] + 1}-${indexes[indexes.length - 1] + 1}`;
      const bytes = await doc.save({ useObjectStreams: true });
      entries.push({ blob: new Blob([bytesToBlobPart(bytes)], { type: pdfMime }), fileName: `${baseName(file.name)}-${label}.pdf`, mimeType: pdfMime });
    }
    if (!entries.length) throw new Error('No valid page ranges found. Use formats like 1-3,5.');
    if (entries.length === 1) {
      return output(entries[0].fileName, entries[0].blob, `Split off ${entries[0].fileName.includes('page-') ? 'the requested pages' : 'the requested range'} into a new PDF.`, [file]);
    }
    return zipFiles(`${baseName(file.name)}-split.zip`, entries, [file], `Split ${file.name} into ${entries.length} PDF files by your ranges.`);
  }

  for (const index of source.getPageIndices()) {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(source, [index]);
    out.addPage(page);
    const bytes = await out.save({ useObjectStreams: true });
    entries.push({
      blob: new Blob([bytesToBlobPart(bytes)], { type: pdfMime }),
      fileName: `${baseName(file.name)}-page-${index + 1}.pdf`,
      mimeType: pdfMime,
    });
  }
  return zipFiles(`${baseName(file.name)}-split.zip`, entries, [file], `Split ${file.name} into ${entries.length} single-page PDF files.`);
}

async function rotatePdf(file: File, options: Options) {
  const doc = await loadPdf(file);
  const rotation = Number.parseInt(options.rotation ?? '90', 10) || 90;
  const pageCount = doc.getPageCount();
  const targets = parsePageList(options.pages, pageCount, doc.getPageIndices());
  if (!targets.length) throw new Error('No valid pages selected for rotation.');
  const pages = doc.getPages();
  targets.forEach(index => {
    const current = pages[index].getRotation().angle ?? 0;
    pages[index].setRotation(degrees((current + rotation) % 360));
  });
  const scope = targets.length === pageCount ? 'every page' : `page${targets.length === 1 ? '' : 's'} ${targets.map(i => i + 1).join(', ')}`;
  return savePdf(doc, `${baseName(file.name)}-rotated.pdf`, `Rotated ${scope} by ${rotation} degrees.`, [file]);
}

async function deletePages(file: File, options: Options) {
  const source = await loadPdf(file);
  const deleteIndexes = new Set(parsePageList(options.pages, source.getPageCount(), [0]));
  const keepIndexes = source.getPageIndices().filter(index => !deleteIndexes.has(index));
  if (!keepIndexes.length) throw new Error('Delete selection would remove every page.');
  const doc = await copyPages(file, keepIndexes);
  return savePdf(doc, `${baseName(file.name)}-pages-removed.pdf`, `Removed ${deleteIndexes.size} page${deleteIndexes.size === 1 ? '' : 's'}.`, [file]);
}

async function extractPages(file: File, options: Options) {
  const source = await loadPdf(file);
  const indexes = parsePageList(options.pages, source.getPageCount(), [0]);
  if (!indexes.length) throw new Error('No valid pages selected.');
  const doc = await copyPages(file, indexes);
  return savePdf(doc, `${baseName(file.name)}-extracted.pdf`, `Extracted ${indexes.length} page${indexes.length === 1 ? '' : 's'}.`, [file]);
}

async function rearrangePages(file: File, options: Options) {
  const source = await loadPdf(file);
  const customOrder = parsePageList(options.pageOrder, source.getPageCount(), []);
  const indexes = customOrder.length ? customOrder : source.getPageIndices().reverse();
  const doc = await copyPages(file, indexes);
  return savePdf(doc, `${baseName(file.name)}-rearranged.pdf`, customOrder.length ? 'Rearranged pages using your order.' : 'Rearranged pages in reverse order.', [file]);
}

async function addText(file: File, options: Options) {
  const doc = await loadPdf(file);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = options.text || (options.watermarkText ?? 'My PDF Desk');
  doc.getPages().forEach(page => {
    const { width, height } = page.getSize();
    page.drawText(text, {
      x: 48,
      y: height - 72,
      size: 18,
      font,
      color: rgb(0.1, 0.32, 0.8),
      maxWidth: width - 96,
    });
  });
  return savePdf(doc, `${baseName(file.name)}-text.pdf`, 'Added text to the PDF.', [file]);
}

async function watermarkPdf(file: File, options: Options) {
  const doc = await loadPdf(file);
  const pageCount = doc.getPageCount();
  const targets = parsePageList(options.pages, pageCount, doc.getPageIndices());
  if (!targets.length) throw new Error('No valid pages selected for the watermark.');
  const sizePct = Math.min(120, Math.max(4, Number.parseInt(options.watermarkSize ?? '16', 10) || 16)) / 100;
  const opacity = Math.max(0.05, Math.min(1, (Number.parseInt(options.opacity ?? '30', 10) || 30) / 100));
  const rotation = Number.parseInt(options.watermarkRotation ?? '-45', 10);
  const label = options.watermarkText?.trim();
  const imageFile = options.watermarkImage?.startsWith('data:image/') ? dataUrlToFile(options.watermarkImage, 'watermark') : undefined;

  let image: PDFImage | undefined;
  if (imageFile) {
    const bytes = await imageFile.arrayBuffer();
    image = imageFile.type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  }
  const font = label || !image ? await doc.embedFont(StandardFonts.HelveticaBold) : undefined;

  for (const index of targets) {
    const page = doc.getPage(index);
    const { width, height } = page.getSize();
    if (image) {
      const targetWidth = Math.max(24, width * sizePct);
      const scaled = image.scaleToFit(targetWidth, targetWidth * 0.75);
      page.drawImage(image, {
        x: (width - scaled.width) / 2,
        y: (height - scaled.height) / 2,
        width: scaled.width,
        height: scaled.height,
        opacity,
        rotate: degrees(rotation),
      });
    } else {
      const text = label || 'CONFIDENTIAL';
      let size = width * sizePct;
      const maxTextWidth = width * 0.92;
      const naturalWidth = font!.widthOfTextAtSize(text, size);
      if (naturalWidth > maxTextWidth) size *= maxTextWidth / naturalWidth;
      size = Math.max(6, size);
      const textWidth = font!.widthOfTextAtSize(text, size);
      const rad = (rotation * Math.PI) / 180;
      page.drawText(text, {
        x: width / 2 - (textWidth / 2) * Math.cos(rad),
        y: height / 2 - (textWidth / 2) * Math.sin(rad),
        size,
        font: font!,
        color: rgb(0.75, 0.12, 0.12),
        opacity,
        rotate: degrees(rotation),
      });
    }
  }
  const scope = targets.length === pageCount ? 'all pages' : `page${targets.length === 1 ? '' : 's'} ${targets.map(i => i + 1).join(', ')}`;
  const kind = image ? 'image' : 'text';
  return savePdf(doc, `${baseName(file.name)}-watermarked.pdf`, `Added a ${kind} watermark to ${scope} of the PDF.`, [file]);
}

async function pageNumberPdf(file: File, options: Options) {
  const doc = await loadPdf(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const format = options.numberFormat ?? 'n-of-total';
  const position = options.numberPosition ?? 'bottom-center';
  const sizePreset = options.numberSize ?? 'medium';
  const pages = doc.getPages();

  pages.forEach((page, index) => {
    const { width, height } = page.getSize();
    const number = index + 1;
    const text = format === 'n' ? `${number}` : format === 'page-n' ? `Page ${number}` : `${number} / ${pages.length}`;
    // Readable base size scaled to the page: ~12pt on A4/Letter, smaller on pocket pages.
    const baseSize = { small: 10, medium: 13, large: 16 }[sizePreset] ?? 13;
    const size = Math.min(baseSize, Math.max(9, Math.min(width, height) / 30));
    const margin = Math.max(16, size * 1.4);
    const textWidth = font.widthOfTextAtSize(text, size);
    const x = position.endsWith('center')
      ? width / 2 - textWidth / 2
      : position.endsWith('right')
        ? width - textWidth - margin
        : margin;
    const y = position.startsWith('bottom') ? margin : height - margin - size * 0.25;
    page.drawText(text, {
      x,
      y,
      size,
      font,
      color: rgb(0.35, 0.38, 0.42),
    });
  });
  return savePdf(doc, `${baseName(file.name)}-numbered.pdf`, 'Added page numbers to the PDF.', [file]);
}

async function addImageToPdf(files: File[]) {
  const pdfFile = files.find(file => file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf'));
  const imageFile = files.find(file => file.type.startsWith('image/'));
  if (!pdfFile || !imageFile) throw new Error('Upload one PDF and one JPG or PNG image.');
  const doc = await loadPdf(pdfFile);
  const bytes = await imageFile.arrayBuffer();
  const image = imageFile.type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  const scaled = image.scaleToFit(width * 0.32, height * 0.22);
  page.drawImage(image, { x: width - scaled.width - 42, y: 42, width: scaled.width, height: scaled.height });
  return savePdf(doc, `${baseName(pdfFile.name)}-image.pdf`, 'Added the uploaded image to the first PDF page.', files);
}

export type VerifyReport = {
  status: 'valid' | 'invalid' | 'undetermined' | 'electronic-only';
  signatureCount: number;
  electronicCount: number;
  signer: string | null;
  certificate: string | null;
  certificateExpiry: string | null;
  trust: string | null;
  integrity: string | null;
  timestamp: string | null;
  details: string[];
};

/** Byte-level inspection of the real PDF signature dictionaries (/AcroForm /Fields SigFlags /ByteRange /Contents). */
async function inspectPdfSignatures(file: File): Promise<VerifyReport> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 1024));
  if (!head.includes('%PDF-')) {
    throw new Error('This file could not be read as a PDF. Please check the file — it may be corrupted or in a different format than its name suggests.');
  }
  const latin = new TextDecoder('latin1').decode(buffer);
  const details: string[] = [];

  const acroFormOk = /\/AcroForm\b/.test(latin);
  const sigFlagsOk = /\/SigFlags\s*\/Sign/.test(latin);
  const sigFieldRanges = [...latin.matchAll(/\/FT\s*\/Sig/g)];
  const byteRanges = [...latin.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const subFilters = [...latin.matchAll(/\/SubFilter\s*\/(adbe\.pkcs7\.detached|adbe\.pkcs7\.sha1|etsi\.cades\.detached)/g)].map(m => m[1]);
  const filters = [...latin.matchAll(/\/Filter\s*\/(Adobe\.PPKLite|Adobe\.PPKMS)/g)].map(m => m[1]);

  // Extract printable CN= names from the certificate hex blobs (subject names are stored as hex-encoded DER).
  let signer: string | null = null;
  const hexBlobs = [...latin.matchAll(/<([0-9A-Fa-f]{200,})>/g)].map(m => m[1]);
  for (const hex of hexBlobs) {
    try {
      const der = new Uint8Array(hex.length / 2);
      for (let i = 0; i < der.length; i += 1) der[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      // UTF8String (0x0C) or PrintableString (0x13) chunks of plausible name length.
      for (let i = 0; i < der.length - 4; i += 1) {
        const tag = der[i];
        const len = der[i + 1];
        if ((tag === 0x0c || tag === 0x13) && len >= 4 && len <= 64 && i + 2 + len <= der.length) {
          const chunk = new TextDecoder('utf-8', { fatal: true }).decode(der.slice(i + 2, i + 2 + len));
          if (/^[\p{L}][\p{L}\s.,'’-]{3,63}$/u.test(chunk)) { signer = chunk; break; }
        }
      }
    } catch { /* not a DER blob */ }
    if (signer) break;
  }

  const coverageInfo = byteRanges.map(range => {
    const [, gapStart, tailStart] = range.map(Number) as unknown as number[];
    const signedTail = buffer.length - (tailStart + Number(range[4]));
    const coveredEnd = tailStart + Number(range[4]);
    const covered = gapStart === 0 && coveredEnd >= buffer.length - Math.max(signedTail, 0);
    return { covered, note: `ByteRange covers bytes 0–${coveredEnd} of ${buffer.length}` };
  });

  if (sigFieldRanges.length === 0) {
    // No signature dictionaries at all — is there merely a visible mark?
    const visualHint = /signature/i.test(latin.slice(0, 200000)) ? 'The file mentions "signature" in visible text only.' : '';
    return {
      status: 'undetermined',
      signatureCount: 0,
      electronicCount: 0,
      signer: null,
      certificate: null,
      certificateExpiry: null,
      trust: null,
      integrity: null,
      timestamp: null,
      details: [
        'No cryptographic signature dictionary (/FT /Sig) exists in this PDF.',
        visualHint,
        'A drawn, typed or image signature is a visual/electronic mark: it is not cryptographically verifiable and proves neither the signer\'s identity nor document integrity.',
      ].filter(Boolean),
    };
  }

  details.push(`Found ${sigFieldRanges.length} signature field${sigFieldRanges.length === 1 ? '' : 's'}; AcroForm: ${acroFormOk ? 'present' : 'missing'}; SigFlags: ${sigFlagsOk ? 'signing declared' : 'not declared'}.`);
  if (subFilters.length) details.push(`Signature format: ${[...new Set(subFilters)].join(', ')} (PAdES/PKCS#7).`);
  if (filters.length) details.push(`Signature handler: ${[...new Set(filters)].join(', ')}.`);
  details.push(...coverageInfo.map(info => info.note));

  const fullyCovered = coverageInfo.length > 0 && coverageInfo.every(info => info.covered);
  if (byteRanges.length) {
    details.push(fullyCovered
      ? 'The signed byte ranges appear to cover the current file — no obvious post-signing modification detected at the byte level.'
      : 'The signed byte ranges do not cover the whole file, or the file has grown after signing — the document may have been modified after signing.');
  }
  details.push('Full cryptographic validation (hash comparison, certificate chain, trust anchors, revocation via OCSP/CRL, RFC-3161 timestamps) requires a PKI trust store that browsers do not expose to web apps.');

  return {
    status: 'undetermined',
    signatureCount: sigFieldRanges.length,
    electronicCount: 0,
    signer,
    certificate: subFilters.length ? `${[...new Set(subFilters)].join(', ')} signature dictionary present` : null,
    certificateExpiry: null,
    trust: 'Unknown — certificate trust cannot be evaluated in the browser',
    integrity: byteRanges.length
      ? (fullyCovered ? 'Signed byte ranges cover the document; no byte-level modification detected' : 'Byte ranges suggest possible modification after signing — cannot confirm')
      : 'Unable to determine',
    timestamp: null,
    details,
  };
}

/** Rasterize an SVG data URL to PNG so pdf-lib can embed it (pdf-lib has no SVG support). */
async function svgToPngDataUrl(svgDataUrl: string): Promise<string> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The SVG signature could not be read.'));
    image.src = svgDataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.naturalWidth || 300);
  canvas.height = Math.max(1, image.naturalHeight || 120);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available in this browser.');
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Real signature placement from position/size options (used by draw/upload/esign with placement UI). */
async function placeSignature(file: File, options: Options, sourceLabel: string) {
  const doc = await loadPdf(file);
  const pageCount = doc.getPageCount();
  const pageIndex = Math.min(Math.max(1, Number.parseInt(options.signPage ?? '1', 10) || 1), pageCount);
  const page = doc.getPage(pageIndex - 1);
  const { width, height } = page.getSize();
  if (options.signatureData?.startsWith('data:image/')) {
    let dataUrl = options.signatureData;
    if (dataUrl.startsWith('data:image/svg')) dataUrl = await svgToPngDataUrl(dataUrl);
    const file2 = dataUrlToFile(dataUrl, dataUrl.startsWith('data:image/png') ? 'signature.png' : 'signature.jpg');
    const bytes = await file2.arrayBuffer();
    const image = file2.type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const targetWidth = Math.max(8, Math.min(240, Number.parseFloat(options.signatureWidth ?? '') || 120));
    const scaled = image.scaleToFit(targetWidth, targetWidth);
    const x = Math.max(0, Math.min(width - scaled.width, Number.parseFloat(options.signatureX ?? '') || 0));
    const y = Math.max(0, Math.min(height - scaled.height, Number.parseFloat(options.signatureY ?? '') || 0));
    page.drawImage(image, { x, y, width: scaled.width, height: scaled.height });
    return savePdf(doc, `${baseName(file.name)}-signed.pdf`, `Embedded the ${sourceLabel} at page ${pageIndex}, position (${Math.round(x)}, ${Math.round(y)}) pt, ${Math.round(scaled.width)} pt wide.`, [file]);
  }
  const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const text = options.signature || 'Signed with My PDF Desk';
  const x = Math.max(0, Math.min(width - 120, Number.parseFloat(options.signatureX ?? '') || 42));
  const y = Math.max(0, Math.min(height - 24, Number.parseFloat(options.signatureY ?? '') || 96));
  page.drawText(text, { x, y, size: 18, font, color: rgb(0.75, 0.1, 0.28), maxWidth: width - x - 40 });
  return savePdf(doc, `${baseName(file.name)}-signed.pdf`, `Embedded a typed signature on page ${pageIndex}.`, [file]);
}

/** Legacy one-click signing (kept for the e-Sign quick path). */
async function signPdf(file: File, options: Options) {
  if (options.signatureData?.startsWith('data:image/') && (options.signatureX || options.signatureY)) {
    return placeSignature(file, options, 'placed signature');
  }
  const doc = await loadPdf(file);
  const pageCount = doc.getPageCount();
  const pageIndex = Math.min(Math.max(1, Number.parseInt(options.signPage ?? String(pageCount), 10) || pageCount), pageCount);
  const page = doc.getPage(pageIndex - 1);
  const { width } = page.getSize();
  const drawn: string[] = [];

  if (options.signatureData?.startsWith('data:image/png')) {
    const response = await fetch(options.signatureData);
    const pngBytes = await response.arrayBuffer();
    const image = await doc.embedPng(pngBytes);
    const targetWidth = Math.min(160, width * 0.28);
    const scaled = image.scaleToFit(targetWidth, targetWidth * 0.45);
    page.drawImage(image, { x: 42, y: 84, width: scaled.width, height: scaled.height });
    drawn.push('your drawn/uploaded signature image');
  } else {
    const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
    const text = options.signature || 'Signed with My PDF Desk';
    page.drawText(text, {
      x: 42,
      y: 96,
      size: 18,
      font,
      color: rgb(0.75, 0.1, 0.28),
      maxWidth: width - 84,
    });
    drawn.push('a typed signature');
  }

  const fontPlain = await doc.embedFont(StandardFonts.Helvetica);
  const dateLine = `Signed on ${new Date().toLocaleDateString()} with My PDF Desk`;
  page.drawText(dateLine, {
    x: 42,
    y: 68,
    size: 9,
    font: fontPlain,
    color: rgb(0.42, 0.45, 0.5),
  });
  return savePdf(doc, `${baseName(file.name)}-signed.pdf`, `Embedded ${drawn[0]} onto page ${pageIndex} of ${pageCount}.`, [file]);
}

async function protectPdf(file: File, options: Options) {
  const password = options.password ?? '';
  if (password.length < 4) throw new Error('Please enter a password of at least 4 characters.');
  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  const secure = await SecurePdfDocument.load(await source.save({ useObjectStreams: true }));
  secure.encrypt({
    userPassword: password,
    ownerPassword: options.ownerPassword || password,
    algorithm: 'AES-256',
  });
  const bytes = await secure.save({ useObjectStreams: true });
  return output(`${baseName(file.name)}-protected.pdf`, new Blob([bytesToBlobPart(bytes)], { type: pdfMime }), `Encrypted with AES-256. The PDF now requires the password to open — keep it safe, it cannot be recovered.`, [file]);
}

async function restrictPdf(file: File, options: Options) {
  // Owner-password-only encryption: the PDF opens without any password, but the
  // embedded permission flags tell compliant viewers what readers may do with it.
  const allowed = (key: string, fallback = true) => (options[key] ?? (fallback ? 'allowed' : 'blocked')) === 'allowed';
  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  const secure = await SecurePdfDocument.load(await source.save({ useObjectStreams: true }));
  // Random internal owner password: only grants permission-bypass to whoever holds it.
  const ownerBytes = new Uint8Array(24);
  crypto.getRandomValues(ownerBytes);
  const ownerPassword = Array.from(ownerBytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
  secure.encrypt({
    ownerPassword,
    algorithm: 'AES-256',
    permissions: {
      printing: allowed('printing') ? 'highResolution' : false,
      copying: allowed('copying'),
      modifying: allowed('editing'),
      annotating: allowed('annotating'),
      fillingForms: allowed('fillingForms'),
      contentAccessibility: true,
      documentAssembly: allowed('editing'),
    },
  });
  const bytes = await secure.save({ useObjectStreams: true });
  const blocked: string[] = [];
  if (!allowed('printing')) blocked.push('printing');
  if (!allowed('copying')) blocked.push('copying text');
  if (!allowed('editing')) blocked.push('editing');
  if (!allowed('annotating')) blocked.push('annotations');
  if (!allowed('fillingForms')) blocked.push('form filling');
  const message = blocked.length
    ? `Applied restrictions: ${blocked.join(', ')} blocked. The PDF still opens without a password. Note: permission restrictions depend on the PDF viewer and may not be enforced by every application.`
    : 'Encrypted with no restrictions selected — the PDF opens normally and all actions remain allowed. Note: permission restrictions depend on the PDF viewer.';
  return output(`${baseName(file.name)}-restricted.pdf`, new Blob([bytesToBlobPart(bytes)], { type: pdfMime }), message, [file]);
}

async function unlockPdf(file: File, options: Options) {
  const password = options.password ?? '';
  let parseError: unknown = null;
  try {
    const probeTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...(password ? { password } : {}) });
    await probeTask.promise;
    await probeTask.destroy();
  } catch (err) {
    parseError = err;
  }
  const name = nameFromError(parseError);
  if (name === 'PasswordException') {
    throw new Error(password
      ? 'That password did not unlock the PDF. Please check it and try again.'
      : 'This PDF needs its open password. Enter the password in the password field and try again.');
  }
  if (parseError) {
    throw new Error('This file could not be read as a PDF. Please check the file and try again.');
  }
  // pdf.js ignores owner-level restrictions (an "owner password unlocked" copy) but
  // cannot rewrite user-password encryption. Rasterize page images into a fresh,
  // restriction-free PDF so the content is genuinely reusable.
  const entries = await renderPdfToJpegs(file, 2, 0.88, password);
  const doc = await PDFDocument.create();
  for (const entry of entries) {
    const image = await doc.embedJpg(await entry.blob.arrayBuffer());
    const { width, height } = image.scale(1);
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return savePdf(doc, `${baseName(file.name)}-unlocked.pdf`, `Removed restrictions in a rebuilt ${entries.length}-page copy. Note: pages are high-quality images, so text is no longer selectable — the visual content is identical.`, [file]);
}

function nameFromError(err: unknown) {
  return err instanceof Error ? err.name : '';
}

async function simpleResavePdf(file: File, nameSuffix: string, message: string) {
  const doc = await loadPdf(file);
  return savePdf(doc, `${baseName(file.name)}-${nameSuffix}.pdf`, message, [file]);
}

async function compressPdf(file: File, options: Options) {
  const level = options.compression ?? 'medium';
  const { scale, quality } = { low: { scale: 2, quality: 0.82 }, medium: { scale: 2, quality: 0.65 }, high: { scale: 1.5, quality: 0.45 } }[level] ?? { scale: 2, quality: 0.65 };
  return rebuildPdfFromRenders([file], file, scale, quality, 'compressed', `Compressed (${level} quality)`);
}

async function batchResave(files: File[]) {
  const entries: ProcessedFile[] = [];
  for (const file of files) {
    const doc = await loadPdf(file);
    const bytes = await doc.save({ useObjectStreams: true });
    entries.push({
      blob: new Blob([bytesToBlobPart(bytes)], { type: pdfMime }),
      fileName: `${baseName(file.name)}-optimized.pdf`,
      mimeType: pdfMime,
    });
  }
  return zipFiles('optimized-pdfs.zip', entries, files, `Optimized ${entries.length} PDF files.`);
}

const OCR_LANGS: Record<string, string> = {
  eng: 'English', spa: 'Spanish', fra: 'French', deu: 'German', por: 'Portuguese',
  ita: 'Italian', nld: 'Dutch', hin: 'Hindi', ara: 'Arabic', rus: 'Russian',
  chi_sim: 'Chinese (Simplified)', jpn: 'Japanese', kor: 'Korean', tur: 'Turkish',
};

export const ocrLanguageLabel = (code: string) => OCR_LANGS[code] ?? code;
export const OCR_LANGUAGE_OPTIONS = Object.entries(OCR_LANGS).map(([code, label]) => ({ code, label }));

/** Real OCR: render pages via pdf.js, run Tesseract per page, rebuild a text-based PDF. */
async function ocrPdf(file: File, options: Options) {
  const lang = options.ocrLang ?? 'eng';
  const worker = await createOcrWorker(lang);
  try {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdf = await loadingTask.promise;
    const maxPages = Math.min(pdf.numPages, 30);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let totalRecognized = 0;
    try {
      for (let i = 1; i <= maxPages; i += 1) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is not available in this browser.');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport } as never).promise;
        const result = await worker.recognize(canvas);
        // eslint-disable-next-line no-control-regex
        const text = (result.data.text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
        totalRecognized += text.split(/\s+/).filter(Boolean).length;
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;

        const outPage = doc.addPage([viewport.width / 2, viewport.height / 2]);
        let y = outPage.getHeight() - 48;
        const size = 11;
        for (const paragraph of text.split(/\n{2,}/)) {
          for (const line of wrapText(paragraph, 88)) {
            if (y < 48) {
              const nextPage = doc.addPage([outPage.getWidth(), outPage.getHeight()]);
              y = nextPage.getHeight() - 48;
              void nextPage;
            }
            outPage.drawText(line, { x: 44, y, size, font, color: rgb(0.12, 0.14, 0.18) });
            y -= 16;
          }
          y -= 6;
        }
      }
    } finally {
      await loadingTask.destroy();
    }
    if (totalRecognized === 0) {
      throw new Error('OCR finished but no text could be recognised. The scan may be too low-quality, blank, or in a language that is not selected.');
    }
    const note = pdf.numPages > maxPages ? ` Processed the first ${maxPages} of ${pdf.numPages} pages.` : '';
    return savePdf(doc, `${baseName(file.name)}-ocr.pdf`, `OCR recognised ~${totalRecognized} words and rebuilt a searchable, selectable-text PDF.${note}`, [file]);
  } finally {
    await worker.terminate();
  }
}

/** Detect column-aligned tables in text items via x-coordinate clustering. */
function detectTables(items: Array<{ text: string; x: number; y: number; width: number }>) {
  const usable = items.filter(item => item.text.trim());
  if (usable.length < 4) return [];
  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const rowTolerance = 4;
  const rows: Array<Array<{ text: string; x: number; width: number }>> = [];
  let currentRow: Array<{ text: string; x: number; width: number }> = [];
  let rowY = sorted[0].y;
  for (const item of sorted) {
    if (Math.abs(item.y - rowY) <= rowTolerance) {
      currentRow.push(item);
    } else {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [item];
      rowY = item.y;
    }
  }
  if (currentRow.length) rows.push(currentRow);

  const candidateRows = rows.filter(row => row.length >= 2);
  if (candidateRows.length < 2) return [];
  const columnEdges = new Map<number, number>();
  for (const row of candidateRows) {
    for (const item of row) {
      const key = Math.round(item.x / 8) * 8;
      columnEdges.set(key, (columnEdges.get(key) ?? 0) + 1);
    }
  }
  const frequent = [...columnEdges.entries()].filter(([, count]) => count >= Math.max(2, Math.floor(candidateRows.length * 0.6))).map(([x]) => x).sort((a, b) => a - b);
  if (frequent.length < 2) return [];

  const tables: SheetTable[] = [];
  let tableRows: string[][] = [];
  const assign = (row: Array<{ text: string; x: number; width: number }>) => {
    const cells: string[] = new Array(frequent.length).fill('');
    for (const item of row) {
      let column = 0;
      for (let edge = 0; edge < frequent.length; edge += 1) {
        if (item.x >= frequent[edge] - 6) column = edge;
      }
      cells[column] = cells[column] ? `${cells[column]} ${item.text}`.trim() : item.text;
    }
    return cells;
  };
  const rowMap = new Map(rows.map(row => [row, row]));
  void rowMap;
  for (const row of rows) {
    const isCandidate = row.length >= 2 && row.some(item => frequent.some(edge => Math.abs(item.x - edge) <= 6));
    if (isCandidate) {
      tableRows.push(assign(row));
    } else if (tableRows.length >= 2) {
      tables.push({ name: `Table ${tables.length + 1}`, rows: tableRows });
      tableRows = [];
    } else {
      tableRows = [];
    }
  }
  if (tableRows.length >= 2) tables.push({ name: `Table ${tables.length + 1}`, rows: tableRows });
  return tables;
}

async function pdfToExcel(file: File) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const tables: SheetTable[] = [];
  let sheetIndex = 0;
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.flatMap(item => {
      if (!('str' in item) || !item.str.trim()) return [];
      const transform = (item as { transform?: number[] }).transform ?? [];
      return [{ text: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0, width: (item as { width?: number }).width ?? 0 }];
    });
    page.cleanup();
    for (const table of detectTables(items)) {
      sheetIndex += 1;
      tables.push({ name: `Page${i}-${sheetIndex}`, rows: table.rows });
    }
  }
  await loadingTask.destroy();
  if (!tables.length) {
    throw new Error('No structured tables were detected in this PDF — the text is not column-aligned. Try a spreadsheet-derived PDF, or use PDF to Word for the plain text.');
  }
  const rowCount = tables.reduce((sum, table) => sum + table.rows.length, 0);
  return blocksToXlsx(tables, `${baseName(file.name)}.xlsx`, [file], `Extracted ${tables.length} table${tables.length === 1 ? '' : 's'} (${rowCount} rows) into a genuine Excel workbook with real cells.`);
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[char] ?? char));
}

type DocxBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; text: string }
  | { kind: 'table'; rows: string[][] };

/** Build a real Word document from structured blocks (headings, lists, tables) rather than a flat text dump. */
async function buildDocxFromBlocks(blocks: DocxBlock[], fileName: string, sourceFiles: File[], note: string) {
  const body: string[] = [];
  const run = (text: string) => `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  for (const block of blocks) {
    if (block.kind === 'paragraph' && !block.text.trim()) continue;
    if (block.kind === 'heading') {
      body.push(`<w:p><w:pPr><w:outlineLvl w:val="${Math.min(5, block.level - 1)}"/></w:pPr>${run(block.text)}</w:p>`);
    } else if (block.kind === 'list') {
      body.push(`<w:p><w:pPr><w:ind w:left="360"/></w:pPr>${run(`• ${block.text}`)}</w:p>`);
    } else if (block.kind === 'paragraph') {
      body.push(`<w:p>${run(block.text)}</w:p>`);
    } else {
      const grid = `<w:tblGrid>${block.rows[0]?.map(() => '<w:gridCol w:w="2400"/>').join('') ?? ''}</w:tblGrid>`;
      const rowsXml = block.rows.map((row, rowIndex) => {
        const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p>${run(text)}</w:p></w:tc>`;
        const rowProps = rowIndex === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
        return `<w:tr>${rowProps}${row.map(cell).join('')}</w:tr>`;
      }).join('');
      body.push(`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders></w:tblPr>${grid}${rowsXml}</w:tbl><w:p/>`);
    }
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return output(fileName, new Blob([blob], { type: docxMime }), note, sourceFiles);
}

function escapeHtml(value: string) {
  return value.replace(/[<>&"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char] ?? char));
}

async function xlsxToHtmlBlocks(file: File) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const blocks: string[] = [];
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: '' })
      .filter(row => row.some(cell => String(cell ?? '').trim()));
    if (!rows.length) continue;
    const tableRows = rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`).join('');
    blocks.push(`<h2>${escapeHtml(name)}</h2><table>${tableRows}</table>`);
  }
  return blocks.join('') || '<p>The spreadsheet has no visible data.</p>';
}

type SheetTable = { name: string; rows: string[][] };

async function blocksToXlsx(tables: SheetTable[], fileName: string, sourceFiles: File[], note: string) {
  const workbook = XLSX.utils.book_new();
  for (const table of tables) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(table.rows), table.name);
  }
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const blob = new Blob([bytes], { type: xlsxMime });
  return output(fileName, blob, note, sourceFiles);
}

async function textToPptx(text: string, fileName: string, sourceFiles: File[]) {
  const zip = new JSZip();
  const slideText = wrapText(text.replace(/\n+/g, ' '), 90).slice(0, 12).join('\n');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.folder('ppt')?.file('presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/></p:presentation>');
  zip.folder('ppt/_rels')?.file('presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  zip.folder('ppt/slides')?.file('slide1.xml', `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Extracted text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="685800"/><a:ext cx="7772400" cy="3771900"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"/><a:t>${xmlEscape(slideText)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return output(fileName, new Blob([blob], { type: pptxMime }), 'Created a basic PPTX slide from extracted PDF text.', sourceFiles);
}

async function docxToHtml(file: File) {
  if (/\.doc$/i.test(file.name)) throw new Error('Legacy .doc files are not supported in the browser. Please save the document as .docx and try again.');
  const browserMammoth = mammoth as unknown as { convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  const result = await browserMammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return result.value || '<p></p>';
}

/** Convert any of the supported office documents to simple HTML the PDF renderer understands. */
async function convertDocumentToHtml(file: File) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.docx') || file.type.includes('wordprocessingml')) return docxToHtml(file);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || file.type.includes('spreadsheetml') || file.type.includes('ms-excel')) return xlsxToHtmlBlocks(file);
  if (lower.endsWith('.pptx') || file.type.includes('presentationml')) return pptxToHtmlBlocks(file);
  throw new Error('Unsupported document type. Please upload a DOCX, XLSX/XLS or PPTX file.');
}

async function pptxToHtmlBlocks(file: File) {
  if (/\.ppt$/i.test(file.name)) throw new Error('Legacy .ppt files are not supported in the browser. Please save the presentation as .pptx and try again.');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
  const blocks: string[] = [];
  for (const [index, slide] of slideFiles.entries()) {
    const xml = await zip.file(slide)?.async('string');
    if (!xml) continue;
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => match[1]).filter(text => text.trim());
    if (!texts.length) continue;
    blocks.push(`<h2>Slide ${index + 1}</h2><p>${texts.map(text => escapeHtml(text)).join(' — ')}</p>`);
  }
  return blocks.join('') || '<p>No readable text found in this presentation.</p>';
}

/** Structured PDF → Word: paragraphs, headings by font size, bullet lists, and column tables. */
async function pdfToWord(file: File): Promise<{ kind: 'ok' | 'scanned'; blocks: DocxBlock[]; note: string }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const blocks: DocxBlock[] = [];
  let textChars = 0;
  try {
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      type Line = { y: number; size: number; text: string; items: Array<{ text: string; x: number }> };
      const lines: Line[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const transform = item.transform as number[];
        const y = Math.round(transform[5] ?? 0);
        const size = Math.abs(transform[3] ?? 10);
        const line = lines.find(candidate => Math.abs(candidate.y - y) <= 3);
        if (line) {
          line.items.push({ text: item.str, x: transform[4] ?? 0 });
        } else {
          lines.push({ y, size, text: '', items: [{ text: item.str, x: transform[4] ?? 0 }] });
        }
      }
      page.cleanup();
      lines.sort((a, b) => b.y - a.y);
      const bodySizes = lines.map(line => line.size).sort((a, b) => a - b);
      const medianSize = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 10;

      for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        const segments: string[] = [];
        let text = '';
        let lastEnd: number | null = null;
        for (const item of line.items) {
          if (lastEnd !== null && item.x - lastEnd > 18 && text && !/\s$/.test(text) && !/^\s/.test(item.text)) {
            segments.push(text.trim());
            text = item.text;
          } else {
            text += text && !/\s$/.test(text) && !/^\s/.test(item.text) ? ` ${item.text}` : item.text;
          }
          lastEnd = item.x + item.text.length * line.size * 0.5;
        }
        if (text.trim()) segments.push(text.trim());
        text = segments.join('\t').trim();
        if (!text) continue;
        textChars += text.length;
        const columns = text.split('\t');
        if (columns.length >= 3) {
          const previous = blocks[blocks.length - 1];
          if (previous?.kind === 'table' && previous.rows[0]?.length === columns.length) {
            previous.rows.push(columns);
          } else {
            blocks.push({ kind: 'table', rows: [columns] });
          }
        } else if (/^[•\u2022\u25CF\u00B7-]\s+/.test(text) || /^\d+[.)]\s+/.test(text)) {
          blocks.push({ kind: 'list', text: text.replace(/^[•\u2022\u25CF\u00B7-]\s+|^\d+[.)]\s+/, '') });
        } else if (line.size >= medianSize * 1.35 && text.length < 120) {
          blocks.push({ kind: 'heading', text, level: line.size >= medianSize * 1.8 ? 1 : 2 });
        } else {
          const previous = blocks[blocks.length - 1];
          if (previous?.kind === 'paragraph' && !previous.text.endsWith('.') && blocks.length > 0) {
            previous.text = `${previous.text} ${text}`;
          } else {
            blocks.push({ kind: 'paragraph', text });
          }
        }
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  if (textChars < 20) {
    return { kind: 'scanned', blocks: [], note: 'No text layer found.' };
  }
  const tables = blocks.filter(block => block.kind === 'table').length;
  const headings = blocks.filter(block => block.kind === 'heading').length;
  return { kind: 'ok', blocks, note: `Created an editable Word document: ${blocks.length} blocks, ${headings} heading${headings === 1 ? '' : 's'}, ${tables} table${tables === 1 ? '' : 's'} detected. Layout is re-flowed, not pixel-identical.` };
}

/** Wrap a verification report into the result the ToolPage can render as a report card. */
async function verifyResultAsBlob(report: VerifyReport, file: File): Promise<ProcessedResult> {
  const reportText = [
    `SIGNATURE VERIFICATION REPORT`,
    `File: ${file.name}`,`Generated: ${new Date().toISOString()}`,
    ``,
    `Cryptographic signature fields found: ${report.signatureCount}`,
    `Status: ${report.status.toUpperCase()}`,
    report.signer ? `Signer (extracted from certificate data): ${report.signer}` : null,
    report.certificate ? `Certificate: ${report.certificate}` : null,
    report.trust ? `Trust: ${report.trust}` : null,
    report.integrity ? `Document integrity: ${report.integrity}` : null,
    ``,
    'Details:',
    ...report.details.map(line => `- ${line}`),
  ].filter((line): line is string => line !== null).join('\n');
  const blob = new Blob([reportText], { type: 'text/plain' });
  return {
    files: [{ blob, fileName: `${baseName(file.name)}-signature-report.txt`, mimeType: 'text/plain' }],
    message: `Signature check complete: ${report.signatureCount} cryptographic signature field${report.signatureCount === 1 ? '' : 's'} found. Full report available for download; details are also shown below and in the console.`,
    originalSize: file.size,
    newSize: blob.size,
    verifyReport: report,
  };
}

export async function processTool(slug: string, files: File[], options: Options): Promise<ProcessedResult> {
  ensureFiles(files);

  switch (slug) {
    case 'pdf-to-jpg':
      return pdfToImages(files[0], 'image/jpeg');
    case 'protect-pdf':
      return protectPdf(files[0], options);
    case 'encrypt-pdf':
      return restrictPdf(files[0], options);
    case 'unlock-pdf':
      return unlockPdf(files[0], options);
    case 'pdf-to-png':
      return pdfToImages(files[0], 'image/png');
    case 'jpg-to-pdf':
    case 'png-to-pdf':
    case 'pdf-scanner':
      return imagesToPdf(files);
    case 'image-compressor':
      return compressImages(files, options);
    case 'merge-pdfs':
      return mergePdfs(files);
    case 'split-pdf':
      return splitPdf(files[0], options);
    case 'rotate-pdf':
      return rotatePdf(files[0], options);
    case 'delete-pages':
      return deletePages(files[0], options);
    case 'extract-pages':
      return extractPages(files[0], options);
    case 'rearrange-pages':
      return rearrangePages(files[0], options);
    case 'watermark-pdf':
      return watermarkPdf(files[0], options);
    case 'page-numbering':
      return pageNumberPdf(files[0], options);
    case 'add-images':
      return addImageToPdf(files);
    case 'add-text':
    case 'pdf-editor':
      return addText(files[0], options);
    case 'compress-pdf':
      return compressPdf(files[0], options);
    case 'batch-compress':
      return batchResave(files);
    case 'esign-pdf':
    case 'draw-signature':
    case 'upload-signature':
    case 'digital-signature':
      return signPdf(files[0], options);
    case 'verify-signature':
      return verifyResultAsBlob(await inspectPdfSignatures(files[0]), files[0]);
    case 'ocr-pdf':
      return ocrPdf(files[0], options);
    case 'pdf-to-word': {
      const result = await pdfToWord(files[0]);
      if (result.kind === 'scanned') {
        throw new Error('This PDF appears to be scanned (image-only) — there is no text layer to convert. Use the OCR PDF tool first, then convert its output.');
      }
      return buildDocxFromBlocks(result.blocks, `${baseName(files[0].name)}.docx`, [files[0]], result.note);
    }
    case 'pdf-to-excel':
      return pdfToExcel(files[0]);
    case 'word-to-pdf':
      return htmlToPdf(await convertDocumentToHtml(files[0]), baseName(files[0].name), files);
    case 'excel-to-pdf':
      return htmlToPdf(await xlsxToHtmlBlocks(files[0]), baseName(files[0].name), files);
    case 'powerpoint-to-pdf':
      return htmlToPdf(await pptxToHtmlBlocks(files[0]), baseName(files[0].name), files);
    case 'pdf-to-powerpoint':
      return textToPptx(await extractPdfText(files[0]), `${baseName(files[0].name)}.pptx`, files);
    default:
      return simpleResavePdf(files[0], 'processed', 'Processed the uploaded PDF.');
  }
}
