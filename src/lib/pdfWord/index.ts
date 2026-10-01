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
import { parsePdfViaApi } from '../apiPdf';
import { geometryToDocxBlob } from './apiGeometry';
import { apiLooksScanned } from './apiToPages';

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
      return { scanned: true, blob: null, pageCount: api.pages.length };
    }
    onProgress?.('Extracting content', 30);
    onProgress?.('Reconstructing document', 60);
    const blob = await geometryToDocxBlob(api);
    onProgress?.('Validating DOCX', 95);
    return { scanned: false, blob, pageCount: api.pages.length };
  }

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

  onProgress?.('Detecting layout', 45);
  onProgress?.('Reconstructing tables', 60);
  const blob = await pagesToDocxBlob(pages);
  onProgress?.('Validating DOCX', 95);
  return { scanned: false, blob, pageCount: pages.length };
}
