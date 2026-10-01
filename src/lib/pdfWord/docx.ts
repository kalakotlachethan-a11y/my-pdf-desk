/**
 * PDF → Word: document reconstruction.
 * Turns per-page analysis into a structured DOCX: headings, body paragraphs,
 * monospace code blocks with preserved indentation, real tables from detected
 * grids, embedded images, page breaks, and Word footer page numbering.
 */
import type { PdfLine, PdfPageAnalysis } from './extract';
import { tableClaimsLine, detectTables, columnWidthsTwips, gridBoldFlags, type TableGrid } from './tables';
import { buildDocx, pageBreakXml, tableXml, imageParaXml, paraXml, type ParaSpec, type RunSpec, type SectionSpec, type TableSpec, type TableCellSpec, type Align } from './docxBuilder';

const TWIP = 20; // 1pt = 20 twips
const MONO_FONT = 'Consolas';
const BODY_FONT = 'Times New Roman';

function halfPoints(size: number): number {
  return Math.max(8, Math.round(size * 2));
}

function lineRun(line: PdfLine, font: string): RunSpec {
  const span = line.spans.reduce((a, b) => (b.str.length > a.str.length ? b : a));
  return {
    text: line.text,
    size: halfPoints(line.size),
    bold: line.bold,
    italic: span.italic,
    underline: false,
    font,
  };
}

function bodyPara(line: PdfLine, align: Align, indentTwips: number): ParaSpec {
  return {
    runs: [lineRun(line, BODY_FONT)],
    align,
    indentTwips,
    spacingBefore: 0,
    spacingAfter: 60,
    lineTwips: null,
  };
}

/** Heading heuristic: larger than the page's body text or bold short line. */
function isHeading(line: PdfLine, bodySize: number): boolean {
  if (line.mono) return false;
  if (line.bold && line.text.length <= 90) return true;
  return line.size >= bodySize * 1.14;
}

function detectAlignment(line: PdfLine, pageWidth: number, margin: number): Align {
  const center = (line.left + line.right) / 2;
  const pageCenter = pageWidth / 2;
  const rightEdge = pageWidth - margin;
  if (line.right > rightEdge - 24 && line.left > pageWidth * 0.5) return 'right';
  if (Math.abs(center - pageCenter) < Math.max(24, pageWidth * 0.05)) return 'center';
  return 'left';
}

function gridToTableSpec(grid: TableGrid, pageWidth: number): TableSpec {
  const widths = columnWidthsTwips(grid);
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = total > 0 ? Math.min(1.4, (pageWidth - 100) * TWIP / total) : 1;
  const scaled = widths.map(w => Math.max(360, Math.round(w * scale)));
  const boldFlags = gridBoldFlags(grid);
  const firstFilled = grid.cells[0]?.filter(c => c).length ?? 0;
  const firstRatio = grid.cells[0]?.length ? firstFilled / grid.cells[0].length : 0;
  const rows: TableCellSpec[][] = grid.cells.map((row, r) =>
    row.map((text, c) => ({
      text,
      // PDFs with subset fonts carry no bold info; header rows (mostly-filled
      // first row) are rendered bold as the conventional default.
      bold: !!(boldFlags && boldFlags[r]?.[c]) || (r === 0 && !!text && firstRatio >= 0.6),
      size: 21,
    })),
  );
  return { columnWidths: scaled, rows, borders: true };
}

/** Java/terminal lines keep their exact leading spaces as monospace text. */
function codeLines(lines: PdfLine[], pageLeft: number): string[] {
  return lines.map(line => {
    const charW = Math.max(3.2, line.size * 0.55);
    const spaces = Math.max(0, Math.round((line.left - pageLeft) / charW));
    return ' '.repeat(spaces) + line.text.replace(/\t/g, '    ');
  });
}

function codePara(text: string, sizeHalf: number): ParaSpec {
  return {
    runs: [{ text, size: sizeHalf, bold: false, italic: false, underline: false, font: MONO_FONT }],
    align: 'left',
    indentTwips: 0,
    spacingBefore: 0,
    spacingAfter: 0,
    lineTwips: Math.round(sizeHalf * 6), // exact single-ish spacing, no wrap drift
  };
}

interface ReconstructInput {
  pages: PdfPageAnalysis[];
  withFooter: boolean;
}

interface ReconstructOutput {
  bodyXml: string;
  section: SectionSpec;
  images: Array<{ dataUrl: string; ext: 'png' | 'jpg' }>;
  footerText: string;
  headerText: string;
  footerAlign: 'left' | 'center' | 'right';
}

export function reconstructDocument(input: ReconstructInput): ReconstructOutput {
  const pages = input.pages;
  const first = pages[0];
  const landscape = first.width > first.height;
  const hasFrame = pages.some(p => p.pageFrame != null);
  const section: SectionSpec = {
    width: Math.round(first.width * TWIP),
    height: Math.round(first.height * TWIP),
    margins: { top: Math.round(68 * TWIP), bottom: Math.round(24 * TWIP), left: Math.round(72 * TWIP), right: Math.round(36 * TWIP) },
    landscape,
    pageBorders: hasFrame,
  };

  const body: string[] = [];
  const images: Array<{ dataUrl: string; ext: 'png' | 'jpg' }> = [];

  pages.forEach((page, pageIndex) => {
    const margin = Math.min(90, page.width * 0.09);
    // Global body size for this page: most common size rounded.
    const sizeCounts = new Map<number, number>();
    for (const line of page.lines) {
      if (line.mono) continue;
      const key = Math.round(line.size * 2) / 2;
      sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + line.text.length);
    }
    let bodySize = 11;
    let bestCount = 0;
    for (const [size, count] of sizeCounts) {
      if (count > bestCount) { bodySize = size; bestCount = count; }
    }

    // Header/footer strip: only lines inside the page-edge bands.
    const isHeaderFooter = (line: PdfLine): boolean => {
      if (line.y > page.height - 30 || line.y < 24) return true;
      return false;
    };

    const grids = detectTables(page.lines, page.vectorLines);

    // Group consecutive lines into blocks; table lines are consumed by grids.
    let i = 0;
    const lines = page.lines.filter(l => l.text.trim().length > 0 && !isHeaderFooter(l));
    const emitPageBreak = pageIndex > 0;
    if (emitPageBreak) body.push(pageBreakXml());

    while (i < lines.length) {
      const line = lines[i];
      if (tableClaimsLine(grids, line)) {
        const grid = grids.find(g => tableClaimsLine([g], line)) ?? grids[0];
        const spec = gridToTableSpec(grid, page.width);
        body.push(tableXml(spec));
        // Skip every line this grid covers.
        while (i < lines.length && tableClaimsLine(grids, lines[i])) i++;
        continue;
      }

      if (line.mono) {
        // Code run: absorb consecutive mono lines.
        const run: PdfLine[] = [];
        while (i < lines.length && lines[i].mono && !tableClaimsLine(grids, lines[i])) {
          run.push(lines[i]);
          i++;
        }
        const sizeHalf = halfPoints(run[0].size);
        const codeText = codeLines(run, margin);
        for (const text of codeText) body.push(paraXml(codePara(text, sizeHalf)));
        continue;
      }

      if (isHeading(line, bodySize)) {
        body.push(paraXml({
          ...bodyPara(line, detectAlignment(line, page.width, margin), 0),
          runs: [{ ...lineRun(line, BODY_FONT), bold: true }],
          keepNext: true,
          spacingBefore: 120,
          spacingAfter: 80,
        }));
        i++;
        continue;
      }

      // Regular paragraph line; merge consecutive body lines into one paragraph
      // unless the line looks like a standalone item (short, or starts a new block).
      const paraLines: PdfLine[] = [];
      while (i < lines.length && !lines[i].mono && !isHeading(lines[i], bodySize) && !tableClaimsLine(grids, lines[i])) {
        paraLines.push(lines[i]);
        const short = lines[i].text.trim().length < 46;
        i++;
        if (short) break;
      }
      if (paraLines.length === 1) {
        body.push(paraXml(bodyPara(paraLines[0], detectAlignment(paraLines[0], page.width, margin), 0)));
      } else {
        const runs: RunSpec[] = [];
        paraLines.forEach((pl, idx) => {
          const run = lineRun(pl, BODY_FONT);
          runs.push(idx === 0 ? run : { ...run, text: (run.text.startsWith(' ') ? '' : ' ') + run.text });
        });
        body.push(paraXml({
          runs,
          align: 'left',
          indentTwips: 0,
          spacingBefore: 0,
          spacingAfter: 60,
          lineTwips: null,
        }));
      }
    }

    // Images found on the page go after its content, scaled to printable width.
    for (const image of page.images) {
      const maxW = page.width - 2 * margin;
      const w = Math.min(maxW, image.w * 0.75);
      const h = image.h * (w / image.w);
      images.push({ dataUrl: image.dataUrl, ext: image.dataUrl.includes('image/jpeg') ? 'jpg' : 'png' });
      body.push(imageParaXml(`rIdImg${images.length}`, w, h));
    }
  });

  // Footer/header text: take the topmost/bottommost strip lines from page 1 (or the
  // first page that has them) so Word repeats them on every page natively.
  let footerText = '';
  let headerText = '';
  let footerAlign: 'left' | 'center' | 'right' = 'left';
  for (const page of pages) {
    const bottom = page.lines.filter(l => l.y < 24 && l.text.trim());
    const top = page.lines.filter(l => l.y > page.height - 30 && l.text.trim());
    if (!footerText && bottom.length) {
      footerText = bottom.map(l => l.text.trim()).join('  ');
      const pageMid = page.width / 2;
      const lineMid = (bottom[0].left + bottom[0].right) / 2;
      footerAlign = Math.abs(lineMid - pageMid) < page.width * 0.12 ? 'center' : lineMid < pageMid ? 'left' : 'right';
    }
    if (!headerText && top.length) headerText = top.map(l => l.text.trim()).join('  ');
    if (footerText || headerText) break;
  }

  return { bodyXml: body.join(''), section, images, footerText, headerText, footerAlign };
}

/** Public entry: convert analyzed pages into a validated DOCX blob. */
export async function pagesToDocxBlob(pages: PdfPageAnalysis[]): Promise<Blob> {
  const anyText = pages.some(p => p.textCharCount > 0);
  if (!anyText) throw new Error('This PDF contains no selectable text. Use the OCR conversion mode.');
  const built = reconstructDocument({ pages, withFooter: true });
  return buildDocx({
    bodyXml: built.bodyXml,
    section: built.section,
    withFooter: true,
    footerText: built.footerText,
    headerText: built.headerText,
    footerAlign: built.footerAlign,
    images: built.images,
  });
}
