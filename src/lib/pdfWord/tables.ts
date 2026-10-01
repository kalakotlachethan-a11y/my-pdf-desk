/**
 * PDF → Word: table detection from vector border lines.
 * Clusters H/V lines into a grid, merges nearby coordinates, and assigns each
 * text line to its cell. Works on borderless column layouts as a fallback by
 * treating tab-separated rows as light tables when a header row exists.
 */
import type { PdfLine, VectorLine } from './extract';

export interface TableGrid {
  xs: number[]; // column boundaries (ascending)
  ys: number[]; // row boundaries (ascending, PDF coords — y grows upward)
  cells: string[][]; // cells[row][col]
}



export function detectTables(lines: PdfLine[], vectorLines: VectorLine[]): TableGrid[] {
  const tables: TableGrid[] = [];
  const H = vectorLines.filter(l => Math.abs(l.y1 - l.y2) < 1.4);
  const V = vectorLines.filter(l => Math.abs(l.x1 - l.x2) < 1.4);
  if (H.length < 2 || V.length < 2) return tables;

  // Cluster candidate row boundaries (y) and column boundaries (x).
  const yRaw = H.map(l => (l.y1 + l.y2) / 2).sort((a, b) => b - a);
  const yClusters: number[] = [];
  for (const y of yRaw) {
    if (!yClusters.length || yClusters[yClusters.length - 1] - y > 4.5) yClusters.push(y);
  }
  const xRaw = V.map(l => (l.x1 + l.x2) / 2).sort((a, b) => a - b);
  const xAll: number[] = [];
  for (const x of xRaw) {
    if (!xAll.length || x - xAll[xAll.length - 1] > 4.5) xAll.push(x);
  }
  if (yClusters.length < 2 || xAll.length < 2) return tables;

  // H coverage per y cluster (union length of segments near that y).
  const hCoverage = (y: number): number => {
    let union = 0;
    let segs: Array<[number, number]> = [];
    for (const l of H) {
      if (Math.abs((l.y1 + l.y2) / 2 - y) > 4.5) continue;
      segs.push([Math.min(l.x1, l.x2), Math.max(l.x1, l.x2)]);
    }
    if (!segs.length) return 0;
    segs = segs.sort((a, b) => a[0] - b[0]);
    let curEnd = -Infinity;
    for (const [a, b] of segs) {
      if (a > curEnd) { union += b - a; curEnd = b; }
      else if (b > curEnd) { union += b - curEnd; curEnd = b; }
    }
    return union;
  };

  // Keep ys with meaningful horizontal coverage relative to the overall span.
  const span = xAll[xAll.length - 1] - xAll[0];
  const rowYs = yClusters.filter(y => hCoverage(y) >= Math.max(24, span * 0.18));
  if (rowYs.length < 2) return tables;

  // Split into separate tables when a large vertical gap separates row bands.
  const groups: number[][] = [];
  let cur: number[] = [rowYs[0]];
  for (let i = 1; i < rowYs.length; i++) {
    if (rowYs[i - 1] - rowYs[i] > 60) {
      if (cur.length >= 2) groups.push(cur);
      cur = [];
    }
    cur.push(rowYs[i]);
  }
  if (cur.length >= 2) groups.push(cur);

  for (const rowsY of groups) {
    const top = rowsY[0];
    const bottom = rowsY[rowsY.length - 1];
    // Columns: V lines actually crossing this row band.
    const bandV = V.filter(l => Math.max(l.y1, l.y2) >= bottom - 2 && Math.min(l.y1, l.y2) <= top + 2);
    const bandXs: number[] = [];
    for (const x of bandV.map(l => (l.x1 + l.x2) / 2).sort((a, b) => a - b)) {
      if (!bandXs.length || x - bandXs[bandXs.length - 1] > 4.5) bandXs.push(x);
    }
    if (bandXs.length < 2) continue;

    const cells: string[][] = [];
    const cellBold: boolean[][] = [];
    for (let r = 0; r < rowsY.length - 1; r++) {
      const yTop = rowsY[r];
      const yBot = rowsY[r + 1];
      const row: string[] = new Array(bandXs.length - 1).fill('');
      const bold: boolean[] = new Array(bandXs.length - 1).fill(false);
      for (const line of lines) {
        if (!(line.y > yBot && line.y < yTop)) continue;
        for (const span of line.spans) {
          let col = -1;
          for (let c = 0; c < bandXs.length - 1; c++) {
            if (span.x >= bandXs[c] - 2 && span.x < bandXs[c + 1] - 2) { col = c; break; }
          }
          if (col < 0) continue;
          if (row[col] && !row[col].endsWith(' ')) row[col] += ' ';
          row[col] += span.str;
          if (span.bold) bold[col] = true;
        }
      }
      cells.push(row.map(c => c.replace(/\s{2,}/g, ' ').trim()));
      cellBold.push(bold);
    }
    // A real table needs content in more than one cell.
    const filled = cells.flat().filter(c => c).length;
    if (filled >= Math.max(2, Math.floor((bandXs.length - 1) / 2))) {
      const grid: TableGrid = { xs: bandXs, ys: rowsY, cells };
      gridCellBold.set(grid, cellBold);
      tables.push(grid);
    }
  }
  return tables;
}

/** Per-grid bold flags captured during detection (cells[row][col]). */
const gridCellBold = new WeakMap<TableGrid, boolean[][]>();
export function gridBoldFlags(grid: TableGrid): boolean[][] | undefined {
  return gridCellBold.get(grid);
}

/** Bounding box helper: does any table claim this line? */
export function tableClaimsLine(tables: TableGrid[], line: PdfLine): boolean {
  return tables.some(t =>
    line.y < Math.max(...t.ys) && line.y > Math.min(...t.ys) &&
    line.left < Math.max(...t.xs) && line.right > Math.min(...t.xs),
  );
}

/** Word column widths (twips) from grid column boundaries. */
export function columnWidthsTwips(grid: TableGrid): number[] {
  const widths: number[] = [];
  for (let i = 0; i < grid.xs.length - 1; i++) {
    widths.push(Math.round((grid.xs[i + 1] - grid.xs[i]) * 20));
  }
  return widths;
}
