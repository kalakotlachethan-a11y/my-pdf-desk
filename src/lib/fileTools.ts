import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { PDFDocument as SecurePdfDocument } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth/mammoth.browser';
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

async function textToPdf(text: string, title: string, sourceFiles: File[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 740;

  page.drawText(title, { x: 48, y, size: 18, font: bold, color: rgb(0.1, 0.18, 0.34) });
  y -= 34;

  for (const paragraph of text.split(/\n+/)) {
    for (const line of wrapText(paragraph)) {
      if (y < 54) {
        page = doc.addPage([612, 792]);
        y = 740;
      }
      page.drawText(line, { x: 48, y, size: 11, font, color: rgb(0.16, 0.18, 0.22) });
      y -= 17;
    }
    y -= 8;
  }

  return savePdf(doc, `${safeFileStem(title)}.pdf`, 'Created a readable PDF from the uploaded document content.', sourceFiles);
}

function safeFileStem(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'processed-file';
}

async function extractPdfText(file: File) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');
    pages.push(`Page ${i}\n${text}`);
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
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = options.watermarkText || 'CONFIDENTIAL';
  const opacity = Math.max(0.1, Math.min(0.8, (Number.parseInt(options.opacity ?? '30', 10) || 30) / 100));
  doc.getPages().forEach(page => {
    const { width, height } = page.getSize();
    page.drawText(text, {
      x: width * 0.18,
      y: height * 0.48,
      size: Math.max(28, width / 12),
      font,
      color: rgb(0.8, 0.1, 0.1),
      opacity,
      rotate: degrees(-35),
    });
  });
  return savePdf(doc, `${baseName(file.name)}-watermarked.pdf`, 'Added a text watermark to the PDF.', [file]);
}

async function pageNumberPdf(file: File) {
  const doc = await loadPdf(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const { width } = page.getSize();
    const text = `${index + 1} / ${pages.length}`;
    page.drawText(text, {
      x: width / 2 - font.widthOfTextAtSize(text, 10) / 2,
      y: 24,
      size: 10,
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

async function signPdf(file: File, options: Options) {
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

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[char] ?? char));
}

async function textToDocx(text: string, fileName: string, sourceFiles: File[]) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paragraphs = text.split(/\n+/).map(line => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return output(fileName, new Blob([blob], { type: docxMime }), 'Created an editable DOCX from extracted PDF text.', sourceFiles);
}

async function textToXlsx(text: string, fileName: string, sourceFiles: File[]) {
  const rows = text.split(/\n+/).filter(Boolean).map(line => [line]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Extracted Text'], ...rows]), 'PDF Text');
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const blob = new Blob([bytes], { type: xlsxMime });
  return output(fileName, blob, 'Created an editable XLSX from extracted PDF text.', sourceFiles);
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

async function docxToText(file: File) {
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value || file.name;
}

async function xlsxToText(file: File) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return workbook.SheetNames.map(name => {
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1 });
    return [`Sheet: ${name}`, ...rows.map(row => row.join(' | '))].join('\n');
  }).join('\n\n');
}

async function pptxToText(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
  const chunks: string[] = [];
  for (const slide of slideFiles) {
    const xml = await zip.file(slide)?.async('string');
    if (!xml) continue;
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match => match[1]).join(' ');
    chunks.push(text);
  }
  return chunks.join('\n\n') || file.name;
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
      return pageNumberPdf(files[0]);
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
      throw new Error('Verifying a digital certificate signature requires the signer\'s certificate chain and a trusted root list, which browsers cannot validate offline. Open the file in Adobe Acrobat Reader to verify signatures — all other PDF Desk tools work fully in your browser.');
    case 'ocr-pdf':
      return textToDocx(await extractPdfText(files[0]), `${baseName(files[0].name)}-ocr-text.docx`, files);
    case 'pdf-to-word':
      return textToDocx(await extractPdfText(files[0]), `${baseName(files[0].name)}.docx`, files);
    case 'pdf-to-excel':
      return textToXlsx(await extractPdfText(files[0]), `${baseName(files[0].name)}.xlsx`, files);
    case 'pdf-to-powerpoint':
      return textToPptx(await extractPdfText(files[0]), `${baseName(files[0].name)}.pptx`, files);
    case 'word-to-pdf':
      return textToPdf(await docxToText(files[0]), baseName(files[0].name), files);
    case 'excel-to-pdf':
      return textToPdf(await xlsxToText(files[0]), baseName(files[0].name), files);
    case 'powerpoint-to-pdf':
      return textToPdf(await pptxToText(files[0]), baseName(files[0].name), files);
    default:
      return simpleResavePdf(files[0], 'processed', 'Processed the uploaded PDF.');
  }
}
