/**
 * Server-side PDF parsing client.
 * POSTs the uploaded PDF to the /api/parse-pdf Vercel function and returns the
 * structured parse result. Returns null on any failure (endpoint missing on the
 * static GitHub Pages deploy, network error, oversized file) so callers can
 * transparently fall back to local client-side parsing.
 */

export interface ApiPdfPage {
  num: number;
  text: string;
  width: number;
  height: number;
}

export interface ApiPdfTable {
  num: number;
  cells: string[][][];
}

export interface ApiPdfImage {
  num: number;
  dataUrl: string;
  width: number | null;
  height: number | null;
}

export interface ApiGeoItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

export interface ApiGeoLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ApiGeoPage {
  num: number;
  width: number;
  height: number;
  items: ApiGeoItem[];
  lines: ApiGeoLine[];
}

export interface ApiPdfDoc {
  ok: true;
  numpages: number;
  title: string | null;
  author: string | null;
  pages: ApiPdfPage[];
  tables: ApiPdfTable[];
  images: ApiPdfImage[];
  geometry?: ApiGeoPage[];
}

const ENDPOINT = '/api/parse-pdf';
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // matches the server guard
const TIMEOUT_MS = 90_000; // large scanned PDFs can take a while server-side

/** Try server-side parsing; null means "fall back to local processing". */
export async function parsePdfViaApi(file: File): Promise<ApiPdfDoc | null> {
  try {
    if (file.size > MAX_UPLOAD_BYTES) return null;
    const form = new FormData();
    form.append('file', file, file.name || 'document.pdf');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, { method: 'POST', body: form, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null; // static-host fallback page
    const data = (await res.json()) as Partial<ApiPdfDoc> | null;
    if (!data || data.ok !== true || !Array.isArray(data.pages) || data.pages.length === 0) return null;
    return {
      ok: true,
      numpages: typeof data.numpages === 'number' ? data.numpages : data.pages.length,
      title: data.title ?? null,
      author: data.author ?? null,
      pages: data.pages,
      tables: Array.isArray(data.tables) ? data.tables : [],
      images: Array.isArray(data.images) ? data.images : [],
      geometry: Array.isArray(data.geometry) ? data.geometry : [],
    };
  } catch {
    return null;
  }
}
