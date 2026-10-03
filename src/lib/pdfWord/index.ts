/**
 * PDF → Word public entry.
 * Server-first: sends the PDF to /api/parse-pdf (Vercel serverless function)
 * and reconstructs the DOCX from the server result. When the endpoint is not
 * available (static GitHub Pages deploy, offline, oversized file) it falls back
 * to the local pdf.js pipeline transparently. Reports scanned documents so the
 * caller can offer OCR.
 */
import { openPdf, analyzePage, type PdfPageAnalysis } from './extract';
import { pagesToDocxBlob } from './docx';
import { parsePdfViaApi, parsePdfPagesViaVision } from '../apiPdf';
import { geometryToDocxBlob } from './apiGeometry';
import { apiLooksScanned } from './apiToPages';
import { renderPageToJpeg, chunkPageImages } from './pageImages';
import { markdownToDocxBlob } from './markdownToDocx';

export interface PdfToWordOutcome {
  scanned: boolean;
  blob: Blob | null;
  pageCount: number;
}

export async function convertPdfToDocx(
  file: File,
  onProgress?: (label: string, pct: number) => void,
): Promise<PdfToWordOutcome> {
  onProgress?.('Analyzing PDF', 15);

  // 1. Server-side parsing (Vercel serverless function).
  const api = await parsePdfViaApi(file);
  if (api) {
    if (apiLooksScanned(api)) {
      // Scanned/image PDF: try the vision (Gemini) path before giving up.
      const visionBlob = await tryVisionConversion(file, onProgress);
      if (visionBlob) return { scanned: false, blob: visionBlob, pageCount: api.pages.length };
      return { scanned: true, blob: null, pageCount: api.pages.length };
    }
    onProgress?.('Extracting content', 30);
    onProgress?.('Reconstructing document', 60);
    const blob = await geometryToDocxBlob(api);
    onProgress?.('Validating DOCX', 95);
    return { scanned: false, blob, pageCount: api.pages.length };
  }

  // 1b. Vision (multimodal Gemini) path — server renders nothing; the browser
  // sends high-res page images and the server returns a structured document.
  const visionBlob = await tryVisionConversion(file, onProgress);
  if (visionBlob) return { scanned: false, blob: visionBlob, pageCount: 0 };

  // 2. Local fallback (static hosting / endpoint unavailable).
  const doc = await openPdf(file);
  const pages: PdfPageAnalysis[] = [];
  for (let index = 0; index < doc.numPages; index++) {
    const page = await doc.getPage(index + 1);
    pages.push(await analyzePage(page, index));
    page.cleanup();
  }
  if (typeof (doc as { destroy?: unknown }).destroy === 'function') {
    await (doc as { destroy: () => Promise<void> }).destroy();
  }

  onProgress?.('Extracting content', 30);
  const totalChars = pages.reduce((sum, p) => sum + p.textCharCount, 0);
  if (totalChars < 25 * pages.length) {
    return { scanned: true, blob: null, pageCount: pages.length };
  }

  // 2b. Text-light local PDF: try the vision path before declaring scanned.
  const totalLocalChars = pages.reduce((sum, p) => sum + p.textCharCount, 0);
  if (totalLocalChars < 25 * pages.length) {
    const visionBlob = await tryVisionConversion(file, onProgress);
    if (visionBlob) return { scanned: false, blob: visionBlob, pageCount: pages.length };
    return { scanned: true, blob: null, pageCount: pages.length };
  }

  onProgress?.('Detecting layout', 45);
  onProgress?.('Reconstructing tables', 60);
  const blob = await pagesToDocxBlob(pages);
  onProgress?.('Validating DOCX', 95);
  return { scanned: false, blob, pageCount: pages.length };
}

/**
 * Vision conversion: render pages locally at 2x, ship base64 JPEGs to
 * /api/parse-pdf (JSON mode), rebuild the DOCX from Gemini's transcription.
 * Returns null when the vision engine is unavailable or fails.
 */
async function tryVisionConversion(
  file: File,
  onProgress?: (label: string, pct: number) => void,
): Promise<Blob | null> {
  try {
    onProgress?.('Rendering pages for vision analysis', 18);
    const doc = await openPdf(file);
    const images: string[] = [];
    let firstWidth = 595;
    let firstHeight = 842;
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (i === 1) {
          const vp = page.getViewport({ scale: 1 });
          firstWidth = vp.width;
          firstHeight = vp.height;
        }
        images.push(await renderPageToJpeg(page as unknown));
      }
    } finally {
      if (typeof (doc as { destroy?: unknown }).destroy === 'function') {
        await (doc as { destroy: () => Promise<void> }).destroy();
      }
    }

    const markdowns: string[] = [];
    const chunks = chunkPageImages(images);
    for (let c = 0; c < chunks.length; c++) {
      onProgress?.(`Vision analysis (chunk ${c + 1}/${chunks.length})`, 25 + Math.round((c / chunks.length) * 45));
      const vision = await parsePdfPagesViaVision(chunks[c]);
      if (!vision) return null; // unavailable / failed → caller falls back
      markdowns.push(vision.markdown);
    }
    images.length = 0; // release page images early

    onProgress?.('Reconstructing Word document', 80);
    const blob = await markdownToDocxBlob(markdowns.join('\n\n'), firstWidth, firstHeight);
    onProgress?.('Validating DOCX', 95);
    return blob;
  } catch {
    return null;
  }
}
