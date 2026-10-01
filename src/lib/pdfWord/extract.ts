/**
 * PDF → Word: page analysis layer.
 * Extracts positioned text spans, groups them into lines/blocks, reads vector
 * border lines for table detection, extracts embedded images and classifies
 * content (code / heading / body) — all from the raw PDF structures.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfSpan {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export interface PdfLine {
  y: number;
  size: number;
  spans: PdfSpan[];
  text: string;
  left: number;
  right: number;
  bold: boolean;
  mono: boolean;
  indentSpaces: number;
}

export interface VectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PdfPageAnalysis {
  width: number;
  height: number;
  lines: PdfLine[];
  vectorLines: VectorLine[];
  images: Array<{ dataUrl: string; w: number; h: number; x: number; y: number; pageIndex: number }>;
  textCharCount: number;
  /** Full-page decorative frame rect (x, y, w, h in PDF pts) when detected. */
  pageFrame: { x: number; y: number; w: number; h: number } | null;
}

const MONO_HINT = /courier|mono|consol|menlo|dejavusansmono|liberationmono|nimbusmono/i;

function fontIsMono(fontName: string | undefined): boolean {
  return !!fontName && MONO_HINT.test(fontName);
}

function isCodeText(text: string): boolean {
  if (!/\S/.test(text)) return false;
  const codePunct = (text.match(/[{};()=<>[\]]|::|\/\/|System\.|public |private |import |class |void |String |int |return |if\s*\(|for\s*\(|while\s*\(/g) || []).length;
  return codePunct >= 2 || /^(public|private|import|class|package|System|return|else|for|if|while|try|catch)\b/.test(text.trimStart());
}

/**
 * Detects a decorative full-page border frame: a long H/V line pair forming a
 * rectangle that spans most of the page, away from the text margins.
 */
function detectPageFrame(width: number, height: number, lines: VectorLine[]): PdfPageAnalysis['pageFrame'] {
  const longH = lines.filter(l => Math.abs(l.y1 - l.y2) < 2 && Math.abs(l.x2 - l.x1) > width * 0.6);
  const longV = lines.filter(l => Math.abs(l.x1 - l.x2) < 2 && Math.abs(l.y2 - l.y1) > height * 0.6);
  if (longH.length < 2 || longV.length < 2) return null;
  // Two topmost/bottommost H and two leftmost/rightmost V lines forming one frame.
  const ys = [...new Set(longH.map(l => Math.round(l.y1)))].sort((a, b) => a - b);
  const xs = [...new Set(longV.map(l => Math.round(l.x1)))].sort((a, b) => a - b);
  if (ys.length < 2 || xs.length < 2) return null;
  const top = ys[0], bottom = ys[ys.length - 1];
  const left = xs[0], right = xs[xs.length - 1];
  const frameW = right - left, frameH = bottom - top;
  if (frameW < width * 0.6 || frameH < height * 0.6) return null;
  if (frameW > width * 0.995 && frameH > height * 0.995) return null; // full-bleed crop box, not a frame
  return { x: left, y: top, w: frameW, h: frameH };
}

/** Group raw pdf.js text items into visual lines (y-tolerant), merging adjacent spans. */
function groupLines(items: Array<{ str: string; x: number; y: number; w: number; size: number; bold: boolean; italic: boolean; mono: boolean }>): PdfLine[] {
  const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines: PdfLine[] = [];
  for (const item of sorted) {
    const line = lines.find(l => Math.abs(l.y - item.y) <= Math.max(2.4, 0.38 * Math.min(l.size, item.size)));
    if (line) {
      line.spans.push(item);
      line.y = (line.y * (line.spans.length - 1) + item.y) / line.spans.length;
    } else {
      lines.push({ y: item.y, size: item.size, spans: [item], text: '', left: item.x, right: item.x + item.w, bold: false, mono: false, indentSpaces: 0 });
    }
  }
  for (const line of lines) {
    line.spans.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = line.spans[0].x;
    for (const span of line.spans) {
      const gap = span.x - prevEnd;
      if (text && gap > 0.28 * span.size) text += gap > 1.9 * span.size ? '\t' : ' ';
      text += span.str;
      prevEnd = span.x + span.w;
    }
    line.text = text;
    line.left = line.spans[0].x;
    line.right = Math.max(...line.spans.map(s => s.x + s.w));
    const weights = line.spans.map(s => Math.max(1, s.str.length));
    line.size = line.spans.reduce((sum, s, i) => sum + s.size * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
    line.bold = line.spans.filter(s => s.bold).reduce((a, s) => a + s.str.length, 0) > line.text.replace(/\t/g, '').length * 0.6;
    line.mono = line.spans.every(s => s.mono) || isCodeText(line.text);
    // Leading indentation is derived later from line.left relative to the page margin.
    line.indentSpaces = 0;
  }
  return lines;
}

/** Read vector path rectangles from the operator list as H/V border lines. */
async function vectorBorderLines(page: pdfjsLib.PDFPageProxy, pageW = 1000, pageH = 1000): Promise<VectorLine[]> {
  const lines: VectorLine[] = [];
  const emitBbox = (minX: number, minY: number, maxX: number, maxY: number) => {
    if (!Number.isFinite(minX) || maxX - minX >= 3000 || maxY - minY >= 3000) return;
    const w = maxX - minX;
    const h = maxY - minY;
    if (h < 1.2) lines.push({ x1: minX, y1: minY, x2: maxX, y2: minY });
    else if (w < 1.2) lines.push({ x1: minX, y1: minY, x2: minX, y2: maxY });
    else if (w < pageW * 0.92 && h < pageH * 0.92) {
      // Enclosed rectangle → table cell / outer border / box: emit all four edges.
      lines.push({ x1: minX, y1: minY, x2: maxX, y2: minY });
      lines.push({ x1: maxX, y1: minY, x2: maxX, y2: maxY });
      lines.push({ x1: minX, y1: maxY, x2: maxX, y2: maxY });
      lines.push({ x1: minX, y1: minY, x2: minX, y2: maxY });
    }
    // Near-full-page rectangles (page backgrounds / borders) are ignored — they
    // are not table geometry (pageFrame detection handles those separately).
  };
  try {
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== pdfjsLib.OPS.constructPath) continue;
      const args = ops.argsArray[i] as unknown[];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const track = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      };

      if (args.length >= 3 && Array.isArray(args[1])) {
        // pdf.js ≥5 flat encoding: (minMaxId, flatPath, bbox) where flatPath is
        // an INTERLEAVED array [op, x, y, op, x, y, …, 4] with op codes
        // 0=moveTo, 1=lineTo, 2=curveTo, 3=curveTo2, 4=closePath, and bbox =
        // Float32Array [minX, minY, maxX, maxY].
        const flat = args[1] as number[];
        if (args[2] instanceof Float32Array && args[2].length >= 4) {
          emitBbox(args[2][0], args[2][1], args[2][2], args[2][3]);
          continue;
        }
        let k = 0;
        let ok = true;
        while (k < flat.length) {
          const op = flat[k++];
          if (op === 0 || op === 1) { track(flat[k], flat[k + 1]); k += 2; }
          else if (op === 2) { for (let c = 0; c < 6; c += 2) track(flat[k + c], flat[k + c + 1]); k += 6; }
          else if (op === 3) { for (let c = 0; c < 4; c += 2) track(flat[k + c], flat[k + c + 1]); k += 4; }
          else if (op === 4) {
            emitBbox(minX, minY, maxX, maxY);
            minX = minY = Infinity; maxX = maxY = -Infinity;
          } else { ok = false; break; }
        }
        if (ok) emitBbox(minX, minY, maxX, maxY);
        continue;
      }

      if (args.length >= 2 && Array.isArray(args[0]) && args[1] instanceof Float32Array) {
        // Legacy encoding: (pathOps, coords) with pdf.js OPS codes.
        const pathOps = args[0] as number[];
        const coords = args[1] as Float32Array;
        let k = 0;
        for (const op of pathOps) {
          if (op === pdfjsLib.OPS.moveTo || op === pdfjsLib.OPS.lineTo) {
            track(coords[k], coords[k + 1]); k += 2;
          } else if (op === pdfjsLib.OPS.curveTo || op === pdfjsLib.OPS.curveTo2 || op === pdfjsLib.OPS.curveTo3) {
            const n = op === pdfjsLib.OPS.curveTo2 ? 4 : 6;
            for (let c = 0; c < n; c += 2) track(coords[k + c], coords[k + c + 1]);
            k += n;
          } else if (op === pdfjsLib.OPS.rectangle) {
            track(coords[k], coords[k + 1]);
            track(coords[k] + coords[k + 2], coords[k + 1] + coords[k + 3]);
            k += 4;
            emitBbox(minX, minY, maxX, maxY);
            minX = minY = Infinity; maxX = maxY = -Infinity;
          } else if (op === pdfjsLib.OPS.closePath || op === pdfjsLib.OPS.endPath) {
            emitBbox(minX, minY, maxX, maxY);
            minX = minY = Infinity; maxX = maxY = -Infinity;
          } else break;
        }
        emitBbox(minX, minY, maxX, maxY);
      }
    }
  } catch {
    // Some PDFs deny operator introspection — tables simply stay text.
  }
  return lines;
}

/** Extract embedded raster images (pdf.js 6.x hands over ImageBitmap objects). */
async function pageImages(page: pdfjsLib.PDFPageProxy, pageIndex: number): Promise<PdfPageAnalysis['images']> {
  const out: PdfPageAnalysis['images'] = [];
  try {
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
      const raw = ops.argsArray[i]?.[0] as
        | { bitmap?: ImageBitmap; width?: number; height?: number }
        | string
        | undefined;
      if (!raw || typeof raw === 'string' || !raw.bitmap) continue;
      const bw = raw.width ?? raw.bitmap.width;
      const bh = raw.height ?? raw.bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = bw;
      canvas.height = bh;
      canvas.getContext('2d')!.drawImage(raw.bitmap, 0, 0);
      out.push({ dataUrl: canvas.toDataURL('image/png'), w: bw, h: bh, x: 0, y: 0, pageIndex });
      canvas.width = canvas.height = 0;
    }
  } catch {
    // Ignore unreadable images; text conversion still proceeds.
  }
  return out;
}

export async function analyzePage(page: pdfjsLib.PDFPageProxy, pageIndex: number): Promise<PdfPageAnalysis> {
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  // Prefer pdf.js's glyph-level style detection when available
  // (getTextStyle returns { fontFamily, ascent, descent, vertical }).
  const getStyle = (page as unknown as {
    getTextStyle?: (fontName: string) => { fontFamily?: string } | undefined;
  }).getTextStyle?.bind(page);
  const items: Array<{ str: string; x: number; y: number; w: number; size: number; bold: boolean; italic: boolean; mono: boolean; indent?: number }> = [];
  for (const item of tc.items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue;
    const t = item.transform as number[];
    const fontName = (item as { fontName?: string }).fontName ?? '';
    const style = getStyle ? getStyle(fontName) : (tc as { styles?: Record<string, { fontFamily?: string }> }).styles?.[fontName];
    const family = style?.fontFamily ?? '';
    items.push({
      str: item.str,
      x: t[4] ?? 0,
      y: t[5] ?? 0,
      w: (item as { width?: number }).width ?? 0,
      size: Math.abs(t[3] ?? t[0] ?? 10),
      bold: /bold|black|heavy|semib/i.test(family),
      italic: /italic|oblique/i.test(family),
      mono: fontIsMono(family),
      indent: t[4],
    });
  }
  const [vectorLines, images] = await Promise.all([vectorBorderLines(page, viewport.width, viewport.height), pageImages(page, pageIndex)]);
  const lines = groupLines(items);
  return {
    width: viewport.width,
    height: viewport.height,
    lines,
    vectorLines,
    images,
    textCharCount: items.reduce((sum, i) => sum + i.str.length, 0),
    pageFrame: detectPageFrame(viewport.width, viewport.height, vectorLines),
  };
}

export async function openPdf(file: File): Promise<pdfjsLib.PDFDocumentProxy & { destroy?: () => Promise<void> }> {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
}
