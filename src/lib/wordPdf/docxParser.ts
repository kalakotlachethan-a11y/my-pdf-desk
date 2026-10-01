/**
 * Word → PDF: DOCX structural parser.
 * Reads the OOXML package directly: paragraphs with full run formatting,
 * tables (grid widths, borders, gridSpan/vMerge merges, shading), embedded
 * images via relationships, headers/footers with PAGE/NUMPAGES fields, and
 * per-section page geometry (size, orientation, margins, page borders).
 */
import JSZip from 'jszip';

export type ParaAlign = 'left' | 'center' | 'right' | 'justify';
export type FontKind = 'serif' | 'sans' | 'mono';

export interface DocxRun {
  text: string;
  size: number; // pt
  bold: boolean;
  italic: boolean;
  underline: boolean;
  superscript: boolean;
  subscript: boolean;
  font: FontKind;
  fontName?: string;
  color?: { r: number; g: number; b: number };
}

export interface DocxImage {
  relId: string;
  widthPt: number;
  heightPt: number;
}

export interface DocxParagraph {
  kind: 'para' | 'pagebreak';
  runs: DocxRun[];
  align: ParaAlign;
  indentPt: number;
  spacingBeforePt: number;
  spacingAfterPt: number;
  linePt: number | null;
  images: DocxImage[];
  inTable?: boolean;
  endsSection?: boolean;
}

export interface DocxTableCell {
  paragraphs: DocxParagraph[];
  gridSpan: number;
  vMerge: 'restart' | 'continue' | null;
  fill?: string;
  widthTwips: number;
}

export interface DocxTableRow {
  cells: DocxTableCell[];
}

export interface DocxTable {
  columnWidths: number[]; // twips
  rows: DocxTableRow[];
  borders: boolean;
}

export type DocxBlock = DocxParagraph | DocxTable;

export function isTable(block: DocxBlock): block is DocxTable {
  return (block as DocxTable).rows !== undefined;
}

export interface DocxSection {
  widthTwips: number;
  heightTwips: number;
  landscape: boolean;
  margins: { top: number; right: number; bottom: number; left: number };
  pageBorders: boolean;
}

export interface DocxHeaderFooter {
  text: string;
  hasPageField: boolean;
  align: ParaAlign;
}

export interface ParsedDocx {
  sections: DocxSection[];
  blocks: DocxBlock[];
  header: DocxHeaderFooter | null;
  footer: DocxHeaderFooter | null;
  images: Record<string, { data: Uint8Array; ext: string }>;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function esc(value: string): string {
  return value.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c));
}

function twips(el: Element, attr: string, fallback: number): number {
  const v = el.getAttribute(`w:${attr}`);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function colorOf(el: Element | null): { r: number; g: number; b: number } | undefined {
  if (!el) return undefined;
  const hex = el.getAttribute('w:val');
  if (!hex || hex === 'auto') return undefined;
  const m = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return undefined;
  return {
    r: parseInt(m.slice(0, 2), 16) / 255,
    g: parseInt(m.slice(2, 4), 16) / 255,
    b: parseInt(m.slice(4, 6), 16) / 255,
  };
}

function fontKind(name: string | undefined): FontKind {
  if (!name) return 'serif';
  if (/courier|mono|consol/i.test(name)) return 'mono';
  if (/calibri|arial|helvetica|segoe|verdana|tahoma|sans/i.test(name)) return 'sans';
  return 'serif';
}

function runFromEl(run: Element, defaults: { size: number }): DocxRun {
  const rPr = run.getElementsByTagNameNS(W, 'rPr')[0] ?? null;
  const t = run.getElementsByTagNameNS(W, 't');
  let text = '';
  for (const node of t) text += node.textContent ?? '';
  // Tabs and breaks inside runs
  for (const br of run.getElementsByTagNameNS(W, 'br')) {
    const type = br.getAttribute('w:type');
    if (type === 'page') text += '\u000C';
  }
  const has = (tag: string) => !!(rPr && rPr.getElementsByTagNameNS(W, tag)[0]);
  const boldEl = rPr?.getElementsByTagNameNS(W, 'b')[0];
  const bold = !!boldEl && boldEl.getAttribute('w:val') !== '0' && boldEl.getAttribute('w:val') !== 'false';
  const szEl = rPr?.getElementsByTagNameNS(W, 'sz')[0];
  const size = szEl ? parseInt(szEl.getAttribute('w:val') ?? '', 10) / 2 : defaults.size;
  const fontsEl = rPr?.getElementsByTagNameNS(W, 'rFonts')[0];
  const fontName = fontsEl?.getAttribute('w:ascii') ?? undefined;
  return {
    text,
    size: size > 0 ? size : defaults.size,
    bold,
    italic: has('i'),
    underline: has('u'),
    superscript: has('vertAlign') && rPr!.getElementsByTagNameNS(W, 'vertAlign')[0].getAttribute('w:val') === 'superscript',
    subscript: has('vertAlign') && rPr!.getElementsByTagNameNS(W, 'vertAlign')[0].getAttribute('w:val') === 'subscript',
    font: fontKind(fontName),
    fontName,
    color: colorOf(rPr?.getElementsByTagNameNS(W, 'color')[0] ?? null),
  };
}

function alignOf(pPr: Element | null): ParaAlign {
  const jc = pPr?.getElementsByTagNameNS(W, 'jc')[0];
  const val = jc?.getAttribute('w:val') ?? 'left';
  if (val === 'center') return 'center';
  if (val === 'right') return 'right';
  if (val === 'both') return 'justify';
  return 'left';
}

function paraFromEl(para: Element, defaults: { size: number }): DocxParagraph {
  const pPr = para.getElementsByTagNameNS(W, 'pPr')[0] ?? null;
  const runs: DocxRun[] = [];
  const images: DocxImage[] = [];
  const breakBefore = !!(pPr?.getElementsByTagNameNS(W, 'pageBreakBefore')[0]);
  let hasPageBreak = breakBefore;
  for (const child of para.children) {
    if (child.localName === 'r') {
      const run = runFromEl(child, defaults);
      if (run.text.includes('\u000C')) hasPageBreak = true;
      runs.push(run);
      const drawing = child.getElementsByTagName('wp:extent')[0] ?? child.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
      if (drawing) {
        const cx = parseInt(drawing.getAttribute('cx') ?? '0', 10);
        const cy = parseInt(drawing.getAttribute('cy') ?? '0', 10);
        const blip = child.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
        const relId = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? blip?.getAttribute('r:embed') ?? '';
        if (relId && cx && cy) {
          images.push({ relId, widthPt: cx / 12700, heightPt: cy / 12700 });
        }
      }
    }
  }
  const spacing = pPr?.getElementsByTagNameNS(W, 'spacing')[0] ?? null;
  const ind = pPr?.getElementsByTagNameNS(W, 'ind')[0] ?? null;
  // A paragraph carrying its own sectPr ends a section (next-page break).
  const endsSection = !!(pPr && Array.from(pPr.children).some(c => c.localName === 'sectPr'));
  const lineRaw = spacing?.getAttribute('w:line');
  const lineRule = spacing?.getAttribute('w:lineRule');
  let linePt: number | null = null;
  if (lineRaw && lineRule === 'exact') linePt = parseInt(lineRaw, 10) / 20;
  else if (lineRaw && lineRule === 'atLeast') linePt = parseInt(lineRaw, 10) / 20;
  else if (lineRaw && lineRule === 'auto') linePt = (parseInt(lineRaw, 10) / 240) * (defaults.size * 1.15);
  return {
    kind: hasPageBreak ? 'pagebreak' : 'para',
    runs,
    align: alignOf(pPr),
    indentPt: (twips(ind ?? para, 'ind', 0) || 0) / 20,
    spacingBeforePt: parseInt(spacing?.getAttribute('w:before') ?? '0', 10) / 20 || 0,
    spacingAfterPt: parseInt(spacing?.getAttribute('w:after') ?? '0', 10) / 20 || 0,
    linePt,
    images,
    endsSection,
  };
}

function tableFromEl(tbl: Element, defaults: { size: number }): DocxTable {
  const grid = tbl.getElementsByTagNameNS(W, 'gridCol');
  const columnWidths = Array.from(grid).map(col => parseInt(col.getAttribute('w:w') ?? '900', 10));
  const bordersEl = tbl.getElementsByTagNameNS(W, 'tblBorders')[0];
  const borders = !!bordersEl;
  const rows: DocxTableRow[] = [];
  for (const tr of tbl.getElementsByTagNameNS(W, 'tr')) {
    const cells: DocxTableCell[] = [];
    for (const tc of tr.getElementsByTagNameNS(W, 'tc')) {
      const tcPr = tc.getElementsByTagNameNS(W, 'tcPr')[0] ?? null;
      const spanEl = tcPr?.getElementsByTagNameNS(W, 'gridSpan')[0];
      const mergeEl = tcPr?.getElementsByTagNameNS(W, 'vMerge')[0];
      const shdEl = tcPr?.getElementsByTagNameNS(W, 'shd')[0];
      const fill = shdEl?.getAttribute('w:fill');
      const tcW = tcPr?.getElementsByTagNameNS(W, 'tcW')[0];
      const paragraphs: DocxParagraph[] = [];
      for (const p of tc.getElementsByTagNameNS(W, 'p')) paragraphs.push(paraFromEl(p, defaults));
      cells.push({
        paragraphs,
        gridSpan: spanEl ? parseInt(spanEl.getAttribute('w:val') ?? '1', 10) : 1,
        vMerge: mergeEl ? ((mergeEl.getAttribute('w:val') === 'restart' ? 'restart' : 'continue')) : null,
        fill: fill && fill !== 'auto' ? fill : undefined,
        widthTwips: twips(tcW ?? tc, 'w', 900),
      });
    }
    rows.push({ cells });
  }
  return { columnWidths, rows, borders };
}

function readSectPr(sectPr: Element): DocxSection {
  const pgSz = sectPr.getElementsByTagNameNS(W, 'pgSz')[0] ?? null;
  const pgMar = sectPr.getElementsByTagNameNS(W, 'pgMar')[0] ?? null;
  let width = twips(pgSz ?? sectPr, 'w', 12240);
  let height = twips(pgSz ?? sectPr, 'h', 15840);
  const orient = pgSz?.getAttribute('w:orient') === 'landscape';
  const landscape = orient || width > height;
  if (landscape && !orient && width > height) {
    // keep as-is
  }
  if (orient && width < height) [width, height] = [height, width];
  const bordersEl = sectPr.getElementsByTagNameNS(W, 'pgBorders')[0];
  return {
    widthTwips: width,
    heightTwips: height,
    landscape,
    margins: {
      top: twips(pgMar ?? sectPr, 'top', 1440),
      right: twips(pgMar ?? sectPr, 'right', 1440),
      bottom: twips(pgMar ?? sectPr, 'bottom', 1440),
      left: twips(pgMar ?? sectPr, 'left', 1440),
    },
    pageBorders: !!bordersEl,
  };
}

function headerFooterFromEl(root: Element): DocxHeaderFooter {
  let text = '';
  let hasPageField = false;
  let align: ParaAlign = 'left';
  // mc:AlternateContent duplicates every anchored textbox (Choice + Fallback).
  // 1) Skip runs nested inside a Fallback subtree.
  // 2) Skip runs that CONTAIN a textbox/drawing: their text is read once via the
  //    textbox's own inner paragraphs (enumerated separately below).
  const inFallback = (el: Element): boolean => {
    let node: Element | null = el;
    while (node) {
      if (node.localName === 'Fallback') return true;
      node = node.parentElement;
    }
    return false;
  };
  const containsBox = (r: Element): boolean =>
    !!Array.from(r.getElementsByTagName('*')).find(el => el.localName === 'txbxContent' || el.localName === 'AlternateContent' || el.localName === 'pict');
  // A run belongs to the paragraph whose NEAREST w:p ancestor is that paragraph —
  // this keeps textbox inner paragraphs from also being counted by the outer one.
  const nearestP = (el: Element): Element | null => {
    let node: Element | null = el;
    while (node) {
      if (node.localName === 'p') return node;
      node = node.parentElement;
    }
    return null;
  };
  for (const p of root.getElementsByTagNameNS(W, 'p')) {
    const pPr = p.getElementsByTagNameNS(W, 'pPr')[0] ?? null;
    const a = alignOf(pPr);
    if (a !== 'left') align = a;
    for (const r of p.getElementsByTagNameNS(W, 'r')) {
      if (nearestP(r) !== p) continue;
      if (inFallback(r) || containsBox(r)) continue;
      const fld = r.getElementsByTagNameNS(W, 'instrText')[0];
      if (fld && /PAGE|NUMPAGES/.test(fld.textContent ?? '')) hasPageField = true;
      for (const t of r.getElementsByTagNameNS(W, 't')) text += t.textContent ?? '';
    }
    text += '\n';
  }
  // Two anchored boxes (e.g. left name + right roll no) survive as separate
  // paragraphs; keep the newline so the renderer can split left/right.
  return { text: text.replace(/\n+$/, '').trim(), hasPageField, align };
}

async function relsMap(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const m = partPath.match(/^(.*\/)([^/]+)$/);
  const relPath = m ? `${m[1]}_rels/${m[2]}.rels` : `_rels/${partPath}.rels`;
  const file = zip.file(relPath);
  if (!file) return map;
  const xml = await file.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  for (const rel of doc.getElementsByTagName('Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

export async function parseDocx(file: File): Promise<ParsedDocx> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error('This file could not be read as a Word document.');
  }
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('This file could not be read as a Word document.');
  const documentXml = await documentFile.async('string');
  const doc = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('The file appears to be damaged or corrupted.');
  }
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  if (!body) throw new Error('This Word document is empty.');

  const images: Record<string, { data: Uint8Array; ext: string }> = {};
  const rels = await relsMap(zip, 'word/document.xml');
  for (const [relId, target] of rels) {
    if (!/media\//.test(target)) continue;
    const mediaFile = zip.file(target.startsWith('/') ? target.slice(1) : `word/${target}`);
    if (!mediaFile) continue;
    const data = await mediaFile.async('uint8array');
    const ext = (target.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase();
    images[relId] = { data, ext };
  }

  // Sections: each sectPr describes the section that ENDS at its position.
  const sections: DocxSection[] = [];
  // sectPr elements: the last one sits on w:body (final section); earlier ones
  // are marked on their hosting paragraph as we walk body children below.
  const sectPrs = doc.getElementsByTagNameNS(W, 'sectPr');
  for (const sectPr of sectPrs) sections.push(readSectPr(sectPr));
  if (!sections.length) {
    sections.push({
      widthTwips: 12240, heightTwips: 15840, landscape: false,
      margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, pageBorders: false,
    });
  }

  const defaults = { size: 11 };
  const stylesXml = zip.file('word/styles.xml');
  if (stylesXml) {
    const stylesDoc = new DOMParser().parseFromString(await stylesXml.async('string'), 'application/xml');
    const normal = Array.from(stylesDoc.getElementsByTagNameNS(W, 'style')).find(s => s.getAttribute('w:styleId') === 'Normal' || s.getAttribute('w:styleId') === 'Normal');
    const sz = normal?.getElementsByTagNameNS(W, 'sz')[0]?.getAttribute('w:val');
    if (sz) defaults.size = parseInt(sz, 10) / 2 || 11;
  }

  // Blocks: walk body children in order; sectPr-carrying paragraphs end sections.
  const blocks: DocxBlock[] = [];
  const bodyChildren = Array.from(body.children);
  let blockCount = 0;
  let sawTable = false;
  for (const child of bodyChildren) {
    if (child.localName === 'p') {
      const para = paraFromEl(child, defaults);
      // A body-level sectPr right after a table means the TABLE ends the
      // section; flag the paragraph anyway (it is empty and renders as a
      // small gap, then the break).
      const ownSect = para.endsSection || (sawTable && !!Array.from(child.children).some(c => c.localName === 'pPr' && Array.from(c.children).some(g => g.localName === 'sectPr')));
      sawTable = false;
      if (ownSect) (para as DocxParagraph).endsSection = true;
      blocks.push(para);
      blockCount++;
    } else if (child.localName === 'tbl') {
      blocks.push(tableFromEl(child, defaults));
      blockCount++;
      sawTable = true;
    } else if (child.localName === 'sectPr') {
      // Final body-level sectPr ends the document (no extra break needed).
      blockCount++;
    }
  }
  void blockCount;

  // Header/footer: scan every sectPr (Word often puts references only on the
  // FIRST section, inheriting them into later ones) and take the first part
  // that yields text or a page field.
  let header: DocxHeaderFooter | null = null;
  let footer: DocxHeaderFooter | null = null;
  const load = async (tag: 'header' | 'footer'): Promise<DocxHeaderFooter | null> => {
    for (const sect of sectPrs) {
      const refs = Array.from(sect.getElementsByTagNameNS(W, `${tag}Reference`));
      for (const ref of refs) {
        const relId = ref.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? ref.getAttribute('r:id');
        if (!relId) continue;
        const target = rels.get(relId);
        if (!target) continue;
        const partPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
        const part = zip.file(partPath);
        if (!part) continue;
        const xml = await part.async('string');
        const parsed = new DOMParser().parseFromString(xml, 'application/xml');
        const hf = headerFooterFromEl(parsed.documentElement);
        if (hf.text || hf.hasPageField) return hf;
      }
    }
    return null;
  };
  header = await load('header');
  footer = await load('footer');

  return { sections, blocks, header, footer, images };
}

export { esc };
