/**
 * Word → PDF: layout renderer.
 * Flows parsed DOCX blocks onto pdf-lib pages: wrapped, styled, selectable
 * text; drawn tables with merges/shading/borders; embedded images; headers,
 * footers with page fields, and page borders. Real pagination from content
 * flow plus explicit page breaks.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ParsedDocx, DocxParagraph, DocxRun, DocxTable, DocxSection } from './docxParser';
import { isTable } from './docxParser';

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

async function buildFontSets(pdf: PDFDocument): Promise<Record<DocxRun['font'], FontSet>> {
  const embed = async (name: StandardFonts) => (await pdf.embedFont(name)) as unknown as PDFFont;
  return {
    serif: {
      regular: await embed(StandardFonts.TimesRoman),
      bold: await embed(StandardFonts.TimesRomanBold),
      italic: await embed(StandardFonts.TimesRomanItalic),
      boldItalic: await embed(StandardFonts.TimesRomanBoldItalic),
    },
    sans: {
      regular: await embed(StandardFonts.Helvetica),
      bold: await embed(StandardFonts.HelveticaBold),
      italic: await embed(StandardFonts.HelveticaOblique),
      boldItalic: await embed(StandardFonts.HelveticaBoldOblique),
    },
    mono: {
      regular: await embed(StandardFonts.Courier),
      bold: await embed(StandardFonts.CourierBold),
      italic: await embed(StandardFonts.CourierOblique),
      boldItalic: await embed(StandardFonts.CourierBoldOblique),
    },
  };
}

function pickFont(set: FontSet, run: DocxRun): PDFFont {
  if (run.bold && run.italic) return set.boldItalic;
  if (run.bold) return set.bold;
  if (run.italic) return set.italic;
  return set.regular;
}

/** Strip characters the standard-14 fonts cannot encode (WinAnsi). */
function safeText(font: PDFFont, text: string): string {
  try {
    font.widthOfTextAtSize(text, 10);
    return text;
  } catch {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[^\x00-\x7F]/g, '?');
  }
}

const TW = 1 / 20; // twips → pt

interface Piece { text: string; width: number }

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): Piece[] {
  const out: Piece[] = [];
  // pdf-lib standard fonts cannot encode tabs/control chars; render as spaces.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f]/g, '');
  for (const segment of clean.split('\n')) {
    if (!segment) { out.push({ text: '', width: 0 }); continue; }
    let current = '';
    let currentW = 0;
    const words = segment.split(/(\s+)/);
    for (const word of words) {
      let w = 0;
      try { w = font.widthOfTextAtSize(word, size); } catch {
        const clean = word.replace(/[^\x00-\x7F]/g, '?'); // eslint-disable-line no-control-regex
        w = font.widthOfTextAtSize(clean, size);
      }
      if (current && currentW + w > maxWidth && word.trim()) {
        out.push({ text: current.replace(/\s+$/, ''), width: currentW });
        current = word.replace(/^\s+/, '');
        currentW = font.widthOfTextAtSize(current, size);
      } else {
        current += word;
        currentW += w;
      }
    }
    if (current) out.push({ text: current.replace(/\s+$/, ''), width: font.widthOfTextAtSize(current, size) });
  }
  return out;
}

export async function renderDocxToPdf(
  parsed: ParsedDocx,
  onProgress?: (label: string, pct: number) => void,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  onProgress?.('Reading Word document', 20);
  const pdf = await PDFDocument.create();
  pdf.setProducer('My PDF Desk');

  const fonts: Record<DocxRun['font'], FontSet> = await buildFontSets(pdf);
  const section: DocxSection = parsed.sections[parsed.sections.length - 1] ?? parsed.sections[0];
  const pageW = section.widthTwips * TW;
  const pageH = section.heightTwips * TW;
  const margin = {
    top: section.margins.top * TW,
    right: section.margins.right * TW,
    bottom: Math.max(section.margins.bottom * TW, 28),
    left: section.margins.left * TW,
  };
  const contentW = pageW - margin.left - margin.right;

  let page: PDFPage = pdf.addPage([pageW, pageH]);
  let cursorY = pageH - margin.top;

  const newPage = () => {
    page = pdf.addPage([pageW, pageH]);
    cursorY = pageH - margin.top;
  };
  const ensureSpace = (needed: number) => {
    if (cursorY - needed < margin.bottom) { newPage(); return true; }
    return false;
  };

  onProgress?.('Analyzing layout', 35);
  onProgress?.('Rendering text', 50);

  const drawTable = (table: DocxTable) => {
    const totalWidth = table.columnWidths.reduce((a, b) => a + b, 0) * TW;
    const scale = totalWidth > contentW && totalWidth > 0 ? contentW / totalWidth : 1;
    const colW = table.columnWidths.map(w => w * TW * scale);

    for (const row of table.rows) {
      // Cell layout: x offset from gridSpan accumulation, wrapped lines.
      let xCursor = margin.left;
      const layout = row.cells.map(cell => {
        const width = colW.slice(0, cell.gridSpan).reduce((a, b) => a + b, 0) || 60;
        // Join every paragraph in the cell (multi-paragraph cells are common);
        // wrapText splits on the newlines we insert.
        const text = cell.paragraphs.map(p => (p?.runs ?? []).map(r => r.text).join('')).join('\n');
        const para = cell.paragraphs.find(p => (p?.runs ?? []).some(r => r.text.trim())) ?? cell.paragraphs[0];
        const size = para?.runs[0]?.size ?? 10.5;
        const set = fonts[para?.runs[0]?.font ?? 'serif'];
        const font = pickFont(set, para?.runs[0] ?? { text: '', size, bold: false, italic: false, underline: false, superscript: false, subscript: false, font: 'serif' });
        const wrapped = wrapText(font, text, size, Math.max(20, width - 8));
        const info = { x: xCursor, width, wrapped, size, font, align: para?.align ?? 'left' as const };
        xCursor += width;
        return info;
      });
      const lineH = 13;
      const rowLines = Math.max(1, ...layout.map(l => Math.max(1, l.wrapped.length)));
      const rowH = rowLines * lineH + 6;

      if (cursorY - rowH < margin.bottom) {
        newPage();
      }
      const y0 = cursorY;

      layout.forEach((cell, ci) => {
        const srcCell = row.cells[ci];
        const isContinue = srcCell.vMerge === 'continue';
        if (srcCell.fill && /^[0-9a-fA-F]{6}$/.test(srcCell.fill) && !isContinue) {
          page.drawRectangle({
            x: cell.x, y: y0 - rowH, width: cell.width, height: rowH,
            color: rgb(
              parseInt(srcCell.fill.slice(0, 2), 16) / 255,
              parseInt(srcCell.fill.slice(2, 4), 16) / 255,
              parseInt(srcCell.fill.slice(4, 6), 16) / 255,
            ),
          });
        }
        if (!isContinue) {
          cell.wrapped.slice(0, rowLines).forEach((piece, li) => {
            if (!piece.text) return;
            let x = cell.x + 4;
            if (cell.align === 'center') x = cell.x + (cell.width - piece.width) / 2;
            else if (cell.align === 'right') x = cell.x + cell.width - piece.width - 4;
            page.drawText(safeText(cell.font, piece.text), {
              x, y: y0 - lineH * (li + 1) + 3,
              size: cell.size, font: cell.font, color: rgb(0.1, 0.1, 0.1),
            });
          });
        }
        if (table.borders) {
          page.drawRectangle({
            x: cell.x, y: y0 - rowH, width: cell.width, height: rowH,
            borderColor: rgb(0, 0, 0), borderWidth: 0.75,
          });
        }
      });
      cursorY = y0 - rowH;
    }
  };

  const embeddedCache = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();

  for (const block of parsed.blocks) {
    if (isTable(block)) { drawTable(block); continue; }
    const para = block as DocxParagraph;

    if (para.kind === 'pagebreak') { newPage(); continue; }

    for (const image of para.images) {
      const media = parsed.images[image.relId];
      if (!media) continue;
      let embedded = embeddedCache.get(image.relId);
      if (!embedded) {
        try {
          const bytes = new Uint8Array(media.data);
          embedded = /jpe?g/i.test(media.ext) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
          embeddedCache.set(image.relId, embedded);
        } catch { continue; }
      }
      const w = Math.min(image.widthPt, contentW);
      const h = embedded.height * (w / embedded.width);
      ensureSpace(h + 6);
      page.drawImage(embedded, { x: margin.left, y: cursorY - h, width: w, height: h });
      cursorY -= h + 6;
    }

    const runs = para.runs.filter(r => r.text !== '');
    if (!runs.length) {
      cursorY -= Math.max(8, (para.runs[0]?.size ?? 11) * 0.9);
      // Empty paragraphs can still carry a section break.
      if (para.endsSection) newPage();
      continue;
    }

    const before = Math.min(para.spacingBeforePt, 20);
    if (before) { ensureSpace(before); cursorY -= before; }
    const after = Math.min(para.spacingAfterPt, 20);

    // Layout pass: wrap each run; count lines to know the total height.
    const lineList: Array<Array<{ text: string; width: number; run: DocxRun; font: PDFFont }>> = [[]];
    for (const run of runs) {
      const set = fonts[run.font];
      const font = pickFont(set, run);
      const pieces = wrapText(font, run.text, run.size, contentW - para.indentPt);
      for (const piece of pieces) {
        if (piece.text === '' && piece.width === 0) lineList.push([]);
        else lineList[lineList.length - 1].push({ ...piece, run, font });
      }
      // A run ending in an explicit newline starts a new visual line.
      if (run.text.endsWith('\n')) lineList.push([]);
    }

    const baseSize = Math.max(...runs.map(r => r.size));
    const lineH = para.linePt ?? baseSize * 1.28;

    for (const line of lineList) {
      if (!line.length) { cursorY -= lineH * 0.6; continue; }
      const totalW = line.reduce((a, p) => a + p.width, 0);
      ensureSpace(lineH);
      let x = margin.left + para.indentPt;
      if (para.align === 'center') x += Math.max(0, (contentW - para.indentPt - totalW) / 2);
      else if (para.align === 'right') x += Math.max(0, contentW - para.indentPt - totalW);
      for (const piece of line) {
        const run = piece.run;
        const size = run.size;
        const dy = run.superscript ? size * 0.33 : run.subscript ? -size * 0.17 : 0;
        const drawSize = run.superscript || run.subscript ? size * 0.72 : size;
        page.drawText(safeText(piece.font, piece.text), {
          x, y: cursorY - size + dy, size: drawSize, font: piece.font,
          color: run.color ? rgb(run.color.r, run.color.g, run.color.b) : rgb(0.1, 0.1, 0.1),
        });
        if (run.underline) {
          page.drawLine({
            start: { x, y: cursorY - size - 1.5 },
            end: { x: x + piece.width, y: cursorY - size - 1.5 },
            thickness: 0.6, color: rgb(0.1, 0.1, 0.1),
          });
        }
        x += piece.width;
      }
      cursorY -= lineH;
    }
    if (after) cursorY -= after;
    // A paragraph carrying a sectPr ends a section — draw it, then break.
    if (para.endsSection) newPage();
  }

  onProgress?.('Generating PDF', 85);
  // Stamp headers, footers, page borders on every page.
  const pages = pdf.getPages();
  const total = pages.length;
  pages.forEach((p, index) => {
    const pageNo = index + 1;
    if (parsed.footer && (parsed.footer.text || parsed.footer.hasPageField)) {
      const font = fonts.serif.regular;
      const size = 9;
      // Multi-line footer = multiple anchored boxes (e.g. left name, right ID):
      // draw each line separately, left-aligned first line, right-aligned last.
      const lines = parsed.footer.text ? parsed.footer.text.split('\n').map(s => s.trim()).filter(Boolean).filter((line, idx, arr) => arr.indexOf(line) === idx) : [];
      lines.forEach((line, idx) => {
        const w = font.widthOfTextAtSize(line, size);
        const isEdgePair = lines.length > 1;
        const x = isEdgePair
          ? (idx === 0 ? margin.left : pageW - margin.right - w)
          : parsed.footer!.align === 'right' ? pageW - margin.right - w
          : parsed.footer!.align === 'left' ? margin.left
          : (pageW - w) / 2;
        p.drawText(line, { x, y: 14, size, font, color: rgb(0.35, 0.35, 0.35) });
      });
      if (parsed.footer.hasPageField) {
        const text = `Page ${pageNo} of ${total}`;
        const w = font.widthOfTextAtSize(text, size);
        p.drawText(text, { x: (pageW - w) / 2, y: 14, size, font, color: rgb(0.35, 0.35, 0.35) });
      }
    }
    if (parsed.header && parsed.header.text) {
      const font = fonts.serif.regular;
      const size = 9;
      const text = parsed.header.text.replace(/\n+/g, ' ');
      const w = font.widthOfTextAtSize(text, size);
      const x = parsed.header.align === 'right' ? pageW - margin.right - w
        : parsed.header.align === 'left' ? margin.left
        : (pageW - w) / 2;
      p.drawText(text, { x, y: pageH - 26, size, font, color: rgb(0.35, 0.35, 0.35) });
    }
    if (section.pageBorders) {
      const off = 24;
      p.drawRectangle({
        x: off, y: off, width: pageW - off * 2, height: pageH - off * 2,
        borderColor: rgb(0, 0, 0), borderWidth: 0.75,
      });
    }
  });

  onProgress?.('Validating PDF', 95);
  const bytes = await pdf.save();
  if (!bytes.length || bytes[0] !== 0x25) throw new Error('We could not generate a valid PDF from this document.');
  onProgress?.('Complete', 100);
  return { bytes, pageCount: pages.length };
}
