import { PDFDocument, PDFImage, StandardFonts, degrees, rgb, type PDFFont } from 'pdf-lib';
import { PDFDocument as SecurePdfDocument } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker as createOcrWorker } from 'tesseract.js';
import PptxGenJS from 'pptxgenjs';
import { docxToPdf, xlsxToPdf, pdfToDocx, pdfToXlsx } from './converters';
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
/**
 * High-fidelity PDF → PPTX: each page is rendered at high resolution and placed
 * full-bleed on its own slide; the slide size mirrors the PDF page (capped at
 * PowerPoint's 56-inch limit), so the complete page — logo, headers, faculty
 * names, footers, margins and all — is preserved visually. Nothing is cropped
 * or filtered. Pages whose aspect ratio differs from slide 1 are scaled to fit
 * and centered, never stretched or clipped. Slides are images, so text is not
 * directly editable — stated honestly in the result message.
 */
async function pdfToPptx(file: File) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  if (!pdf.numPages) throw new Error('This PDF has no pages to convert.');
  const pptx = new PptxGenJS();
  try {
    // Slide size from page 1 (capped at PowerPoint's hard 56-inch limit).
    const firstViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const widthIn = Math.min(56, firstViewport.width / 72);
    const heightIn = Math.min(56, firstViewport.height / 72);
    pptx.defineLayout({ name: 'PDFPAGE', width: widthIn, height: heightIn });
    pptx.layout = 'PDFPAGE';

    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      // Render the complete page (never a bounding-box crop). Cap the raster at
      // 4096px on the long edge so very large scans cannot exhaust memory.
      const baseViewport = page.getViewport({ scale: 1 });
      const renderScale = Math.min(4, 4096 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is not available in this browser.');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport } as never).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      const slide = pptx.addSlide();
      // pptxgenjs 4.x takes inches. Fit the whole page inside the slide
      // (identical aspect => exact full-bleed) and center any mismatch.
      const aspect = baseViewport.width / baseViewport.height;
      const slideAspect = widthIn / heightIn;
      const w = aspect >= slideAspect ? widthIn : heightIn * aspect;
      const h = aspect >= slideAspect ? widthIn / aspect : heightIn;
      slide.addImage({ data: dataUrl, x: (widthIn - w) / 2, y: (heightIn - h) / 2, w, h });
    }
  } finally {
    await loadingTask.destroy();
  }
  const blob = (await pptx.write({ outputType: 'blob' })) as Blob;
  if (!blob || blob.size < 500) throw new Error('PPTX generation failed. Please try again.');
  return output(`${baseName(file.name)}.pptx`, new Blob([blob], { type: pptxMime }), `Created a ${pdf.numPages}-slide PowerPoint with each PDF page rendered at high quality on its own slide. The slides preserve the exact visual layout but are images, so text is not directly editable inside PowerPoint.`, [file]);
}

function sanitizeForPdf(text: string) {
  return pdfSafeText(text);
}

/** Wrap a single logical line into physical lines that fit maxWidth (PDF points). */
function wrapLine(font: PDFFont, line: string, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(line, size) <= maxWidth || maxWidth <= 0) return [line];
  const words = line.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [line];
}

const EMU_PER_PT = 914400 / 72;

function parseHexColor(value: string | undefined, fallback: { r: number; g: number; b: number }) {
  const clean = (value ?? '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16) / 255,
    g: Number.parseInt(clean.slice(2, 4), 16) / 255,
    b: Number.parseInt(clean.slice(4, 6), 16) / 255,
  };
}

function matchBlock(xml: string, tag: string) {
  const results: string[] = [];
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) results.push(match[0]);
  return results;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Render PPTX slides to PDF with positioned text, images, tables and slide backgrounds. */
async function pptxToPdf(file: File) {
  if (/\.ppt$/i.test(file.name)) {
    throw new Error('Legacy .ppt files are not supported in the browser. Please save the presentation as .pptx and try again.');
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (!presXml) throw new Error('This file is not a valid PPTX presentation.');

  const sizeMatch = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml)
    ?? /<p:sldSz[^>]*cy="(\d+)"[^>]*cx="(\d+)"/.exec(presXml);
  let widthPt = 720;
  let heightPt = 405;
  if (sizeMatch) {
    const first = Number.parseInt(sizeMatch[1], 10) / EMU_PER_PT;
    const second = Number.parseInt(sizeMatch[2], 10) / EMU_PER_PT;
    widthPt = Math.round(Math.max(first, second));
    heightPt = Math.round(Math.min(first, second));
    if (/<p:sldSz[^>]*cy="(\d+)"[^>]*cx="(\d+)"/.test(presXml)) {
      widthPt = Math.round(Math.max(first, second));
      heightPt = Math.round(Math.min(first, second));
    }
  }

  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
  if (!slideFiles.length) throw new Error('This presentation contains no slides.');

  const doc = await PDFDocument.create();
  const fonts: FontSet = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const defaultColor = { r: 0.13, g: 0.15, b: 0.2 };

  for (const slidePath of slideFiles) {
    const xml = (await zip.file(slidePath)?.async('string')) ?? '';
    const relsRaw = await zip.file(slidePath.replace('slides/', 'slides/_rels/') + '.rels')?.async('string');
    const rels = new Map<string, string>();
    for (const rel of relsRaw?.match(/<Relationship\b[^>]*>/g) ?? []) {
      const id = /Id="([^"]+)"/.exec(rel)?.[1];
      const target = /Target="([^"]+)"/.exec(rel)?.[1];
      if (id && target) rels.set(id, target.replace(/^\.\.\//, 'ppt/'));
    }

    const page = doc.addPage([widthPt, heightPt]);

    const bg = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
    if (bg) {
      const color = parseHexColor(bg, defaultColor);
      page.drawRectangle({ x: 0, y: 0, width: widthPt, height: heightPt, color: rgb(color.r, color.g, color.b) });
    }

    // Text boxes: positioned paragraphs with size, bold/italic, color and alignment.
    for (const shape of matchBlock(xml, 'p:sp')) {
      const off = /<a:off x="(\d+)" y="(\d+)"/.exec(shape);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(shape);
      if (!off || !ext) continue;
      const boxX = Number.parseInt(off[1], 10) / EMU_PER_PT;
      const boxY = Number.parseInt(off[2], 10) / EMU_PER_PT;
      const boxW = Math.max(24, Number.parseInt(ext[1], 10) / EMU_PER_PT);
      const boxH = Number.parseInt(ext[2], 10) / EMU_PER_PT;
      const bodyPr = /<a:bodyPr[^>]*anchor="(\w+)"/.exec(shape)?.[1] ?? 't';

      const paragraphs = matchBlock(shape, 'a:p');
      const lineSpecs: Array<{ text: string; size: number; bold: boolean; italic: boolean; color: { r: number; g: number; b: number }; align: string; spacing: number }> = [];
      for (const paragraph of paragraphs) {
        const runs = [...paragraph.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map(runXml => {
          const body = runXml[1];
          const text = decodeXmlEntities(/<a:t>([\s\S]*?)<\/a:t>/.exec(body)?.[1] ?? '');
          const sizeAttr = /sz="(\d+)"/.exec(body)?.[1];
          const color = parseHexColor(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(body)?.[1], defaultColor);
          return {
            text,
            size: sizeAttr ? Math.max(6, Number.parseInt(sizeAttr, 10) / 100) : 18,
            bold: /b="1"/.test(body),
            italic: /i="1"/.test(body),
            color,
          };
        }).filter(run => run.text);
        if (!runs.length) {
          lineSpecs.push({ text: '', size: 12, bold: false, italic: false, color: defaultColor, align: 'l', spacing: 1 });
          continue;
        }
        const align = /algn="(\w+)"/.exec(paragraph)?.[1] ?? 'l';
        const spacingPct = /<a:lnSpc><a:spcPct val="(\d+)"/.exec(paragraph)?.[1];
        const spacing = spacingPct ? Math.max(0.8, Number.parseInt(spacingPct, 10) / 100000) : 1;
        for (const run of runs) {
          lineSpecs.push({ ...run, align, spacing });
        }
      }

      const totalHeight = lineSpecs.reduce((sum, line) => sum + line.size * 1.25 * line.spacing, 0);
      let cursorY = bodyPr === 'ctr' || bodyPr === 'b'
        ? boxY + (boxH - totalHeight) / 2 + totalHeight
        : boxY + boxH;
      cursorY -= lineSpecs[0] ? lineSpecs[0].size * 0.95 : 14;

      for (const line of lineSpecs) {
        const font = fontFor(fonts, line.bold, line.italic);
        const maxWidth = boxW - 8;
        const segments = wrapLine(font, sanitizeForPdf(line.text), line.size, maxWidth);
        for (const segment of segments) {
          const segWidth = font.widthOfTextAtSize(segment, line.size);
          let x = boxX + 4;
          if (line.align === 'ctr') x = boxX + (boxW - segWidth) / 2;
          if (line.align === 'r') x = boxX + boxW - segWidth - 4;
          if (segment) page.drawText(segment, { x, y: cursorY, size: line.size, font, color: rgb(line.color.r, line.color.g, line.color.b) });
          cursorY -= line.size * 1.25 * line.spacing;
        }
      }
    }

    // Images: resolve relationship targets and draw fitted inside their frame.
    for (const pic of matchBlock(xml, 'p:pic')) {
      const embed = /r:embed="(rId\d+)"/.exec(pic)?.[1];
      const off = /<a:off x="(\d+)" y="(\d+)"/.exec(pic);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(pic);
      const target = embed ? rels.get(embed) : undefined;
      if (!target || !off || !ext) continue;
      const entry = zip.file(target);
      if (!entry) continue;
      const bytes = await entry.async('uint8array');
      try {
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const frameW = Number.parseInt(ext[1], 10) / EMU_PER_PT;
        const frameH = Number.parseInt(ext[2], 10) / EMU_PER_PT;
        const natural = image.scale(1);
        const scale = Math.min(frameW / natural.width, frameH / natural.height);
        const drawW = natural.width * scale;
        const drawH = natural.height * scale;
        page.drawImage(image, {
          x: Number.parseInt(off[1], 10) / EMU_PER_PT + (frameW - drawW) / 2,
          y: Number.parseInt(off[2], 10) / EMU_PER_PT + (frameH - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      } catch { /* unsupported image format inside the deck: skip it, keep converting */ }
    }

    // Tables: grid with borders and cell text.
    for (const table of matchBlock(xml, 'a:tbl')) {
      const cols = [...table.matchAll(/<a:gridCol w="(\d+)"/g)].map(m => Number.parseInt(m[1], 10) / EMU_PER_PT);
      const rows = matchBlock(table, 'a:tr').map(rowXml =>
        matchBlock(rowXml, 'a:tc').map(cellXml =>
          [...cellXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeXmlEntities(m[1])).join(' ').trim()));
      const gridX = /<a:off x="(\d+)" y="(\d+)"/.exec(table);
      const startX = gridX ? Number.parseInt(gridX[1], 10) / EMU_PER_PT : 36;
      let startY = gridX ? Number.parseInt(gridX[2], 10) / EMU_PER_PT + 40 : heightPt - 120;
      const columnCount = Math.max(1, cols.length || (rows[0]?.length ?? 1));
      const columnWidths = cols.length ? cols : Array.from({ length: columnCount }, () => (widthPt - startX - 36) / columnCount);
      for (const row of rows) {
        const cellSize = 11;
        const rowHeight = cellSize * 1.6;
        let x = startX;
        row.forEach((cell, index) => {
          const width = columnWidths[index] ?? columnWidths[columnWidths.length - 1];
          page.drawRectangle({ x, y: startY - rowHeight, width, height: rowHeight, borderColor: rgb(0.75, 0.77, 0.8), borderWidth: 0.7 });
          if (cell) page.drawText(sanitizeForPdf(cell), { x: x + 4, y: startY - rowHeight + 5, size: cellSize, font: fonts.regular, color: rgb(defaultColor.r, defaultColor.g, defaultColor.b) });
          x += width;
        });
        startY -= rowHeight;
        if (startY < 24) break;
      }
    }
  }

  return savePdf(doc, `${baseName(file.name)}.pdf`, `Converted ${slideFiles.length} slide${slideFiles.length === 1 ? '' : 's'} to PDF pages with positioned text, images, tables, colors and slide backgrounds at the original ${Math.round(widthPt)}×${Math.round(heightPt)} pt slide size.`, [file]);
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
    case 'pdf-to-word':
      return pdfToDocx(files[0], options as Options);
    case 'pdf-to-excel':
      return pdfToXlsx(files[0]);
    case 'word-to-pdf':
      return docxToPdf(files[0]);
    case 'excel-to-pdf':
      return xlsxToPdf(files[0]);
    case 'powerpoint-to-pdf':
      return pptxToPdf(files[0]);
    case 'pdf-to-powerpoint':
      return pdfToPptx(files[0]);
    default:
      return simpleResavePdf(files[0], 'processed', 'Processed the uploaded PDF.');
  }
}
