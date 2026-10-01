/**
 * PDF → Word: DOCX package builder.
 * Emits a valid minimal OOXML WordprocessingML package: content types, rels,
 * document.xml, styles.xml, optional footer with a PAGE field, and media.
 */
import JSZip from 'jszip';

export type Align = 'left' | 'center' | 'right';

export interface RunSpec {
  text: string;
  size: number; // half-points
  bold: boolean;
  italic: boolean;
  underline: boolean;
  font: string;
  color?: string; // hex without '#'
}

export interface ParaSpec {
  runs: RunSpec[];
  align: Align;
  indentTwips: number;
  spacingBefore: number; // twips
  spacingAfter: number; // twips
  lineTwips: number | null; // exact line spacing
  keepNext?: boolean;
  pageBreakBefore?: boolean;
}

export interface TableCellSpec {
  text: string;
  bold: boolean;
  size: number;
  align?: Align;
  fill?: string;
}

export interface TableSpec {
  columnWidths: number[]; // twips
  rows: TableCellSpec[][];
  borders: boolean;
}

export interface SectionSpec {
  width: number; // twips
  height: number;
  margins: { top: number; bottom: number; left: number; right: number };
  landscape: boolean;
  pageBorders: boolean;
}

export const xmlEscape = (value: string) =>
  value.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c));

export function runXml(run: RunSpec): string {
  const parts = [`<w:rFonts w:ascii="${xmlEscape(run.font)}" w:hAnsi="${xmlEscape(run.font)}"/>`];
  if (run.bold) parts.push('<w:b/>');
  if (run.italic) parts.push('<w:i/>');
  if (run.underline) parts.push('<w:u w:val="single"/>');
  parts.push(`<w:sz w:val="${Math.round(run.size)}"/>`);
  parts.push(`<w:szCs w:val="${Math.round(run.size)}"/>`);
  if (run.color) parts.push(`<w:color w:val="${run.color}"/>`);
  const text = run.text.length ? `<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t>` : '';
  return `<w:r><w:rPr>${parts.join('')}</w:rPr>${text}</w:r>`;
}

export function paraXml(para: ParaSpec): string {
  const pPr: string[] = [];
  const needsPr =
    para.align !== 'left' || para.indentTwips || para.spacingBefore || para.spacingAfter ||
    para.lineTwips || para.keepNext || para.pageBreakBefore;
  if (needsPr) {
    pPr.push('<w:pPr>');
    if (para.keepNext) pPr.push('<w:keepNext/>');
    if (para.pageBreakBefore) pPr.push('<w:pageBreakBefore/>');
    const spacing = para.lineTwips
      ? `<w:spacing w:before="${para.spacingBefore}" w:after="${para.spacingAfter}" w:line="${para.lineTwips}" w:lineRule="exact"/>`
      : `<w:spacing w:before="${para.spacingBefore}" w:after="${para.spacingAfter}"/>`;
    pPr.push(spacing);
    if (para.indentTwips) pPr.push(`<w:ind w:left="${para.indentTwips}"/>`);
    if (para.align !== 'left') pPr.push(`<w:jc w:val="${para.align}"/>`);
    pPr.push('</w:pPr>');
  }
  return `<w:p>${pPr.join('')}${para.runs.map(runXml).join('')}</w:p>`;
}

export function pageBreakXml(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

export function tableXml(spec: TableSpec): string {
  const total = spec.columnWidths.reduce((a, b) => a + b, 0);
  const borders = spec.borders
    ? '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders>'
    : '';
  const grid = `<w:tblGrid>${spec.columnWidths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const rows = spec.rows.map(cells =>
    `<w:tr>${spec.columnWidths
      .map((w, i) => {
        const cell = cells[i] ?? { text: '', bold: false, size: 21 };
        const fill = cell.fill ? `<w:shd w:val="clear" w:fill="${cell.fill}"/>` : '';
        const align = cell.align && cell.align !== 'left' ? `<w:jc w:val="${cell.align}"/>` : '';
        const tcPr = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill}</w:tcPr>`;
        const pPr = align ? `<w:pPr>${align}</w:pPr>` : '';
        const run = runXml({ text: cell.text, size: cell.size, bold: cell.bold, italic: false, underline: false, font: 'Times New Roman' });
        return `<w:tc>${tcPr}<w:p>${pPr}${run}</w:p></w:tc>`;
      })
      .join('')}</w:tr>`,
  );
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${borders}</w:tblPr>${grid}${rows.join('')}</w:tbl>`;
}

export function imageParaXml(relId: string, widthPt: number, heightPt: number): string {
  const cx = Math.round(widthPt * 12700);
  const cy = Math.round(heightPt * 12700);
  return (
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="1" name="Picture"/><wp:cNvGraphicFramePr/>` +
    `<wp:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="1" name="image"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></wp:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

export function sectPrXml(section: SectionSpec, footerRel?: string, headerRel?: string): string {
  const orient = section.landscape ? ' orient="landscape"' : '';
  const borders = section.pageBorders
    ? '<w:pgBorders w:offsetFrom="page"><w:top w:val="single" w:sz="4" w:space="24" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="24" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="24" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="24" w:color="000000"/></w:pgBorders>'
    : '';
  const footer = footerRel ? `<w:footerReference w:type="default" r:id="${footerRel}"/>` : '';
  const header = headerRel ? `<w:headerReference w:type="default" r:id="${headerRel}"/>` : '';
  return (
    `<w:sectPr>${footer}${header}` +
    `<w:pgSz w:w="${section.width}" w:h="${section.height}"${orient}/>` +
    `<w:pgMar w:top="${section.margins.top}" w:right="${section.margins.right}" w:bottom="${section.margins.bottom}" w:left="${section.margins.left}" w:header="0" w:footer="237" w:gutter="0"/>` +
    `${borders}</w:sectPr>`
  );
}

export function footerXml(footerText = '', align: 'left' | 'center' | 'right' = 'center'): string {
  const jc = { left: 'left', center: 'center', right: 'right' }[align];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr>` +
    `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(footerText)}</w:t></w:r></w:p>` +
    '</w:ftr>'
  );
}

export function headerXml(headerText: string, align: 'left' | 'center' | 'right' = 'center'): string {
  const jc = { left: 'left', center: 'center', right: 'right' }[align];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr>` +
    `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(headerText)}</w:t></w:r></w:p>` +
    '</w:hdr>'
  );
}

export const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="jpg" ContentType="image/jpeg"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
  '</Types>';

export const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

export const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>';

export interface DocxBuildInput {
  bodyXml: string;
  section: SectionSpec;
  withFooter: boolean;
  images: Array<{ dataUrl: string; ext: 'png' | 'jpg' }>;
  /** Real footer text extracted from the PDF; emitted as an actual Word footer. */
  footerText?: string;
  /** Real header text extracted from the PDF; emitted as an actual Word header. */
  headerText?: string;
  /** Footer text alignment. */
  footerAlign?: 'left' | 'center' | 'right';
}

/** Assemble + validate the DOCX package (zip round-trip + required parts). */
export async function buildDocx(input: DocxBuildInput): Promise<Blob> {
  const zip = new JSZip();
  const rels: string[] = [];
  const images = input.images;
  images.forEach((image, index) => {
    rels.push(
      `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.ext}"/>`,
    );
    zip.file(`word/media/image${index + 1}.${image.ext}`, image.dataUrl.split(',')[1], { base64: true });
  });
  let footerRel: string | undefined;
  let headerRel: string | undefined;
  if (input.withFooter) {
    zip.file('word/footer1.xml', footerXml(input.footerText ?? '', input.footerAlign ?? 'center'));
    rels.push(
      '<Relationship Id="rIdFtr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    );
    footerRel = 'rIdFtr1';
  }
  if (input.headerText) {
    zip.file('word/header1.xml', headerXml(input.headerText));
    rels.push(
      '<Relationship Id="rIdHdr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    );
    headerRel = 'rIdHdr1';
  }

  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file('word/styles.xml', STYLES_XML);
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${input.bodyXml}${sectPrXml(input.section, footerRel, headerRel)}</w:body></w:document>`);

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  // Validation: round-trip the zip and confirm required parts exist and parse.
  const check = await JSZip.loadAsync(await blob.arrayBuffer());
  const docXml = await check.file('word/document.xml')!.async('string');
  if (!docXml.includes('<w:body>') || !docXml.includes('<w:sectPr>')) {
    throw new Error('DOCX validation failed');
  }
  const parser = new DOMParser();
  const parsed = parser.parseFromString(docXml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length) {
    throw new Error('DOCX XML validation failed');
  }
  return blob;
}
