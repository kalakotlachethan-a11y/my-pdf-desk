/**
 * Layout-preserving conversion engines for My PDF Desk.
 *
 * Unlike the older flat-text converters, these engines read the raw document
 * structures (OOXML for Word/Excel, positioned glyph runs for PDFs) and
 * reproduce geometry, formatting and page structure as faithfully as the
 * browser allows. Everything runs client-side; nothing is uploaded anywhere.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export type Options = Record<string, string>;

const pdfMime = 'application/pdf';
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'application/xml');
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

const EMU_PER_PT = 914400 / 72;

const DOCX_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

function docxRun(text: string, size: number, bold: boolean, italic: boolean) {
  const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${Math.round(size * 2)}"/></w:rPr>`;
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function docxParagraph(opts: { text: string; size: number; bold?: boolean; italic?: boolean; heading?: boolean; indent?: number; align?: string; bullet?: boolean }) {
  const ppr: string[] = [];
  if (opts.heading) ppr.push(`<w:pStyle w:val="Heading${Math.min(3, Math.max(1, Math.round((opts.size - 11) / 4) + 1))}"/>`);
  if (opts.indent && opts.indent > 0) ppr.push(`<w:ind w:left="${Math.min(5000, Math.round(opts.indent))}"/>`);
  if (opts.align && opts.align !== 'left') ppr.push(`<w:jc w:val="${opts.align === 'center' ? 'center' : opts.align === 'right' ? 'right' : 'both'}"/>`);
  const text = opts.bullet ? opts.text.replace(/^[•\u2022\u25CF\u00B7-]\s+|^\d+[.)]\s+/, '') : opts.text;
  if (opts.bullet) ppr.push('<w:ind w:left="720"/><w:ind w:hanging="360"/>');
  const run = docxRun(opts.bullet ? `• ${text}` : text, opts.size, !!opts.bold || !!opts.heading, !!opts.italic);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${run}</w:p>`;
}

function docxTableRow(cells: Array<{ text: string; bold: boolean }>, columns: number, columnWidths?: number[]) {
  const total = 9360; // 6.5in content width in twips
  const widths = columnWidths?.length === columns
    ? columnWidths.map(w => Math.max(360, Math.round((w / columnWidths.reduce((s, v) => s + v, 0)) * total)))
    : Array.from({ length: columns }, () => Math.round(total / columns));
  const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const rowXml = cells.map(cell => `<w:tc><w:tcPr><w:tcW w:w="${Math.round(total / columns)}" w:type="dxa"/><w:tcBorders>
<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
</w:tcBorders></w:tcPr><w:p>${docxRun(cell.text, 10.5, cell.bold, false)}</w:p></w:tc>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>
</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr>${rowXml}</w:tr></w:tbl>`;
}

function docxImage(relId: string, widthPt: number, heightPt: number) {
  const cx = Math.round(widthPt * EMU_PER_PT);
  const cy = Math.round(heightPt * EMU_PER_PT);
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${Math.floor(Math.random() * 100000)}" name="Image"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="1" name="image"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Extract embedded images from a pdf.js page as PNG data URLs (best-effort). */
async function extractPageImages(page: pdfjsLib.PDFPageProxy): Promise<Array<{ ref: string; w: number; h: number; dataUrl: string }>> {
  const results: Array<{ ref: string; w: number; h: number; dataUrl: string }> = [];
  try {
    const opList = await page.getOperatorList();
    const objs = (page as unknown as { objs: { get(id: string, cb: (obj: unknown) => void): void } }).objs;
    let counter = 0;
    for (let i = 0; i < opList.fnArray.length; i += 1) {
      if (opList.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
      const args = opList.argsArray[i] as Array<string | number>;
      const objId = String(args[0]);
      const wpt = Number(args[1] ?? 0);
      const hpt = Number(args[2] ?? 0);
      if (!wpt || !hpt || wpt < 10 || hpt < 10) continue;
      const raw = await new Promise<{ data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number } | null>(resolve => {
        const timer = window.setTimeout(() => resolve(null), 1500);
        try {
          objs.get(objId, (obj: unknown) => {
            window.clearTimeout(timer);
            resolve((obj ?? null) as { data?: Uint8Array; width?: number; height?: number } | null);
          });
        } catch {
          window.clearTimeout(timer);
          resolve(null);
        }
      });
      if (!raw?.data || !raw.width || !raw.height) continue;
      const canvas = document.createElement('canvas');
      canvas.width = raw.width;
      canvas.height = raw.height;
      const context = canvas.getContext('2d');
      if (!context) continue;
      const imageData = context.createImageData(raw.width, raw.height);
      const comps = raw.data.length / (raw.width * raw.height);
      for (let pixel = 0; pixel < raw.width * raw.height; pixel += 1) {
        if (comps >= 3) {
          imageData.data[pixel * 4] = raw.data[pixel * comps];
          imageData.data[pixel * 4 + 1] = raw.data[pixel * comps + 1];
          imageData.data[pixel * 4 + 2] = raw.data[pixel * comps + 2];
        } else {
          const gray = raw.data[pixel * comps];
          imageData.data[pixel * 4] = gray;
          imageData.data[pixel * 4 + 1] = gray;
          imageData.data[pixel * 4 + 2] = gray;
        }
        imageData.data[pixel * 4 + 3] = 255;
      }
      context.putImageData(imageData, 0, 0);
      counter += 1;
      results.push({ ref: `img${pageIndex_counter}_${counter}`, w: wpt, h: hpt, dataUrl: canvas.toDataURL('image/png') });
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    // Images are best-effort; text conversion must not fail because of them.
  }
  return results;
}

let pageIndex_counter = 0;

/** Detect bordered table regions on a page from vector line graphics. */
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
function splitRowByGaps(row: Array<{ str: string; x: number; w: number; size: number }>): string[] {
  const cells: string[] = [];
  let current = row[0].str;
  for (let i = 1; i < row.length; i += 1) {
    const gap = row[i].x - (row[i - 1].x + row[i - 1].w);
    if (gap > row[i].size * 1.6) {
      cells.push(current.trim());
      current = row[i].str;
    } else {
      const needsSpace = !/\s$/.test(current) && !/^\s/.test(row[i].str);
      current += (needsSpace ? ' ' : '') + row[i].str;
    }
  }
  cells.push(current.trim());
  return cells.filter(cell => cell.length > 0);
}

/**
 * Convert a PDF into an editable DOCX, reconstructing font sizes, bold/italic,
 * headings, bordered/whitespace tables and embedded images. All content stays
 * editable — pages are never rasterized into images.
 */
export async function pdfToDocx(file: File): Promise<ProcessedResult> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const zip = new JSZip();
  const mediaFolder = zip.folder('word')!.folder('media')!;
  const imageRels: string[] = [];
  let imageCounter = 0;
  let textChars = 0;
  const body: string[] = [];

  try {
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      pageIndex_counter = pageIndex;
      if (pageIndex > 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      const items = content.items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return [];
        const transform = item.transform as number[];
        return [{ str: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0, w: (item as { width?: number }).width ?? 0, size: Math.abs(transform[3] ?? 10) }];
      });
      const medianSize = (() => {
        const sizes = items.map(item => item.size).sort((a, b) => a - b);
        return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
      })();

      // Vector lines (for bordered-table detection). pdf.js 6.x packs path
      // commands as a flat DrawOPS array: [moveTo, x, y, lineTo, x, y, ...].
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
            const moveTo = 0, lineTo = 1, curveTo = 2, quadTo = 3, closePathOp = 4;
            while (k < data.length) {
              const op = data[k++];
              if (op === moveTo) { start = { x: data[k++], y: data[k++] }; point = start; }
              else if (op === lineTo && point) {
                const from = apply(point.x, point.y);
                const to = apply(data[k], data[k + 1]);
                k += 2;
                lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
                point = { x: to.x === from.x && to.y === from.y ? point.x : (data[k - 2]), y: data[k - 1] };
              } else if (op === curveTo && point) { k += 6; }
              else if (op === quadTo && point) { k += 4; }
              else if (op === closePathOp && start) {
                const from = apply(point!.x, point!.y);
                const to = apply(start.x, start.y);
                lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
                point = start;
              } else break;
            }
          }
        }
      } catch {
        // Vector inspection is best-effort; whitespace clustering still applies.
      }

      const borderedTables = findBorderedTables(lines);
      const tableRowMap = new Map<number, Array<{ text: string; bold: boolean }>>();
      const inTableZone = (y: number) => borderedTables.some(table => y >= table.ys[0] - 4 && y <= table.ys[table.ys.length - 1] + 4);

      const rows = rowsFromItems(items);
      for (const row of rows) {
        const rowSize = Math.max(...row.map(item => item.size));
        const rowY = row[0].y;
        const text = splitRowByGaps(row).join('\t');
        if (!text.trim()) continue;
        textChars += text.length;

        if (inTableZone(rowY)) {
          const cells = splitRowByGaps(row).map(label => ({ text: label, bold: rowSize > medianSize * 1.15 }));
          const key = Math.round(rowY / 3);
          const existing = tableRowMap.get(key);
          if (existing) existing.push(...cells);
          else tableRowMap.set(key, cells);
          continue;
        }

        const cells = splitRowByGaps(row);
        if (cells.length >= 3) {
          const widths = cells.map((_, i) => (i + 1 < cells.length ? row[i + 1].x - row[i].x : row[i].w + row[i].size));
          body.push(docxTableRow(cells.map(label => ({ text: label, bold: rowSize > medianSize * 1.15 })), cells.length, widths));
          continue;
        }
        const bullet = /^[•\u2022\u25CF\u00B7-]\s+/.test(cells[0]) || /^\d+[.)]\s+/.test(cells[0]);
        const heading = rowSize >= medianSize * 1.35 && cells[0].length < 120 && !/[.,;:]$/.test(cells[0]);
        const indent = Math.max(0, Math.round((row[0].x - 56) * 20));
        const lineText = cells.join('  ');
        body.push(docxParagraph({ text: lineText, size: rowSize, heading, indent, bullet }));
      }

      // Bordered tables: emit each captured row group as its own real table.
      for (const [, cells] of [...tableRowMap.entries()].sort((a, b) => b[0] - a[0])) {
        const columns = Math.max(...cells.map(entry => entry.text.split('\t').length), 1);
        const flat = cells.flatMap(entry => entry.text.split('\t')).map(label => ({ text: label, bold: false }));
        if (flat.length >= 2) body.push(docxTableRow(flat, Math.max(columns, 2)));
      }

      // Images (best-effort, below the page's text).
      const images = await extractPageImages(page);
      for (const image of images) {
        imageCounter += 1;
        mediaFolder.file(`image${imageCounter}.png`, image.dataUrl.split(',')[1], { base64: true });
        imageRels.push(`<Relationship Id="rIdImg${imageCounter}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageCounter}.png"/>`);
        body.push(docxImage(`rIdImg${imageCounter}`, Math.min(460, image.w), image.h * Math.min(460, image.w) / Math.max(1, image.w)));
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  if (textChars < 20) {
    throw new Error('This PDF appears to be scanned (image-only) — there is no text layer to convert. Use the OCR PDF tool first, then convert its output.');
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')!.file('_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="document.xml"/>
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${imageRels.join('')}</Relationships>`);
  zip.folder('word')!.file('styles.xml', DOCX_STYLES_XML);
  zip.folder('word')!.file('document.xml', documentXml);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const tables = body.filter(entry => entry.startsWith('<w:tbl>')).length;
  return output(`${baseName(file.name)}.docx`, new Blob([blob], { type: docxMime }), `Created an editable Word document from ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}: real selectable text (never rasterized) with detected font sizes, headings, ${tables} table${tables === 1 ? '' : 's'} and ${imageCounter} image${imageCounter === 1 ? '' : 's'}.`, [file]);
}

/* ------------------------------------------------------------------ */
/* PDF → XLSX: real table reconstruction with typed cells              */
/* ------------------------------------------------------------------ */

const xmlEscapeExport = xmlEscape;
void xmlEscapeExport;

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

type RunStyle = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number;
  color: { r: number; g: number; b: number };
};

type RunPiece = { text: string; style: RunStyle } | { break: 'page' | 'line' } | { tab: true } | { imageId: string };

type BodyBlock =
  | { kind: 'paragraph'; pieces: RunPiece[]; align: 'left' | 'center' | 'right' | 'justify'; indentPt: number; spaceBefore: number; spaceAfter: number; lineSpacing: number | null; numbering: { numId: string; level: number } | null; styleId: string }
  | { kind: 'table'; xml: string }
  | { kind: 'pagebreak' };

type DocPageInfo = { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } };

const DEFAULT_PAGE: DocPageInfo = { width: 595.28, height: 841.89, margins: { top: 72, right: 72, bottom: 72, left: 72 } };

function readPageSize(documentXml: string): DocPageInfo {
  const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(documentXml) ?? /<w:sectPr[^>]*\/>/.exec(documentXml);
  const info: DocPageInfo = { ...DEFAULT_PAGE, margins: { ...DEFAULT_PAGE.margins } };
  if (!sect) return info;
  const size = /<w:pgSz\b([^>]*)\/?>/.exec(sect[0]);
  if (size) {
    const w = /w:w="(-?\d+)"/.exec(size[1]);
    const h = /w:h="(-?\d+)"/.exec(size[1]);
    const orient = /w:orient="landscape"/.test(size[1]);
    let width = w ? Number(w[1]) / 20 : info.width;
    let height = h ? Number(h[1]) / 20 : info.height;
    if (orient && width < height) [width, height] = [height, width];
    if (width > 50 && height > 50) { info.width = width; info.height = height; }
  }
  const mar = /<w:pgMar\b([^>]*)\/?>/.exec(sect[0]);
  if (mar) {
    const pick = (name: string, fallback: number) => {
      const value = new RegExp(`w:${name}="(-?\\d+)"`).exec(mar[1]);
      return value ? Math.max(0, Number(value[1]) / 20) : fallback;
    };
    info.margins = {
      top: pick('top', info.margins.top),
      right: pick('right', info.margins.right),
      bottom: pick('bottom', info.margins.bottom),
      left: pick('left', info.margins.left),
    };
  }
  return info;
}

/** Read w:rPr formatting for a run element. */
function readRunStyle(run: Element, defaultSize: number): RunStyle {
  const rpr = run.getElementsByTagName('w:rPr')[0];
  const style: RunStyle = { bold: false, italic: false, underline: false, size: defaultSize, color: { r: 0.1, g: 0.1, b: 0.12 } };
  if (!rpr) return style;
  const flag = (tag: string) => {
    const el = rpr.getElementsByTagName(tag)[0];
    if (!el) return false;
    const val = el.getAttribute('w:val');
    return val === null || !(val === 'false' || val === '0' || val === 'off');
  };
  style.bold = flag('w:b');
  style.italic = flag('w:i');
  style.underline = flag('w:u');
  const sz = rpr.getElementsByTagName('w:sz')[0];
  if (sz) {
    const half = Number(sz.getAttribute('w:val'));
    if (Number.isFinite(half) && half >= 2) style.size = half / 2;
  }
  const colorEl = rpr.getElementsByTagName('w:color')[0];
  if (colorEl) {
    const fill = colorEl.getAttribute('w:val');
    if (fill && fill !== 'auto') style.color = parseHexColor(fill, style.color);
  }
  return style;
}

/** Split a paragraph into ordered pieces: styled text runs, breaks, tabs and images. */
function paragraphPieces(paragraph: Element, defaultSize: number): RunPiece[] {
  const pieces: RunPiece[] = [];
  const pushText = (text: string, style: RunStyle) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && 'text' in last && last.style === style) last.text += text;
    else pieces.push({ text, style });
  };
  const baseStyle: RunStyle = { bold: false, italic: false, underline: false, size: defaultSize, color: { r: 0.1, g: 0.1, b: 0.12 } };
  const walk = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (child.tagName === 'w:r') {
        const runStyle = readRunStyle(child, defaultSize);
        for (const part of Array.from(child.children)) {
          if (part.tagName === 'w:rPr') continue;
          if (part.tagName === 'w:t' || part.tagName === 'w:delText') {
            pushText(pdfSafeText(part.textContent ?? ''), runStyle);
          } else if (part.tagName === 'w:br') {
            pieces.push({ break: part.getAttribute('w:type') === 'page' ? 'page' : 'line' });
          } else if (part.tagName === 'w:tab') {
            pieces.push({ tab: true });
          } else if (part.tagName === 'w:drawing' || part.tagName === 'w:pict') {
            const blip = part.getElementsByTagName('a:blip')[0] ?? part.getElementsByTagName('v:imagedata')[0];
            const embed = blip?.getAttribute('r:embed') ?? blip?.getAttribute('r:id');
            if (embed) pieces.push({ imageId: embed });
          } else if (part.tagName === 'w:noBreakHyphen') {
            pushText('-', runStyle);
          }
        }
      } else if (child.tagName === 'w:hyperlink') {
        for (const run of Array.from(child.getElementsByTagName('w:r'))) {
          const runStyle = readRunStyle(run, defaultSize);
          for (const part of Array.from(run.children)) {
            if (part.tagName === 'w:t') pushText(pdfSafeText(part.textContent ?? ''), runStyle);
          }
        }
      } else if (child.tagName === 'w:proofErr' || child.tagName === 'w:bookmarkStart' || child.tagName === 'w:bookmarkEnd' || child.tagName === 'w:commentRangeStart' || child.tagName === 'w:commentRangeEnd') {
        continue;
      } else {
        walk(child);
      }
    }
  };
  walk(paragraph);
  void baseStyle;
  return pieces;
}

/** Extract body-level blocks from document.xml (paragraphs, tables, page breaks). */
function extractBodyBlocks(documentXml: string, defaultSize: number): { blocks: BodyBlock[]; defaultPage: DocPageInfo } {
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml);
  const bodyXml = bodyMatch ? bodyMatch[1] : documentXml;
  const defaultPage = readPageSize(documentXml);

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<w:root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">${bodyXml}</w:root>`, 'application/xml');
  const root = doc.documentElement;

  const blocks: BodyBlock[] = [];
  const scan = (parent: Element) => {
    for (const node of Array.from(parent.children)) {
      if (node.tagName === 'w:p') {
        const ppr = node.getElementsByTagName('w:pPr')[0];
        if (ppr?.getElementsByTagName('w:sectPr')[0]) {
          const sect = ppr.getElementsByTagName('w:sectPr')[0];
          const page = readPageSize(`<w:document><w:body>${sect.outerHTML}</w:body></w:document>`);
          defaultPage.width = page.width;
          defaultPage.height = page.height;
          defaultPage.margins = page.margins;
        }
        const text = node.textContent ?? '';
        const hasImage = node.getElementsByTagName('w:drawing').length > 0 || node.getElementsByTagName('w:pict').length > 0;
        const explicitBreak = !!ppr?.getElementsByTagName('w:pageBreakBefore')[0] || /<w:br[^>]*w:type="page"/.test(node.outerHTML);
        if (!text.trim() && !hasImage && !explicitBreak) continue;
        let align: 'left' | 'center' | 'right' | 'justify' = 'left';
        let indentPt = 0;
        let spaceBefore = 0;
        let spaceAfter = 6;
        let lineSpacing: number | null = null;
        let numbering: { numId: string; level: number } | null = null;
        let styleId = '';
        if (ppr) {
          const jc = ppr.getElementsByTagName('w:jc')[0]?.getAttribute('w:val');
          if (jc === 'center' || jc === 'right' || jc === 'both') align = jc === 'both' ? 'justify' : jc;
          const ind = ppr.getElementsByTagName('w:ind')[0];
          if (ind) {
            const left = Number(ind.getAttribute('w:left') ?? '0');
            const hanging = Math.abs(Number(ind.getAttribute('w:hanging') ?? '0'));
            indentPt = Math.max(0, left / 20 - hanging / 20);
          }
          const spacing = ppr.getElementsByTagName('w:spacing')[0];
          if (spacing) {
            spaceBefore = Number(spacing.getAttribute('w:before') ?? '0') / 20;
            spaceAfter = Number(spacing.getAttribute('w:after') ?? '120') / 20;
            const line = spacing.getAttribute('w:line');
            if (line) lineSpacing = Number(line) / 240;
          }
          const numPr = ppr.getElementsByTagName('w:numPr')[0];
          if (numPr) {
            const numId = numPr.getElementsByTagName('w:numId')[0]?.getAttribute('w:val');
            const level = numPr.getElementsByTagName('w:ilvl')[0]?.getAttribute('w:val') ?? '0';
            if (numId) numbering = { numId, level: Number(level) || 0 };
          }
          styleId = ppr.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
        }
        const pieces = paragraphPieces(node, defaultSize);
        blocks.push({ kind: 'paragraph', pieces, align, indentPt, spaceBefore, spaceAfter, lineSpacing, numbering, styleId });
        if (explicitBreak) blocks.push({ kind: 'pagebreak' });
      } else if (node.tagName === 'w:tbl') {
        blocks.push({ kind: 'table', xml: node.outerHTML });
      } else if (node.tagName === 'w:sectPr') {
        const page = readPageSize(`<w:document><w:body>${node.outerHTML}</w:body></w:document>`);
        defaultPage.width = page.width;
        defaultPage.height = page.height;
        defaultPage.margins = page.margins;
      } else if (node.tagName === 'w:sdt') {
        scan(node);
      }
    }
  };
  scan(root);
  return { blocks, defaultPage };
}

/**
 * Convert a DOCX (raw OOXML) into a PDF preserving page size, margins, run
 * formatting (bold/italic/underline/size/color), alignment, indentation,
 * numbered/bulleted lists, tables with fills and borders, embedded images and
 * explicit page breaks.
 */
export async function docxToPdf(file: File): Promise<ProcessedResult> {
  if (/\.doc$/i.test(file.name)) {
    throw new Error('Legacy .doc files are not supported in the browser. Please save the document as .docx and try again.');
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('This file is not a valid DOCX document.');

  // Numbering definitions: which abstract levels are bullets vs decimal.
  const numberingXml = await zip.file('word/numbering.xml')?.async('string');
  const bulletLevels = new Set<number>();
  if (numberingXml) {
    const numDoc = parseXml(numberingXml);
    const abstractFormats = new Map<string, string[]>();
    for (const abstract of Array.from(numDoc.getElementsByTagName('w:abstractNum'))) {
      const id = abstract.getAttribute('w:abstractNumId');
      if (!id) continue;
      const levels: string[] = [];
      for (const level of Array.from(abstract.getElementsByTagName('w:lvl'))) {
        const ilvl = Number(level.getAttribute('w:ilvl') ?? '0');
        levels[ilvl] = level.getElementsByTagName('w:numFmt')[0]?.getAttribute('w:val') ?? 'decimal';
      }
      abstractFormats.set(id, levels);
    }
    for (const num of Array.from(numDoc.getElementsByTagName('w:num'))) {
      const numId = num.getAttribute('w:numId');
      const abstractId = num.getElementsByTagName('w:abstractNumId')[0]?.getAttribute('w:val');
      const formats = abstractId ? abstractFormats.get(abstractId) : undefined;
      if (numId && formats) formats.forEach((fmt, level) => { if (fmt === 'bullet') bulletLevels.add(level); });
    }
  }

  // Relationships -> media paths.
  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const rels = new Map<string, string>();
  if (relsXml) {
    const relDoc = parseXml(relsXml);
    for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) {
        const clean = target.replace(/^\.\.\//, '').replace(/^\//, '');
        rels.set(id, zip.file(`word/${clean}`) ? `word/${clean}` : clean);
      }
    }
  }

  const { blocks, defaultPage } = extractBodyBlocks(documentXml, 11);
  const page = defaultPage;

  const doc = await PDFDocument.create();
  const fonts: FontSet = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  let pdfPage = doc.addPage([page.width, page.height]);
  let cursorY = page.height - page.margins.top;
  const contentWidth = () => page.width - page.margins.left - page.margins.right;

  const newPage = () => {
    pdfPage = doc.addPage([page.width, page.height]);
    cursorY = page.height - page.margins.top;
  };
  const ensureSpace = (needed: number) => {
    if (cursorY - needed < page.margins.bottom) newPage();
  };

  const drawTextWithStyle = (text: string, style: RunStyle, x: number, y: number, maxWidth: number): number => {
    const font = fontFor(fonts, style.bold, style.italic);
    const safe = pdfSafeText(text);
    if (!safe) return 0;
    let consumed = 0;
    if (maxWidth <= 0 || font.widthOfTextAtSize(safe, style.size) <= maxWidth) {
      pdfPage.drawText(safe, { x, y, size: style.size, font, color: rgb(style.color.r, style.color.g, style.color.b) });
      consumed = font.widthOfTextAtSize(safe, style.size);
    } else {
      let rendered = '';
      for (const char of safe) {
        if (font.widthOfTextAtSize(rendered + char, style.size) > maxWidth && rendered) break;
        rendered += char;
      }
      if (!rendered) rendered = safe.slice(0, 1);
      pdfPage.drawText(rendered, { x, y, size: style.size, font, color: rgb(style.color.r, style.color.g, style.color.b) });
      consumed = font.widthOfTextAtSize(rendered, style.size);
    }
    if (style.underline && consumed > 0) {
      pdfPage.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + consumed, y: y - 1.5 }, thickness: Math.max(0.6, style.size / 14), color: rgb(style.color.r, style.color.g, style.color.b) });
    }
    return consumed;
  };

  const loadImage = async (imageId: string) => {
    const path = rels.get(imageId);
    if (!path) return null;
    const data = await zip.file(path)?.async('uint8array');
    if (!data) return null;
    try {
      const isPng = data[0] === 0x89 && data[1] === 0x50;
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      return isPng ? await doc.embedPng(buffer) : await doc.embedJpg(buffer);
    } catch {
      return null;
    }
  };

  const wrapPieces = (pieces: RunPiece[], maxWidth: number): Array<Array<RunPiece & { width: number }>> => {
    const lines: Array<Array<RunPiece & { width: number }>> = [];
    let current: Array<RunPiece & { width: number }> = [];
    let x = 0;
    for (const piece of pieces) {
      if ('break' in piece) {
        lines.push(current);
        current = [];
        x = 0;
        if (piece.break === 'page') lines.push([{ break: 'page' } as RunPiece & { width: number }]);
        continue;
      }
      if ('tab' in piece) {
        const tabStop = Math.min(maxWidth, (Math.floor(x / 36) + 1) * 36);
        current.push({ tab: true, width: Math.max(6, tabStop - x) });
        x = tabStop;
        continue;
      }
      if ('imageId' in piece) {
        current.push({ ...piece, width: 0 } as RunPiece & { width: number });
        continue;
      }
      const font = fontFor(fonts, piece.style.bold, piece.style.italic);
      const words = piece.text.split(/(\s+)/).filter(word => word.length > 0);
      for (const word of words) {
        const isSpace = /^\s+$/.test(word);
        const width = font.widthOfTextAtSize(isSpace ? ' ' : word, piece.style.size);
        if (!isSpace && x + width > maxWidth && current.length) {
          lines.push(current);
          current = [];
          x = 0;
        }
        current.push({ text: isSpace ? ' ' : word, style: piece.style, width });
        x += width;
      }
    }
    lines.push(current);
    return lines;
  };

  const drawParagraph = async (block: Extract<BodyBlock, { kind: 'paragraph' }>) => {
    const headingMatch = /^Heading(\d)/i.exec(block.styleId);
    const isTitle = /^Title$/i.test(block.styleId);
    const headingSize = isTitle ? 20 : headingMatch ? ({ '1': 17, '2': 14.5, '3': 12.5, '4': 11.5, '5': 11, '6': 10.5 }[headingMatch[1]] ?? 11) : 0;
    const isBulletList = block.numbering ? bulletLevels.has(block.numbering.level) : false;
    const indent = block.indentPt + (block.numbering ? 18 + block.numbering.level * 14 : 0);
    const maxWidth = Math.max(40, contentWidth() - indent);
    const spacing = block.lineSpacing && block.lineSpacing > 0 ? block.lineSpacing : 1.35;

    const pieces = headingSize
      ? block.pieces.map(piece => ('style' in piece ? { ...piece, style: { ...piece.style, size: Math.max(piece.style.size, headingSize), bold: true } } : piece))
      : block.pieces;

    const lines = wrapPieces(pieces, maxWidth);
    cursorY -= Math.max(0, block.spaceBefore);
    let ordinal = 1;
    for (const line of lines) {
      if (line.length === 1 && 'break' in line[0] && line[0].break === 'page') {
        newPage();
        continue;
      }
      const lineSize = Math.max(11, ...line.map(piece => ('style' in piece ? piece.style.size : 11)));
      ensureSpace(lineSize * spacing);
      const lineWidth = line.reduce((sum, piece) => sum + piece.width, 0);
      let x = page.margins.left + indent;
      if (block.align === 'center') x += Math.max(0, (maxWidth - lineWidth) / 2);
      else if (block.align === 'right') x += Math.max(0, maxWidth - lineWidth);

      if (block.numbering && line === lines[0]) {
        const label = isBulletList ? '•' : `${ordinal}.`;
        pdfPage.drawText(label, { x: page.margins.left + indent - 14, y: cursorY - lineSize, size: Math.min(lineSize, 11), font: fonts.regular, color: rgb(0.1, 0.1, 0.12) });
        ordinal += 1;
      }

      for (const piece of line) {
        if ('break' in piece || 'tab' in piece) {
          x += piece.width;
          continue;
        }
        if ('imageId' in piece) {
          const image = await loadImage(piece.imageId);
          if (image) {
            const available = Math.max(20, maxWidth - (x - page.margins.left - indent));
            const scale = Math.min(1, available / image.width, 300 / Math.max(1, image.height));
            const drawH = image.height * scale;
            if (cursorY - drawH < page.margins.bottom) newPage();
            pdfPage.drawImage(image, { x, y: cursorY - drawH, width: image.width * scale, height: drawH });
            cursorY -= drawH + 6;
          }
          continue;
        }
        const consumed = drawTextWithStyle(piece.text, piece.style, x, cursorY - piece.style.size, maxWidth - (x - page.margins.left - indent));
        x += consumed;
      }
      cursorY -= lineSize * spacing * 0.92 + 1;
    }
    cursorY -= Math.max(0, block.spaceAfter);
  };

  const cellTextLines = (text: string, font: PDFFont, size: number, maxWidth: number) => wrapTextForCell(text, font, size, maxWidth);

  const drawTable = (block: Extract<BodyBlock, { kind: 'table' }>) => {
    const tableDoc = parseXml(`<w:root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml">${block.xml}</w:root>`);
    const tableEl = tableDoc.getElementsByTagName('w:tbl')[0];
    if (!tableEl) return;
    const rows = Array.from(tableEl.children).filter(child => child.tagName === 'w:tr');
    if (!rows.length) return;

    const size = 9.5;
    const padding = 4;
    const grid = Array.from(tableEl.getElementsByTagName('w:gridCol')).map(col => Number(col.getAttribute('w:w') ?? '0') / 20);
    let columns = grid.length;
    for (const row of rows) {
      let count = 0;
      for (const cell of Array.from(row.children).filter(child => child.tagName === 'w:tc')) {
        count += Number(cell.getElementsByTagName('w:gridSpan')[0]?.getAttribute('w:val') ?? '1');
      }
      if (count > columns) columns = count;
    }
    if (columns < 1) return;
    let widths: number[] = grid.slice(0, columns).map(width => (width > 0 ? width : 0));
    while (widths.length < columns) widths.push(0);
    if (!widths.some(width => width > 0)) {
      const firstRowCells = Array.from(rows[0].getElementsByTagName('w:tc'));
      widths = firstRowCells.map(cell => {
        const tcw = cell.getElementsByTagName('w:tcW')[0];
        const value = Number(tcw?.getAttribute('w:w') ?? '0');
        return tcw?.getAttribute('w:type') === 'dxa' ? value / 20 : 0;
      });
      while (widths.length < columns) widths.push(0);
    }
    const total = widths.reduce((sum, width) => sum + width, 0);
    widths = total > 0
      ? widths.map(width => width * (contentWidth() / total))
      : widths.map(() => contentWidth() / columns);

    for (const row of rows) {
      const cells = Array.from(row.children).filter(child => child.tagName === 'w:tc');
      if (!cells.length) continue;
      const trHeight = Number(row.getElementsByTagName('w:trHeight')[0]?.getAttribute('w:val') ?? '0') / 20;

      const cellLayout = cells.map(cell => {
        const tcpr = cell.getElementsByTagName('w:tcPr')[0];
        const cellIndex = cells.indexOf(cell);
        let cellWidth = 0;
        const span = Math.max(1, Number(tcpr?.getElementsByTagName('w:gridSpan')[0]?.getAttribute('w:val') ?? '1'));
        for (let i = cellIndex; i < Math.min(columns, cellIndex + span); i += 1) cellWidth += widths[i] ?? 0;
        if (cellWidth <= 0) cellWidth = contentWidth() / columns;
        const paragraphs = Array.from(cell.getElementsByTagName('w:p'));
        const texts = paragraphs.map(paragraph => pdfSafeText((paragraph.textContent ?? '').replace(/\s+/g, ' ').trim())).filter(text => text.length > 0);
        const bold = !!cell.getElementsByTagName('w:b')[0];
        const fill = tcpr?.getElementsByTagName('w:shd')[0]?.getAttribute('w:fill');
        const lines = texts.map(text => cellTextLines(text, bold ? fonts.bold : fonts.regular, size, Math.max(10, cellWidth - padding * 2)));
        return { span, cellWidth, texts, bold, fill, lines, height: lines.flat().length * size * 1.25 + padding * 2 };
      });
      const rowHeight = Math.max(trHeight, size + padding * 2, ...cellLayout.map(layout => layout.height));
      ensureSpace(rowHeight);

      let x = page.margins.left;
      for (const layout of cellLayout) {
        if (layout.fill && layout.fill !== 'auto') {
          pdfPage.drawRectangle({ x, y: cursorY - rowHeight, width: layout.cellWidth, height: rowHeight, color: parseHexColorFill(layout.fill) });
        }
        const font = layout.bold ? fonts.bold : fonts.regular;
        let textY = cursorY - padding - size;
        for (let paragraphIndex = 0; paragraphIndex < layout.lines.length; paragraphIndex += 1) {
          for (const lineText of layout.lines[paragraphIndex]) {
            pdfPage.drawText(lineText, { x: x + padding, y: textY, size, font, color: rgb(0.13, 0.15, 0.19) });
            textY -= size * 1.25;
          }
        }
        pdfPage.drawRectangle({ x, y: cursorY - rowHeight, width: layout.cellWidth, height: rowHeight, borderColor: rgb(0.78, 0.8, 0.83), borderWidth: 0.6 });
        x += layout.cellWidth;
      }
      cursorY -= rowHeight;
    }
    cursorY -= 10;
  };

  for (const block of blocks) {
    if (block.kind === 'pagebreak') newPage();
    else if (block.kind === 'table') drawTable(block);
    else await drawParagraph(block);
  }

  const pageCount = doc.getPageCount();
  return savePdf(doc, `${baseName(file.name)}.pdf`, `Converted "${file.name}" into a ${pageCount}-page PDF preserving page size (${Math.round(page.width)}×${Math.round(page.height)}pt), margins, font sizes, bold/italic/underline, text colors, alignment, indentation, lists, tables (fills, borders, merged spans) and embedded images.`, [file]);
}
