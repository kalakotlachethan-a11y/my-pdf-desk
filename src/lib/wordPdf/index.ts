/**
 * Word → PDF public entry.
 * Parses the DOCX package and renders a genuine, selectable-text PDF.
 */
import { parseDocx } from './docxParser';
import { renderDocxToPdf } from './render';

export async function convertDocxToPdf(
  file: File,
  onProgress?: (label: string, pct: number) => void,
): Promise<{ blob: Blob; pageCount: number }> {
  const parsed = await parseDocx(file);
  const { bytes, pageCount } = await renderDocxToPdf(parsed, onProgress);
  return { blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), pageCount };
}
