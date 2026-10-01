/**
 * PDF → Word: server-parse reconstruction.
 * Builds the DOCX from the /api/parse-pdf result: per-page text with preserved
 * code indentation (Consolas), heading heuristics, real tables from pdf-parse's
 * vector table detection, embedded images, repeated footer extraction, and
 * per-page dimensions for the section geometry.
 */
import {
  buildDocx,
  pageBreakXml,
  tableXml,
  imageParaXml,
  paraXml,
  type ParaSpec,
  type RunSpec,
  type SectionSpec,
  type TableSpec,
  type TableCellSpec,
  type Align,
} from './docxBuilder';
import type { ApiPdfDoc } from '../apiPdf';

const TWIP = 20; // 1pt = 20 twips
const MONO_FONT = 'Consolas';
const BODY_FONT = 'Times New Roman';

const CODE_RE = /[{};]\s*$|^\s*(public|private|protected|import|package|class|void|return|System\.|else|for|if|while|try|catch|static)\b|\bSystem\.out\.print/;

function normalizeTabs(line: string, mono: boolean): string {
  return line.replace(/\t/g, mono ? '    ' : '  ');
}

function isCodeLine(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return CODE_RE.test(raw) || /^\s{4,}\S/.test(raw);
}

function isHeadingLike(trimmed: string): boolean {
  if (!trimmed || trimmed.length > 60) return false;
  if (/[.,;]$/.test(trimmed)) return false;
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  return trimmed.endsWith(':');
}

function bodyPara(text: string, opts?: { bold?: boolean; heading?: boolean; mono?: boolean; indentTwips?: number }): ParaSpec {
  const mono = !!opts?.mono;
  const run: RunSpec = {
    text,
    size: mono ? 20 : 22,
    bold: !!opts?.bold,
    italic: false,
    underline: false,
    font: mono ? MONO_FONT : BODY_FONT,
  };
  return {
    runs: [run],
    align: 'left' as Align,
    indentTwips: opts?.indentTwips ?? 0,
    spacingBefore: opts?.heading ? 120 : 0,
    spacingAfter: opts?.heading ? 80 : mono ? 0 : 60,
    lineTwips: mono ? 240 : null,
  };
}

function apiTableToSpec(cells: string[][]): TableSpec | null {
  const rows = cells.filter(r => Array.isArray(r) && r.some(c => c && c.trim()));
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map(r => r.length));
  if (colCount < 1) return null;
  // Column width from the longest cell text in that column (character-proportional).
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const maxLen = Math.max(4, ...rows.map(r => (r[c] ?? '').length));
    widths.push(Math.min(4800, Math.max(720, maxLen * 115)));
  }
  const firstFilled = rows[0].filter(c => c && c.trim()).length;
  const headerBold = rows.length >= 2 && firstFilled / colCount >= 0.6;
  const specRows: TableCellSpec[][] = rows.map((row, r) =>
    Array.from({ length: colCount }, (_, c) => ({
      text: (row[c] ?? '').replace(/\t/g, '  ').trim(),
      bold: headerBold && r === 0,
      size: 21,
    })),
  );
  return { columnWidths: widths, rows: specRows, borders: true };
}

/** Repeated last line across pages becomes a real Word footer (not body text). */
function extractFooter(pages: ApiPdfDoc['pages']): { footerText: string; bodyByPage: string[][] } {
  const bodyByPage = pages.map(p => p.text.split('\n').filter(l => l.trim().length > 0));
  const lastLines = bodyByPage.map(lines => (lines.length ? lines[lines.length - 1].replace(/\t/g, '  ').trim() : ''));
  const counts = new Map<string, number>();
  for (const line of lastLines) {
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const footerText = [...counts.entries()].find(([, n]) => n >= Math.max(2, Math.ceil(lastLines.filter(Boolean).length / 2)))?.[0] ?? '';
  if (footerText) {
    for (const lines of bodyByPage) {
      if (lines.length && lines[lines.length - 1].replace(/\t/g, '  ').trim() === footerText) lines.pop();
    }
  }
  return { footerText, bodyByPage };
}

export async function apiToDocxBlob(api: ApiPdfDoc): Promise<Blob> {
  const { footerText, bodyByPage } = extractFooter(api.pages);
  const body: string[] = [];
  const images: Array<{ dataUrl: string; ext: 'png' | 'jpg' }> = [];

  api.pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) body.push(pageBreakXml());

    const lines = bodyByPage[pageIndex] ?? [];
    for (const raw of lines) {
      const mono = isCodeLine(raw);
      const trimmed = raw.trim();
      if (mono) {
        body.push(paraXml(bodyPara(normalizeTabs(raw, true), { mono: true })));
        continue;
      }
      const heading = isHeadingLike(trimmed);
      const indent = (() => {
        const lead = raw.length - raw.trimStart().length;
        return lead >= 2 ? Math.min(2880, lead * 100) : 0;
      })();
      body.push(paraXml(bodyPara(normalizeTabs(raw, false), { bold: heading, heading, indentTwips: indent })));
    }

    // Real tables detected server-side (pdf-parse vector analysis).
    for (const table of api.tables.filter(t => t.num === page.num)) {
      for (const cells of table.cells) {
        const spec = apiTableToSpec(cells);
        if (spec) body.push(tableXml(spec));
      }
    }

    // Embedded images reported by the server, scaled to the printable width.
    for (const image of api.images.filter(im => im.num === page.num)) {
      const dataUrl = image.dataUrl;
      const ext: 'png' | 'jpg' = dataUrl.includes('image/jpeg') ? 'jpg' : 'png';
      const ratio = image.width && image.height ? image.height / image.width : 0.6;
      const w = Math.min(450, image.width ? image.width * 0.75 : 300);
      const h = w * ratio;
      images.push({ dataUrl, ext });
      body.push(imageParaXml(`rIdImg${images.length}`, w, h));
    }
  });

  const first = api.pages[0];
  const section: SectionSpec = {
    width: Math.round(first.width * TWIP),
    height: Math.round(first.height * TWIP),
    margins: { top: Math.round(68 * TWIP), bottom: Math.round(24 * TWIP), left: Math.round(72 * TWIP), right: Math.round(36 * TWIP) },
    landscape: first.width > first.height,
    pageBorders: false,
  };

  return buildDocx({
    bodyXml: body.join(''),
    section,
    withFooter: true,
    footerText,
    images,
  });
}

/** Scanned-document check identical in spirit to the local pipeline. */
export function apiLooksScanned(api: ApiPdfDoc): boolean {
  const totalChars = api.pages.reduce((sum, p) => sum + p.text.length, 0);
  return totalChars < 25 * api.pages.length;
}
