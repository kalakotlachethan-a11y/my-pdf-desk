/**
 * Vision pipeline: converts Gemini's structured Markdown transcription into a
 * real editable DOCX — headings, paragraphs, GitHub Markdown tables, fenced
 * code blocks (Consolas), and explicit page breaks at "# Page N" boundaries.
 */
import {
  buildDocx,
  pageBreakXml,
  tableXml,
  paraXml,
  type ParaSpec,
  type RunSpec,
  type SectionSpec,
  type TableSpec,
  type TableCellSpec,
} from './docxBuilder';

const TWIP = 20;
const MONO_FONT = 'Consolas';
const BODY_FONT = 'Times New Roman';

interface Block {
  kind: 'heading' | 'para' | 'code' | 'table' | 'pagebreak';
  level: number;
  text: string;
  rows: string[][];
}

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    // Page marker from the vision prompt: "# Page N"
    const pageMark = /^#{1,2}\s*Page\s*\d+\s*$/i.exec(line);
    if (pageMark) {
      blocks.push({ kind: 'pagebreak', level: 0, text: '', rows: [] });
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i].replace(/\t/g, '    '));
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: 'code', level: 0, text: code.join('\n'), rows: [] });
      continue;
    }

    // Markdown table: header row + separator row.
    if (/^\|.*\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const rows: string[][] = [];
      const splitRow = (r: string) =>
        r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      rows.push(splitRow(line));
      i += 2;
      while (i < lines.length && /^\|.*\|/.test(lines[i].trim())) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', level: 0, text: '', rows });
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim(), rows: [] });
      i++;
      continue;
    }

    // Paragraph: gather until blank line / next block.
    if (line) {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^#{1,6}\s/.test(lines[i].trim()) &&
        !/^```/.test(lines[i].trim()) &&
        !/^\|.*\|/.test(lines[i].trim()) &&
        !/^#{1,2}\s*Page\s*\d+\s*$/i.test(lines[i].trim())
      ) {
        para.push(lines[i].trim());
        i++;
      }
      blocks.push({ kind: 'para', level: 0, text: para.join(' '), rows: [] });
      continue;
    }
    i++;
  }
  return blocks;
}

function inlineRuns(text: string, size: number, baseBold: boolean): RunSpec[] {
  // Preserve **bold** / *italic* inline markers from the transcription.
  const runs: RunSpec[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string, bold: boolean, italic: boolean) => {
    if (!t) return;
    runs.push({ text: t, size, bold, italic, underline: false, font: BODY_FONT });
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index), baseBold, false);
    if (m[1] !== undefined) push(m[1], true, false);
    else push(m[2], baseBold, true);
    last = m.index + m[0].length;
  }
  push(text.slice(last), baseBold, false);
  return runs.length ? runs : [{ text: '', size, bold: baseBold, italic: false, underline: false, font: BODY_FONT }];
}

function tableToSpec(rows: string[][]): TableSpec | null {
  const filled = rows.filter(r => r.some(c => c && c.replace(/\*\*/g, '').trim()));
  if (!filled.length) return null;
  const colCount = Math.max(...filled.map(r => r.length));
  if (colCount < 2) return null;
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const maxLen = Math.max(4, ...filled.map(r => (r[c] ?? '').replace(/\*\*/g, '').length));
    widths.push(Math.min(4800, Math.max(900, maxLen * 115)));
  }
  const specRows: TableCellSpec[][] = filled.map((row, r) =>
    Array.from({ length: colCount }, (_, c) => ({
      text: (row[c] ?? '').replace(/\*\*/g, '').trim(),
      bold: r === 0,
      size: 21,
    })),
  );
  return { columnWidths: widths, rows: specRows, borders: true };
}

function codePara(text: string): ParaSpec {
  return {
    runs: [{ text, size: 20, bold: false, italic: false, underline: false, font: MONO_FONT }],
    align: 'left',
    indentTwips: 0,
    spacingBefore: 0,
    spacingAfter: 0,
    lineTwips: 240,
  };
}

/** Build the DOCX blob from a Gemini Markdown transcription. */
export async function markdownToDocxBlob(markdown: string, pageWidthPt = 595, pageHeightPt = 842): Promise<Blob> {
  const blocks = parseMarkdown(markdown);
  const body: string[] = [];
  let firstPage = true;

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      if (!firstPage) body.push(pageBreakXml());
      firstPage = false;
      continue;
    }
    if (block.kind === 'heading') {
      const size = block.level <= 1 ? 32 : block.level === 2 ? 28 : block.level === 3 ? 24 : 22;
      body.push(paraXml({
        runs: inlineRuns(block.text, size, true),
        align: 'left',
        indentTwips: 0,
        spacingBefore: 140,
        spacingAfter: 80,
        lineTwips: null,
      }));
      continue;
    }
    if (block.kind === 'code') {
      for (const line of block.text.split('\n')) body.push(paraXml(codePara(line)));
      continue;
    }
    if (block.kind === 'table') {
      const spec = tableToSpec(block.rows);
      if (spec) body.push(tableXml(spec));
      continue;
    }
    body.push(paraXml({
      runs: inlineRuns(block.text, 22, false),
      align: 'left',
      indentTwips: 0,
      spacingBefore: 0,
      spacingAfter: 60,
      lineTwips: null,
    }));
  }

  const section: SectionSpec = {
    width: Math.round(pageWidthPt * TWIP),
    height: Math.round(pageHeightPt * TWIP),
    margins: { top: Math.round(68 * TWIP), bottom: Math.round(24 * TWIP), left: Math.round(72 * TWIP), right: Math.round(36 * TWIP) },
    landscape: pageWidthPt > pageHeightPt,
    pageBorders: false,
  };
  return buildDocx({ bodyXml: body.join(''), section, withFooter: false, footerText: '', images: [] });
}
