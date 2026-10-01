/**
 * Layout-preserving conversion engines for My PDF Desk.
 *
 * Unlike the older flat-text converters, these engines read the raw document
 * structures (OOXML for Word/Excel, positioned glyph runs for PDFs) and
 * reproduce geometry, formatting and page structure as faithfully as the
 * browser allows. Everything runs client-side; nothing is uploaded anywhere.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export type Options = Record<string, string>;

const pdfMime = 'application/pdf';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

/** Strip characters the standard PDF fonts cannot encode (e.g. CJK), keeping common typographic marks. */
function pdfSafeText(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\u0000-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2022\u2026]/g, '');
}

type FontSet = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };

function fontFor(fonts: FontSet, bold: boolean, italic: boolean) {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

async function savePdf(doc: PDFDocument, fileName: string, message: string, files: File[]) {
  const bytes = await doc.save();
  return output(fileName, new Blob([bytes.buffer as ArrayBuffer], { type: pdfMime }), message, files);
}

/* ------------------------------------------------------------------ */
/* Shared OOXML helpers                                                */
/* ------------------------------------------------------------------ */

function parseHexColor(value: string | undefined, fallback: { r: number; g: number; b: number }) {
  const clean = (value ?? '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16) / 255,
    g: Number.parseInt(clean.slice(2, 4), 16) / 255,
    b: Number.parseInt(clean.slice(4, 6), 16) / 255,
  };
}

/* ------------------------------------------------------------------ */
/* XLSX → PDF: styled spreadsheet print renderer                       */
/* ------------------------------------------------------------------ */

interface SheetRenderSpec {
  name: string;
  cells: Map<string, { text: string; bold: boolean; italic: boolean; underline: boolean; size: number; fontColor: { r: number; g: number; b: number }; fill: string | null; hAlign: 'left' | 'center' | 'right'; wrap: boolean; numFmt: string; borderTop: string | null; borderRight: string | null; borderBottom: string | null; borderLeft: string | null; formulaNote: boolean }>;
  merges: string[];
  colWidths: number[];
  rowHeights: number[];
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  printArea: string | null;
  titlesRow: string | null;
  orientation: 'portrait' | 'landscape';
  scale: number | null;
  fitToWidth: number | null;
  fitToHeight: number | null;
  paperSize: number | null;
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
  rowBreaks: number[];
  headerFooter: { oddHeader?: string; oddFooter?: string };
}

const DEFAULT_PAPER: Record<number, { w: number; h: number }> = {
  1: { w: 728.5, h: 1031.8 },   // Letter
  9: { w: 595.28, h: 841.89 },  // A4
  8: { w: 595.28, h: 841.89 },  // A3 small
  5: { w: 612, h: 1008 },       // Legal
  6: { w: 522, h: 756 },        // Statement
  7: { w: 522, h: 756 },        // Executive
  11: { w: 419.5, h: 595.28 },  // A5
  45: { w: 261.9, h: 467.7 },   // A6
};

/** Excel column width (chars) -> points; row height (points) stays as-is. */
function excelColWidthToPt(chars: number) {
  return Math.max(6, chars * 7 + 5);
}

/** Excel style number format -> rendered string (approximate, covering the common codes). */
function formatNumberWithPattern(value: number, numFmt: string): string | null {
  const fmt = numFmt.trim();
  if (!fmt || fmt === 'General') return null;
  // Drop Excel's color guards (e.g. [Red]) and character escapes before matching.
  const clean = fmt.replace(/\[[^\]]*\]/g, '').replace(/\\./g, m => m.slice(1)).replace(/"([^"]*)"/g, '$1').replace(/_/g, '').replace(/\*/g, '');
  // Currency like "$#,##0.00", "[$₹-en-IN]#,##0.00" or #,##0 with a literal ₹.
  const currencyMatch = /^([^#0,.]*)(#,##0(?:\.0+)?)(.*)$/.exec(clean);
  if (currencyMatch && (/[$₹€£¥]/.test(fmt) || (currencyMatch[1] && /^[^\d]*$/.test(currencyMatch[1])))) {
    const symbol = (currencyMatch[1] || '').trim() || (currencyMatch[3] || '').trim();
    if (symbol && /[$₹€£¥]/.test(symbol + fmt)) {
      const decimals = currencyMatch[2].split('.')[1]?.length ?? 0;
      const rendered = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true });
      const negative = value < 0 ? '-' : '';
      return `${negative}${symbol}${rendered.replace('-', '')}`;
    }
  }
  if (/^0\.(0+)$/.test(clean)) {
    const decimals = clean.split('.')[1].length;
    return value.toFixed(decimals);
  }
  if (/^#,##0$/.test(clean)) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (/^#,##0\.00$/.test(clean)) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (/^0\.?0*%$/.test(clean)) {
    const decimals = (clean.split('.')[1] ?? '').replace('%', '').length;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (/^yy|m|d/.test(clean)) {
    try {
      const serial = value;
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + Math.floor(serial));
      const pad = (n: number) => String(n).padStart(2, '0');
      if (/hh|mm|ss/.test(clean)) return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
      if (/yyyy/.test(clean)) return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse an A1-style range like "B3:D9" or a single cell into numeric bounds. */
function parseRange(range: string): { minRow: number; minCol: number; maxRow: number; maxCol: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.replace(/[$']/g, ''));
  if (!match) return null;
  const colToNum = (letters: string) => letters.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  return {
    minRow: Number(match[2]),
    minCol: colToNum(match[1]),
    maxRow: Number(match[4]),
    maxCol: colToNum(match[3]),
  };
}

async function loadSheetSpecs(file: File): Promise<SheetRenderSpec[]> {
  const ExcelJSMod = await import('exceljs');
  const workbook = new ExcelJSMod.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const specs: SheetRenderSpec[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.state === 'hidden') continue;
    const spec: SheetRenderSpec = {
      name: sheet.name,
      cells: new Map(),
      merges: [],
      colWidths: [],
      rowHeights: [],
      minRow: Number.MAX_SAFE_INTEGER,
      maxRow: 0,
      minCol: Number.MAX_SAFE_INTEGER,
      maxCol: 0,
      printArea: null,
      titlesRow: null,
      orientation: sheet.pageSetup?.orientation ?? 'portrait',
      scale: sheet.pageSetup?.scale ?? null,
      fitToWidth: sheet.pageSetup?.fitToPage ? sheet.pageSetup.fitToWidth ?? null : null,
      fitToHeight: sheet.pageSetup?.fitToPage ? sheet.pageSetup.fitToHeight ?? null : null,
      paperSize: sheet.pageSetup?.paperSize ?? null,
      margins: {
        left: sheet.pageSetup?.margins?.left ?? 0.7,
        right: sheet.pageSetup?.margins?.right ?? 0.7,
        top: sheet.pageSetup?.margins?.top ?? 0.75,
        bottom: sheet.pageSetup?.margins?.bottom ?? 0.75,
        header: sheet.pageSetup?.margins?.header ?? 0.3,
        footer: sheet.pageSetup?.margins?.footer ?? 0.3,
      },
      rowBreaks: (sheet.model?.rowBreaks ?? []).map((breakDef: { id?: number }) => breakDef.id ?? 0) ?? [],
      headerFooter: {
        oddHeader: (sheet.headerFooter?.oddHeader as string | undefined) ?? undefined,
        oddFooter: (sheet.headerFooter?.oddFooter as string | undefined) ?? undefined,
      },
    };
    const borderStyle = (style: string | undefined) => (style && style !== 'none' ? '1' : null);
    for (const row of sheet.getRows(1, sheet.rowCount) ?? []) {
      const rowIndex = row.number;
      if (rowIndex < 1) continue;
      spec.minRow = Math.min(spec.minRow, rowIndex);
      spec.maxRow = Math.max(spec.maxRow, rowIndex);
      row.eachCell({ includeEmpty: true }, (cellValue2: import('exceljs').Cell, colNumber: number) => {
        const col = colNumber;
        if (cellValue2.value === null || cellValue2.value === undefined) return;
        spec.minCol = Math.min(spec.minCol, col);
        spec.maxCol = Math.max(spec.maxCol, col);
        const style = cellValue2.style ?? {};
        let text = '';
        const cellValue = cellValue2.value;
        if (cellValue === null || cellValue === undefined) text = '';
        else if (typeof cellValue === 'object' && 'richText' in cellValue) {
          text = (cellValue as { richText: Array<{ text: string }> }).richText.map(part => part.text).join('');
        } else if (typeof cellValue === 'object' && 'formula' in cellValue) {
          const result = (cellValue as { result?: unknown }).result;
          if (result !== undefined && result !== null) text = String(result);
          else return;
        } else if (cellValue instanceof Date) {
          text = cellValue.toISOString().slice(0, 10);
        } else {
          text = String(cellValue);
        }
        const font = style.font ?? {};
        const fill = style.fill;
        let fillHex: string | null = null;
        if (fill && typeof fill === 'object' && 'type' in fill && fill.type === 'pattern') {
          const fg = (fill as { fgColor?: { argb?: string } }).fgColor;
          if (fg?.argb) fillHex = fg.argb.slice(2);
        }
        const alignment = style.alignment ?? {};
        const borders = style.border ?? {};
        const numeric = typeof cellValue === 'number' ? cellValue : null;
        const rendered = numeric !== null && style.numFmt ? (formatNumberWithPattern(numeric, style.numFmt) ?? String(cellValue)) : text;
        spec.cells.set(`${rowIndex},${col}`, {
          text: rendered,
          bold: !!font.bold,
          italic: !!font.italic,
          underline: !!font.underline,
          size: typeof font.size === 'number' ? font.size : 10,
          fontColor: typeof font.color?.argb === 'string'
            ? { r: Number.parseInt(font.color.argb.slice(2, 4), 16) / 255, g: Number.parseInt(font.color.argb.slice(4, 6), 16) / 255, b: Number.parseInt(font.color.argb.slice(6, 8), 16) / 255 }
            : { r: 0, g: 0, b: 0 },
          fill: fillHex,
          hAlign: alignment.horizontal === 'center' || alignment.horizontal === 'centerContinuous' ? 'center' : alignment.horizontal === 'right' ? 'right' : 'left',
          wrap: !!alignment.wrapText,
          numFmt: style.numFmt ?? '',
          borderTop: borderStyle(borders.top?.style),
          borderRight: borderStyle(borders.right?.style),
          borderBottom: borderStyle(borders.bottom?.style),
          borderLeft: borderStyle(borders.left?.style),
          formulaNote: false,
        });
      });
    }
    for (const merge of sheet.model?.merges ?? []) spec.merges.push(merge);
    for (let col = 1; col <= spec.maxCol; col += 1) {
      const width = sheet.getColumn(col).width;
      spec.colWidths[col] = typeof width === 'number' ? width : 8.43;
    }
    for (let row = 1; row <= spec.maxRow; row += 1) {
      const height = sheet.getRow(row).height;
      spec.rowHeights[row] = typeof height === 'number' ? height : 15;
    }
    const pageSetupObj = sheet.pageSetup as unknown as { printArea?: string; printTitlesRow?: string } | undefined;
    spec.printArea = pageSetupObj?.printArea ?? null;
    spec.titlesRow = pageSetupObj?.printTitlesRow ?? null;
    if (spec.maxRow === 0) continue;
    specs.push(spec);
  }
  return specs;
}

/* ------------------------------------------------------------------ */
/* Shared grid helpers                                                 */
/* ------------------------------------------------------------------ */

function wrapTextForCell(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [text];
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
  if (line) lines.push(line);
  return lines;
}

/** Is (row,col) covered by a merge whose anchor is a different cell? */
function isCoveredByMerge(mergeMap: Map<string, { rowSpan: number; colSpan: number }>, row: number, col: number) {
  for (const [key, span] of mergeMap) {
    const [anchorRow, anchorCol] = key.split(',').map(Number);
    if (row >= anchorRow && row < anchorRow + span.rowSpan && col >= anchorCol && col < anchorCol + span.colSpan) {
      return !(row === anchorRow && col === anchorCol);
    }
  }
  return false;
}

/** Convert an XLSX workbook to a PDF that mirrors the spreadsheet's print layout. */
export async function xlsxToPdf(file: File): Promise<ProcessedResult> {
  const specs = await loadSheetSpecs(file);
  if (!specs.length) throw new Error('This spreadsheet has no visible data to convert.');

  const doc = await PDFDocument.create();
  const fonts: FontSet = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  for (let specIndex = 0; specIndex < specs.length; specIndex += 1) {
    const spec = specs[specIndex];
    const paper = DEFAULT_PAPER[spec.paperSize ?? 9] ?? DEFAULT_PAPER[9];
    let pageW = paper.w;
    let pageH = paper.h;
    if (spec.orientation === 'landscape') [pageW, pageH] = [pageH, pageW];
    const marginL = spec.margins.left * 72;
    const marginR = spec.margins.right * 72;
    const marginT = spec.margins.top * 72;
    const marginB = spec.margins.bottom * 72;

    let minRow = spec.minRow;
    let maxRow = spec.maxRow;
    let minCol = spec.minCol;
    let maxCol = spec.maxCol;
    if (spec.printArea) {
      const area = parseRange(spec.printArea.split(',')[0]);
      if (area) {
        minRow = Math.max(minRow, area.minRow);
        maxRow = Math.min(maxRow, area.maxRow);
        minCol = Math.max(minCol, area.minCol);
        maxCol = Math.min(maxCol, area.maxCol);
      }
    }

    const widths: number[] = [];
    for (let col = minCol; col <= maxCol; col += 1) widths[col - minCol] = excelColWidthToPt(spec.colWidths[col] ?? 8.43);
    const heights: number[] = [];
    for (let row = minRow; row <= maxRow; row += 1) heights[row - minRow] = spec.rowHeights[row] ?? 15;

    const mergeMap = new Map<string, { rowSpan: number; colSpan: number }>();
    for (const merge of spec.merges) {
      const range = parseRange(merge);
      if (!range) continue;
      mergeMap.set(`${range.minRow},${range.minCol}`, { rowSpan: range.maxRow - range.minRow + 1, colSpan: range.maxCol - range.minCol + 1 });
    }

    // Print scale: fit-to-page or explicit percent.
    let scale = spec.scale !== null ? Math.min(4, Math.max(0.1, spec.scale / 100)) : 1;
    if (spec.fitToWidth !== null) {
      const totalW = widths.reduce((sum, width) => sum + width, 0);
      const available = pageW - marginL - marginR;
      scale = Math.min(scale, available / Math.max(1, totalW));
    }

    const breakSet = new Set(spec.rowBreaks);
    const chunks: number[][] = [];
    let chunk: number[] = [];
    for (let row = minRow; row <= maxRow; row += 1) {
      chunk.push(row);
      if (breakSet.has(row)) {
        chunks.push(chunk);
        chunk = [];
      }
    }
    if (chunk.length) chunks.push(chunk);

    for (const pageChunk of chunks) {
      const repeatHeaders = spec.titlesRow ? parseRange(spec.titlesRow) : null;
      const headerRows: number[] = [];
      if (repeatHeaders && pageChunk.length && pageChunk[0] > repeatHeaders.maxRow) {
        for (let row = repeatHeaders.minRow; row <= repeatHeaders.maxRow; row += 1) headerRows.push(row);
      }
      const renderRows = [...headerRows, ...pageChunk].filter(row => row >= minRow && row <= maxRow);
      const page = doc.addPage([pageW, pageH]);
      let y = pageH - marginT;

      // Sheet name banner when the workbook has multiple sheets.
      if (specs.length > 1) {
        page.drawText(pdfSafeText(spec.name), { x: marginL, y: y - 11, size: 9, font: fonts.bold, color: rgb(0.38, 0.41, 0.45) });
        y -= 18;
      }

      const tableWidth = widths.reduce((sum, width) => sum + width, 0) * scale;
      let x0 = marginL;
      if (tableWidth < pageW - marginL - marginR) x0 = marginL + ((pageW - marginL - marginR) - tableWidth) / 2;

      for (const row of renderRows) {
        const rowH = (heights[row - minRow] ?? 15) * scale;
        let x = x0;
        for (let col = minCol; col <= maxCol; col += 1) {
          const anchor = mergeMap.get(`${row},${col}`);
          const cellW = anchor
            ? widths.slice(col - minCol, col - minCol + anchor.colSpan).reduce((sum, width) => sum + width, 0) * scale
            : widths[col - minCol] * scale;
          const covered = isCoveredByMerge(mergeMap, row, col);
          if (covered) {
            x += cellW;
            continue;
          }
          const cell = spec.cells.get(`${row},${col}`);
          if (cell) {
            const font = fontFor(fonts, cell.bold, cell.italic);
            if (cell.fill) {
              page.drawRectangle({ x, y: y - rowH, width: cellW, height: rowH, color: parseHexColorFill(cell.fill) });
            }
            const textSize = Math.max(4, cell.size * scale);
            const lines = cell.wrap && cell.text ? wrapTextForCell(cell.text, font, textSize, Math.max(8, cellW - 6)) : [cell.text];
            const maxLines = Math.max(1, Math.floor(rowH / (textSize * 1.25)));
            const maxLineW = Math.max(...lines.map(line => font.widthOfTextAtSize(line, textSize)), 1);
            let textX = x + 3;
            if (cell.hAlign === 'center') textX = x + Math.max(0, (cellW - maxLineW) / 2);
            else if (cell.hAlign === 'right') textX = x + Math.max(0, cellW - maxLineW - 3);
            let textY = y - Math.min(rowH / 2 + textSize * 0.36, rowH - textSize - 2);
            for (const line of lines.slice(0, maxLines)) {
              if (textY < y - rowH + 1) break;
              page.drawText(pdfSafeText(line), { x: textX, y: textY, size: textSize, font, color: rgb(cell.fontColor.r, cell.fontColor.g, cell.fontColor.b) });
              textY -= textSize * 1.25;
            }
            const gray = rgb(0.72, 0.74, 0.78);
            if (cell.borderTop) page.drawLine({ start: { x, y }, end: { x: x + cellW, y }, thickness: 0.7, color: gray });
            if (cell.borderBottom) page.drawLine({ start: { x, y: y - rowH }, end: { x: x + cellW, y: y - rowH }, thickness: 0.7, color: gray });
            if (cell.borderLeft) page.drawLine({ start: { x, y }, end: { x, y: y - rowH }, thickness: 0.7, color: gray });
            if (cell.borderRight) page.drawLine({ start: { x: x + cellW, y }, end: { x: x + cellW, y: y - rowH }, thickness: 0.7, color: gray });
          }
          x += cellW;
        }
        y -= rowH;
      }

      page.drawText(pdfSafeText(`${spec.name} — page ${doc.getPageCount()}`), { x: marginL, y: Math.max(12, marginB / 2), size: 8, font: fonts.regular, color: rgb(0.5, 0.53, 0.57) });
    }
  }

  const pageCount = doc.getPageCount();
  const sheetNames = specs.map(item => item.name).join(', ');
  return savePdf(doc, `${baseName(file.name)}.pdf`, `Converted the workbook into a ${pageCount}-page PDF preserving cell formatting (fonts, fills, borders, merged cells, number formats), column widths, row heights, page orientation, print area, manual page breaks and sheet order (${sheetNames}).`, [file]);
}

/* ------------------------------------------------------------------ */
/* PDF → DOCX: layout-aware reconstruction                             */
/* ------------------------------------------------------------------ */

function findBorderedTables(lines: Array<{ x1: number; y1: number; x2: number; y2: number }>): Array<{ xs: number[]; ys: number[] }> {
  const hLines = lines.filter(line => Math.abs(line.y1 - line.y2) < 0.6 && Math.abs(line.x2 - line.x1) > 12);
  const vLines = lines.filter(line => Math.abs(line.x1 - line.x2) < 0.6 && Math.abs(line.y2 - line.y1) > 6);
  if (hLines.length < 2 || vLines.length < 2) return [];

  const collect = (values: number[], tolerance: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const clusters: number[] = [];
    for (const value of sorted) {
      const last = clusters[clusters.length - 1];
      if (last !== undefined && Math.abs(value - last) <= tolerance) continue;
      clusters.push(value);
    }
    return clusters;
  };

  const xs = collect(vLines.map(line => line.x1), 3);
  const ys = collect(hLines.map(line => line.y1), 3);
  if (xs.length < 2 || ys.length < 2) return [];

  // A real grid: most horizontal lines span most of the table width and there are several long verticals.
  const spanH = hLines.filter(line => Math.abs((line.x2 - line.x1) - (xs[xs.length - 1] - xs[0])) < 30).length;
  const longV = vLines.filter(line => line.y2 - line.y1 > (ys[ys.length - 1] - ys[0]) * 0.3).length;
  if (spanH < ys.length * 0.5 || longV < 2) return [];
  return [{ xs, ys }];
}

/** Group pdf.js text items into visual rows (PDF y grows up; rows sorted top-down). */
function rowsFromItems(items: Array<{ str: string; x: number; y: number; w: number; size: number }>): Array<Array<{ str: string; x: number; y: number; w: number; size: number }>> {
  const usable = items.filter(item => item.str.trim());
  const rows: Array<Array<{ str: string; x: number; y: number; w: number; size: number }>> = [];
  for (const item of usable) {
    const row = rows.find(candidate => Math.abs(candidate[0].y - item.y) <= Math.max(2.5, item.size * 0.45));
    if (row) row.push(item);
    else rows.push([item]);
  }
  rows.sort((a, b) => b[0].y - a[0].y);
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

/** Split a visual row into cells when inter-item gaps exceed a word-space threshold. */
/**
 * Convert a PDF into an editable XLSX. Each detected table becomes a real
 * worksheet with typed cells (numbers, currency, percentages stay numeric;
 * identifiers keep leading zeros as text), bold headers, sized columns and
 * thin borders. Vector gridlines are used when present, otherwise x-position
 * clustering. Scanned PDFs are rejected with clear guidance (use OCR first).
 */
export async function pdfToXlsx(file: File): Promise<ProcessedResult> {
  const ExcelJSMod = await import('exceljs');
  const workbook = new ExcelJSMod.Workbook();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  let textChars = 0;
  let tableCount = 0;
  let usedColumns = 0;

  try {
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      const items = content.items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return [];
        const transform = item.transform as number[];
        return [{ str: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0, w: (item as { width?: number }).width ?? 0, size: Math.abs(transform[3] ?? 10) }];
      });
      textChars += items.reduce((sum, item) => sum + item.str.length, 0);
      if (!items.length) {
        page.cleanup();
        continue;
      }

      // Vector gridlines for bordered tables (same parser as PDF→DOCX).
      const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      try {
        const opList = await page.getOperatorList();
        const transforms: number[][] = [];
        let current: number[] = [1, 0, 0, 1, 0, 0];
        for (let i = 0; i < opList.fnArray.length; i += 1) {
          const fn = opList.fnArray[i];
          if (fn === pdfjsLib.OPS.save) transforms.push([...current]);
          else if (fn === pdfjsLib.OPS.restore) current = transforms.pop() ?? [1, 0, 0, 1, 0, 0];
          else if (fn === pdfjsLib.OPS.transform) {
            const [a, b, c, d, e, f] = opList.argsArray[i] as number[];
            current = [
              current[0] * a + current[2] * b,
              current[1] * a + current[3] * b,
              current[0] * c + current[2] * d,
              current[1] * c + current[3] * d,
              current[0] * e + current[2] * f + current[4],
              current[1] * e + current[3] * f + current[5],
            ];
          } else if (fn === pdfjsLib.OPS.constructPath) {
            const args = opList.argsArray[i] as unknown[];
            const data = args[0] as number[];
            if (!Array.isArray(data)) continue;
            const apply = (x: number, y: number) => ({
              x: current[0] * x + current[2] * y + current[4],
              y: current[1] * x + current[3] * y + current[5],
            });
            let k = 0;
            let start: { x: number; y: number } | null = null;
            let point: { x: number; y: number } | null = null;
            while (k < data.length) {
              const op = data[k++];
              if (op === 0) { start = { x: data[k++], y: data[k++] }; point = start; }
              else if (op === 1 && point) {
                const from = apply(point.x, point.y);
                const to = apply(data[k], data[k + 1]);
                k += 2;
                lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
                point = { x: data[k - 2], y: data[k - 1] };
              } else if (op === 2 && point) { k += 6; }
              else if (op === 3 && point) { k += 4; }
              else if (op === 4 && start && point) {
                const from = apply(point.x, point.y);
                const to = apply(start.x, start.y);
                lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
                point = start;
              } else break;
            }
          }
        }
      } catch {
        // Whitespace clustering fallback still applies.
      }

      const borderedTables = findBorderedTables(lines);
      const rows = rowsFromItems(items);

      if (borderedTables.length) {
        // Bordered tables: assign each text item to its grid cell.
        for (const table of borderedTables) {
          const sheet = workbook.addWorksheet(`Page${pageIndex} Table${tableCount + 1}`);
          tableCount += 1;
          const grid = new Map<string, string>();
          const colWidths: number[] = new Array(table.xs.length - 1).fill(0);
          for (const item of items) {
            if (item.y < table.ys[0] - 4 || item.y > table.ys[table.ys.length - 1] + 4) continue;
            let col = -1;
            for (let i = 0; i < table.xs.length - 1; i += 1) {
              const left = table.xs[i];
              const right = table.xs[i + 1];
              const center = item.x + item.w / 2;
              if (center >= left - 2 && center <= right + 2) { col = i; break; }
            }
            let rowIdx = -1;
            for (let i = 0; i < table.ys.length - 1; i += 1) {
              const top = table.ys[i + 1];
              const bottom = table.ys[i];
              if (item.y >= top - 1 && item.y <= bottom + 1) { rowIdx = i; break; }
            }
            if (col === -1 || rowIdx === -1) continue;
            const key = `${rowIdx},${col}`;
            grid.set(key, grid.has(key) ? `${grid.get(key)} ${item.str}` : item.str);
            colWidths[col] = Math.max(colWidths[col], item.str.length + 2);
          }
          const maxRow = Math.max(...[...grid.keys()].map(key => Number(key.split(',')[0]))) + 1;
          for (let r = 0; r < maxRow; r += 1) {
            const rowValues: Array<{ text: string; bold: boolean }> = [];
            for (let c = 0; c < table.xs.length - 1; c += 1) {
              rowValues.push({ text: grid.get(`${r},${c}`) ?? '', bold: r === 0 });
            }
            appendTypedRow(sheet, r + 1, rowValues);
          }
          colWidths.forEach((width, index) => {
            sheet.getColumn(index + 1).width = Math.max(9, Math.min(60, width));
          });
          styleSheetHeader(sheet, Math.max(...[...grid.keys()].map(key => Number(key.split(',')[0]))) + 1, table.xs.length - 1);
          usedColumns = Math.max(usedColumns, table.xs.length - 1);
        }
        page.cleanup();
        continue;
      }

      // Whitespace-aligned tables via x-coordinate clustering (existing logic, upgraded).
      const pageTables = clusterTables(rows);
      for (const tableRows of pageTables) {
        if (tableRows.length < 2) continue;
        tableCount += 1;
        const sheet = workbook.addWorksheet(`Page${pageIndex} Table${tableCount}`);
        tableRows.forEach((row, rowIndex) => {
          appendTypedRow(sheet, rowIndex + 1, row.map(label => ({ text: label, bold: rowIndex === 0 })));
        });
        const columnCount = Math.max(...tableRows.map(row => row.length));
        for (let c = 1; c <= columnCount; c += 1) {
          let width = 9;
          for (const row of tableRows) {
            const value = row[c - 1] ?? '';
            width = Math.max(width, value.length + 2);
          }
          sheet.getColumn(c).width = Math.max(9, Math.min(60, width));
        }
        styleSheetHeader(sheet, tableRows.length, columnCount);
        usedColumns = Math.max(usedColumns, columnCount);
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  if (textChars < 20) {
    throw new Error('This PDF appears to be scanned (image-only). Use the OCR PDF tool first, then convert its text-based output to Excel.');
  }
  if (!tableCount) {
    throw new Error('No column-aligned tables were detected in this PDF — the text is not laid out in rows and columns. Try PDF to Word for plain text.');
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: xlsxMime });
  return output(`${baseName(file.name)}.xlsx`, blob, `Extracted ${tableCount} table${tableCount === 1 ? '' : 's'} (${usedColumns} columns detected) into an editable Excel workbook: values are typed as real numbers, currency, percentages or text (identifiers keep leading zeros), headers are bold with borders, and column widths fit the content.`, [file]);
}

function parseHexColorFill(value: string | null | undefined) {
  const c = parseHexColor(value ?? '', { r: 0.95, g: 0.95, b: 0.95 });
  return rgb(c.r, c.g, c.b);
}

/** Typed value for PDF→Excel: never invents formulas; keeps identifiers as text. */
function classifyCell(raw: string): { value: string | number; numFmt?: string } {
  const text = raw.trim();
  if (!text) return { value: '' };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    return { value: Number(text.replace(/,/g, '')), numFmt: text.includes('.') ? '#,##0.00' : '#,##0' };
  }
  if (/^-?\d+\.\d+$/.test(text) && text.length <= 15) return { value: Number(text), numFmt: `0.${'0'.repeat(text.split('.')[1].length)}` };
  if (/^-?\d+$/.test(text)) {
    // Preserve leading zeros as text (IDs like 007).
    if (text.length > 1 && text.startsWith('0')) return { value: text };
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) && Math.abs(numeric) < 1e15 ? { value: numeric } : { value: text };
  }
  const currency = /^([\u0024\u20A8\u20B9\u20AC\u00A3\u00A5])(-?[\d,]+(?:\.\d+)?)$/.exec(text);
  if (currency) {
    const num = Number(currency[2].replace(/,/g, ''));
    if (Number.isFinite(num)) return { value: num, numFmt: `"${currency[1]}"#,##0${currency[2].includes('.') ? '.00' : ''}` };
  }
  const percent = /^(-?[\d,]+(?:\.\d+)?)%$/.exec(text);
  if (percent) {
    const num = Number(percent[1].replace(/,/g, ''));
    if (Number.isFinite(num)) return { value: num / 100, numFmt: '0.00%' };
  }
  // Dates are kept as text unless confidently parseable, to avoid corrupting IDs.
  return { value: text };
}

/** Write one row of classified values into the sheet with borders. */
function appendTypedRow(sheet: import('exceljs').Worksheet, rowIndex: number, cells: Array<{ text: string; bold: boolean }>) {
  const row = sheet.getRow(rowIndex);
  cells.forEach((cell, index) => {
    const target = row.getCell(index + 1);
    const classified = classifyCell(cell.text);
    target.value = classified.value;
    if (classified.numFmt) target.numFmt = classified.numFmt;
    if (cell.bold) target.font = { ...target.font, bold: true };
    target.border = {
      top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
    };
    if (typeof classified.value === 'string' && classified.value.length > 30) {
      target.alignment = { wrapText: true, vertical: 'top' };
    }
  });
  row.commit();
}

/** Bold header + freeze + subtle fill for detected tables. */
function styleSheetHeader(sheet: import('exceljs').Worksheet, rowCount: number, columnCount: number) {
  if (rowCount < 1 || columnCount < 1) return;
  for (let c = 1; c <= columnCount; c += 1) {
    const header = sheet.getRow(1).getCell(c);
    header.font = { ...header.font, bold: true, color: { argb: 'FF1F2933' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F3F7' } };
    header.alignment = { horizontal: 'left', vertical: 'middle' };
  }
  sheet.getRow(1).height = 18;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Whitespace-aligned table detection using repeated x-position edges across rows. */
function clusterTables(rows: Array<Array<{ str: string; x: number; y: number; w: number; size: number }>>): string[][][] {
  const candidateRows = rows.filter(row => row.length >= 2);
  if (candidateRows.length < 2) return [];
  const columnEdges = new Map<number, number>();
  for (const row of candidateRows) {
    for (const item of row) {
      const key = Math.round(item.x / 8) * 8;
      columnEdges.set(key, (columnEdges.get(key) ?? 0) + 1);
    }
  }
  const frequent = [...columnEdges.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.floor(candidateRows.length * 0.5)))
    .map(([x]) => x)
    .sort((a, b) => a - b);
  if (frequent.length < 2) return [];

  const assign = (row: Array<{ str: string; x: number }>) => {
    const cells: string[] = new Array(frequent.length).fill('');
    for (const item of row) {
      let column = 0;
      for (let edge = 0; edge < frequent.length; edge += 1) {
        if (item.x >= frequent[edge] - 6) column = edge;
      }
      cells[column] = cells[column] ? `${cells[column]} ${item.str}`.trim() : item.str;
    }
    return cells;
  };

  const tables: string[][][] = [];
  let current: string[][] = [];
  for (const row of rows) {
    const isCandidate = row.length >= 2 && row.some(item => frequent.some(edge => Math.abs(item.x - edge) <= 6));
    if (isCandidate) {
      current.push(assign(row));
    } else if (current.length >= 2) {
      tables.push(current);
      current = [];
    } else {
      current = [];
    }
  }
  if (current.length >= 2) tables.push(current);
  return tables;
}

/* ------------------------------------------------------------------ */
/* DOCX → PDF: raw OOXML walker                                        */
/* ------------------------------------------------------------------ */



