/**
 * PDF → Word: server-geometry bridge.
 * Converts /api/parse-pdf geometry (positioned items + vector lines) into the
 * same analyzed-page shape the local pdf.js pipeline produces, so all layout,
 * table-detection and code-block heuristics behave identically.
 */
import type { PdfPageAnalysis, PdfLine, VectorLine } from './extract';

const MONO_HINT = /courier|mono|consol|menlo|dejavusansmono|liberationmono|nimbusmono/i;

export interface GeoItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

export interface GeoPage {
  num: number;
  width: number;
  height: number;
  items: GeoItem[];
  lines: VectorLine[];
}

function isCodeText(text: string): boolean {
  if (!/\S/.test(text)) return false;
  const codePunct = (text.match(/[{};()=<>[\]]|::|\/\/|System\.|public |private |import |class |void |String |int |return |if\s*\(|for\s*\(|while\s*\(/g) || []).length;
  return codePunct >= 2 || /^(public|private|import|class|package|System|return|else|for|if|while|try|catch)\b/.test(text.trimStart());
}

/** Same grouping rules as the local extract.ts groupLines(). */
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
    line.indentSpaces = 0;
  }
  return lines;
}

/** Build analyzed pages from server geometry (one PdfPageAnalysis per page). */
export function groupAnalyzedItems(geoPages: GeoPage[]): PdfPageAnalysis[] {
  return geoPages.map(page => {
    const items = (page.items ?? []).map(item => ({
      str: item.str,
      x: item.x,
      // PDF text space: pdf.js y grows upward already in legacy transform space.
      y: item.y,
      w: item.w,
      size: item.size,
      bold: /bold|black|heavy|semib/i.test(item.font ?? ''),
      italic: /italic|oblique/i.test(item.font ?? ''),
      mono: MONO_HINT.test(item.font ?? ''),
    }));
    const lines = groupLines(items);
    return {
      width: page.width,
      height: page.height,
      lines,
      vectorLines: page.lines ?? [],
      images: [],
      textCharCount: items.reduce((sum, i) => sum + i.str.length, 0),
      pageFrame: null,
    };
  });
}
