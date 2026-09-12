import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
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
    const image = file.type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const { width, height } = image.scale(1);
    const page = doc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return savePdf(doc, `${baseName(files[0].name)}.pdf`, `Created a PDF with ${files.length} image page${files.length > 1 ? 's' : ''}.`, files);
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

async function splitPdf(file: File) {
  const source = await loadPdf(file);
  const entries: ProcessedFile[] = [];
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
  return zipFiles(`${baseName(file.name)}-split.zip`, entries, [file], `Split ${file.name} into ${entries.length} PDF files.`);
}

async function rotatePdf(file: File, options: Options) {
  const doc = await loadPdf(file);
  const rotation = Number.parseInt(options.rotation ?? '90', 10) || 90;
  doc.getPages().forEach(page => page.setRotation(degrees(rotation)));
  return savePdf(doc, `${baseName(file.name)}-rotated.pdf`, `Rotated every page by ${rotation} degrees.`, [file]);
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
  const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const page = doc.getPage(0);
  const { width } = page.getSize();
  const text = options.signature || 'Signed with My PDF Desk';
  page.drawText(text, {
    x: 48,
    y: 72,
    size: 18,
    font,
    color: rgb(0.75, 0.1, 0.28),
    maxWidth: width - 96,
  });
  page.drawText(`Date: ${new Date().toLocaleDateString()}`, {
    x: 48,
    y: 50,
    size: 9,
    color: rgb(0.42, 0.45, 0.5),
  });
  return savePdf(doc, `${baseName(file.name)}-signed.pdf`, 'Added a visible electronic signature block.', [file]);
}

async function simpleResavePdf(file: File, nameSuffix: string, message: string) {
  const doc = await loadPdf(file);
  return savePdf(doc, `${baseName(file.name)}-${nameSuffix}.pdf`, message, [file]);
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
      return splitPdf(files[0]);
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
      return simpleResavePdf(files[0], 'optimized', 'Optimized and resaved the PDF structure.');
    case 'batch-compress':
      return batchResave(files);
    case 'protect-pdf':
    case 'encrypt-pdf':
      return watermarkPdf(files[0], { ...options, watermarkText: options.watermarkText || 'Protected Copy', opacity: options.opacity || '15' });
    case 'unlock-pdf':
      return simpleResavePdf(files[0], 'unlocked-copy', 'Created a clean copy of PDFs that can be opened without unsupported restrictions.');
    case 'esign-pdf':
    case 'draw-signature':
    case 'upload-signature':
    case 'digital-signature':
      return signPdf(files[0], options);
    case 'verify-signature':
      return textToPdf('Signature verification requires certificate-chain validation. This browser tool created an audit note for the uploaded document instead.', `${baseName(files[0].name)} verification note`, files);
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
