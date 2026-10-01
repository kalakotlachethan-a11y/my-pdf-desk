/**
 * PDF → Word: geometry-mode reconstruction.
 * When /api/parse-pdf returns positioned items + vector lines, run the exact
 * same layout/table reconstruction pipeline as the local path — but from
 * server-parsed data (no client pdf.js pass needed). Falls back to the
 * text-mode builder when geometry is missing.
 */
import { pagesToDocxBlob } from './docx';
import { apiToDocxBlob } from './apiToPages';
import { groupAnalyzedItems, type GeoPage } from './extractBridge';
import type { ApiPdfDoc } from '../apiPdf';

export async function geometryToDocxBlob(api: ApiPdfDoc): Promise<Blob> {
  const geo = (api.geometry ?? []) as GeoPage[];
  const hasGeometry = geo.length > 0 && geo.some(p => (p.items?.length ?? 0) > 0);
  if (!hasGeometry) return apiToDocxBlob(api);
  const analyzed = groupAnalyzedItems(geo);
  return pagesToDocxBlob(analyzed);
}
