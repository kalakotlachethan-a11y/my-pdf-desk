/**
 * ONE central Stirling-PDF API service.
 *
 * Architecture (per deployment requirements):
 *   PDF Desk frontend  →  STIRLING_BASE (same-origin proxy "/stirling" by default,
 *   or an absolute URL the user configures in Settings)  →  Stirling-PDF server.
 *
 * - Endpoint map generated from the real Stirling Swagger/OpenAPI spec (v0.33.1).
 * - No secrets in source: base URL and API key live in localStorage, set by the
 *   user at runtime (Settings). A same-origin "/stirling" proxy is the default
 *   so a serverless/edge proxy can hold credentials server-side if deployed.
 * - processPdf(): validates input, builds multipart FormData with the exact
 *   field names from the spec, POSTs, validates the binary response, and
 *   returns a Blob + filename. Never parses binary responses as JSON.
 * - Every call is cancellable (AbortSignal) and time-boxed.
 */

export const STIRLING_BASE_STORAGE = 'stirling-base-url';
export const STIRLING_KEY_STORAGE = 'stirling-api-key';

/** Default goes through a same-origin proxy path so deployments can mount one. */
export const DEFAULT_STIRLING_BASE = '/stirling';

export function getStirlingBase(): string {
  try {
    return localStorage.getItem(STIRLING_BASE_STORAGE) || DEFAULT_STIRLING_BASE;
  } catch {
    return DEFAULT_STIRLING_BASE;
  }
}

export function setStirlingBase(url: string): void {
  try {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (trimmed) localStorage.setItem(STIRLING_BASE_STORAGE, trimmed);
    else localStorage.removeItem(STIRLING_BASE_STORAGE);
  } catch { /* storage unavailable */ }
}

export function getStirlingKey(): string {
  try {
    return localStorage.getItem(STIRLING_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setStirlingKey(key: string): void {
  try {
    if (key) localStorage.setItem(STIRLING_KEY_STORAGE, key.trim());
    else localStorage.removeItem(STIRLING_KEY_STORAGE);
  } catch { /* storage unavailable */ }
}

/* ------------------------------------------------------------------ */
/* Endpoint configuration map — from the real Swagger spec.            */
/* field names + enums verified against /v1/api-docs (Stirling 0.33.1) */
/* ------------------------------------------------------------------ */

export interface StirlingToolConfig {
  endpoint: string;
  /** Input field name; "fileInput" everywhere in the spec, arrays for multi-file tools. */
  input?: 'fileInput';
  /** Whether the endpoint takes multiple files (array in spec). */
  multiple?: boolean;
  /** Extra multipart fields with safe defaults. */
  fields?: Record<string, string | number | boolean>;
  /** Expected output for validation. */
  output: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'txt' | 'html' | 'xml' | 'images' | 'json';
  label: string;
}

export const STIRLING_TOOLS: Record<string, StirlingToolConfig> = {
  // conversions
  'pdf-to-word':    { endpoint: '/api/v1/convert/pdf/word',          input: 'fileInput', fields: { outputFormat: 'docx' }, output: 'docx', label: 'PDF → Word' },
  'word-to-pdf':    { endpoint: '/api/v1/convert/file/pdf',          input: 'fileInput', output: 'pdf', label: 'Word → PDF' },
  'excel-to-pdf':   { endpoint: '/api/v1/convert/file/pdf',          input: 'fileInput', output: 'pdf', label: 'Excel → PDF' },
  'ppt-to-pdf':     { endpoint: '/api/v1/convert/file/pdf',          input: 'fileInput', output: 'pdf', label: 'PPT → PDF' },
  'pdf-to-ppt':     { endpoint: '/api/v1/convert/pdf/presentation',  input: 'fileInput', fields: { outputFormat: 'pptx' }, output: 'pptx', label: 'PDF → PPT' },
  'pdf-to-excel':   { endpoint: '/api/v1/convert/pdf/csv',           input: 'fileInput', output: 'csv', label: 'PDF → CSV/Excel' },
  'pdf-to-jpg':     { endpoint: '/api/v1/convert/pdf/img',           input: 'fileInput', fields: { imageFormat: 'jpeg', singleOrMultiple: 'multiple', colorType: 'color', dpi: '150' }, output: 'images', label: 'PDF → JPG' },
  'jpg-to-pdf':     { endpoint: '/api/v1/convert/img/pdf',           input: 'fileInput', multiple: true, fields: { fitOption: 'maintainAspectRatio', colorType: 'color', autoRotate: true }, output: 'pdf', label: 'JPG → PDF' },
  'pdf-to-text':    { endpoint: '/api/v1/convert/pdf/text',          input: 'fileInput', output: 'txt', label: 'PDF → Text' },
  'html-to-pdf':    { endpoint: '/api/v1/convert/url/pdf',           input: 'fileInput', output: 'pdf', label: 'HTML/URL → PDF' },
  // organize
  'merge-pdfs':     { endpoint: '/api/v1/general/merge-pdfs',        input: 'fileInput', multiple: true, fields: { sortType: 'orderProvided' }, output: 'pdf', label: 'Merge' },
  'split-pdf':      { endpoint: '/api/v1/general/split-pages',       input: 'fileInput', output: 'pdf', label: 'Split' },
  'remove-pages':   { endpoint: '/api/v1/general/remove-pages',      input: 'fileInput', output: 'pdf', label: 'Remove pages' },
  'rotate-pdf':     { endpoint: '/api/v1/general/rotate-pdf',        input: 'fileInput', output: 'pdf', label: 'Rotate' },
  'organize-pdf':   { endpoint: '/api/v1/general/rearrange-pages',   input: 'fileInput', output: 'pdf', label: 'Organize' },
  'crop-pdf':       { endpoint: '/api/v1/general/crop',              input: 'fileInput', output: 'pdf', label: 'Crop' },
  'multi-page-layout': { endpoint: '/api/v1/general/multi-page-layout', input: 'fileInput', output: 'pdf', label: 'Multi-page layout' },
  'overlay-pdfs':   { endpoint: '/api/v1/general/overlay-pdfs',      input: 'fileInput', multiple: true, output: 'pdf', label: 'Overlay' },
  // optimize
  'compress-pdf':   { endpoint: '/api/v1/misc/compress-pdf',         input: 'fileInput', fields: { optimizeLevel: 3 }, output: 'pdf', label: 'Compress' },
  'ocr-pdf':        { endpoint: '/api/v1/misc/ocr-pdf',              input: 'fileInput', fields: { languages: 'eng', ocrType: 'skip-text', ocrRenderType: 'hocr', sidecar: false, deskew: false, clean: false, cleanFinal: false, removeImagesAfter: false }, output: 'pdf', label: 'OCR' },
  'repair-pdf':     { endpoint: '/api/v1/misc/repair',               input: 'fileInput', output: 'pdf', label: 'Repair' },
  'flatten-pdf':    { endpoint: '/api/v1/misc/flatten',              input: 'fileInput', output: 'pdf', label: 'Flatten' },
  // security
  'protect-pdf':    { endpoint: '/api/v1/security/add-password',     input: 'fileInput', output: 'pdf', label: 'Protect' },
  'unlock-pdf':     { endpoint: '/api/v1/security/remove-password',  input: 'fileInput', output: 'pdf', label: 'Unlock' },
  'add-watermark':  { endpoint: '/api/v1/security/add-watermark',    input: 'fileInput', fields: { watermarkType: 'text', alphabet: 'roman' }, output: 'pdf', label: 'Watermark' },
  'sanitize-pdf':   { endpoint: '/api/v1/security/sanitize-pdf',     input: 'fileInput', output: 'pdf', label: 'Sanitize' },
  'redact-pdf':     { endpoint: '/api/v1/security/auto-redact',      input: 'fileInput', output: 'pdf', label: 'Redact' },
  // misc
  'page-numbers':   { endpoint: '/api/v1/misc/add-page-numbers',     input: 'fileInput', fields: { customMargin: 'small', fontSize: 24 }, output: 'pdf', label: 'Page numbers' },
  'add-image':      { endpoint: '/api/v1/misc/add-image',            input: 'fileInput', output: 'pdf', label: 'Add image' },
  'add-stamp':      { endpoint: '/api/v1/misc/add-stamp',            input: 'fileInput', output: 'pdf', label: 'Stamp' },
  'extract-images': { endpoint: '/api/v1/misc/extract-images',       input: 'fileInput', output: 'images', label: 'Extract images' },
  'remove-blanks':  { endpoint: '/api/v1/misc/remove-blanks',        input: 'fileInput', output: 'pdf', label: 'Remove blanks' },
  'auto-rename':    { endpoint: '/api/v1/misc/auto-rename',          input: 'fileInput', output: 'pdf', label: 'Auto-rename' },
  'update-metadata':{ endpoint: '/api/v1/misc/update-metadata',      input: 'fileInput', output: 'pdf', label: 'Metadata' },
  'pdf-to-csv-xml': { endpoint: '/api/v1/convert/pdf/xml',           input: 'fileInput', output: 'xml', label: 'PDF → XML' },
};

/* ------------------------------------------------------------------ */
/* Health check                                                        */
/* ------------------------------------------------------------------ */

export interface StirlingHealth {
  reachable: boolean;
  version?: string;
  message: string;
}

export async function checkStirlingHealth(timeoutMs = 6000): Promise<StirlingHealth> {
  const base = getStirlingBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/v1/info/status`, { signal: controller.signal, headers: authHeaders() });
    if (!res.ok) return { reachable: false, message: `PDF Engine: unavailable (HTTP ${res.status})` };
    const text = await res.text();
    let version = '';
    try {
      const json = JSON.parse(text) as { version?: string };
      version = json.version ?? '';
    } catch { /* non-JSON body is fine */ }
    return { reachable: true, version, message: version ? `PDF Engine: Ready (Stirling ${version})` : 'PDF Engine: Ready' };
  } catch {
    return { reachable: false, message: 'PDF Engine: Temporarily unavailable — local engine will be used.' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Central request function                                            */
/* ------------------------------------------------------------------ */

export class StirlingApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  const key = getStirlingKey();
  return key ? { 'X-API-Key': key } : {};
}

export interface ProcessPdfOptions {
  fields?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

const EXT_BY_OUTPUT: Record<StirlingToolConfig['output'], string> = {
  pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', csv: 'csv',
  txt: 'txt', html: 'html', xml: 'xml', images: 'zip', json: 'json',
};

const MIME_BY_OUTPUT: Record<StirlingToolConfig['output'], string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  xml: 'application/xml',
  images: 'application/zip',
  json: 'application/json',
};

/** Sensible output name; server Content-Disposition is used when present and safe. */
function fileNameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const name = m?.[1]?.replace(/"/g, '');
  if (!name || /[\\/]/.test(name) || name.includes('..')) return null;
  return decodeURIComponent(name);
}

/**
 * Runs one Stirling endpoint call end-to-end.
 * Throws StirlingApiError with a user-facing message on any failure.
 */
export async function processPdf(
  toolKey: string,
  files: File[],
  options: ProcessPdfOptions = {},
): Promise<{ blob: Blob; fileName: string }> {
  const cfg = STIRLING_TOOLS[toolKey];
  if (!cfg) throw new StirlingApiError(`Unknown tool "${toolKey}".`);
  if (!files.length) throw new StirlingApiError('No file selected.');
  if (cfg.multiple && files.length < 2 && toolKey === 'merge-pdfs') {
    throw new StirlingApiError('Merge needs at least 2 PDF files.');
  }

  const { onStatus } = options;
  onStatus?.('Uploading file...');

  const form = new FormData();
  if (cfg.multiple) for (const f of files) form.append('fileInput', f, f.name);
  else form.append('fileInput', files[0], files[0].name);

  const merged = { ...(cfg.fields ?? {}), ...(options.fields ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    form.append(k, String(v));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(`${getStirlingBase()}${cfg.endpoint}`, {
      method: 'POST',
      headers: { Accept: '*/*', ...authHeaders() },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new StirlingApiError(
      aborted
        ? 'The processing request timed out. Please try again with a smaller file.'
        : 'Unable to connect to the PDF processing server. Please try again.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { message?: string; error?: string };
        detail = json.message || json.error || text.slice(0, 140);
      } catch {
        detail = text.slice(0, 140);
      }
    } catch { /* ignore */ }
    const friendly =
      res.status === 401 || res.status === 403 ? 'The PDF server rejected the API key.' :
      res.status === 404 ? 'This tool is not available on the configured PDF server (endpoint not found).' :
      res.status === 400 ? `The PDF server rejected the request. ${detail}` :
      res.status === 413 ? 'The file is too large for the PDF processing server.' :
      res.status === 429 ? 'Rate limited by the PDF server. Try again shortly.' :
      `The PDF server returned an error (HTTP ${res.status}). ${detail}`;
    throw new StirlingApiError(friendly.trim(), res.status);
  }

  onStatus?.('Preparing download...');
  const blob = await res.blob();
  if (!blob || blob.size === 0) {
    throw new StirlingApiError('The server returned an empty file. The document may be corrupted or unsupported.');
  }

  // Response validation: signature check for known binary types.
  if (cfg.output === 'pdf' || cfg.output === 'docx' || cfg.output === 'pptx' || cfg.output === 'xlsx' || cfg.output === 'images') {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
    const isZip = head[0] === 0x50 && head[1] === 0x4b; // PK (office/zip)
    const ok = cfg.output === 'pdf' ? isPdf : (isZip || isPdf);
    if (!ok) {
      throw new StirlingApiError('The server returned an unexpected file type. Conversion failed.');
    }
  }

  const dispositionName = fileNameFromDisposition(res.headers.get('Content-Disposition'));
  const base = files[0].name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  const fileName = dispositionName ?? `${base}.${EXT_BY_OUTPUT[cfg.output]}`;
  const typed = blob.type ? blob : new Blob([blob], { type: MIME_BY_OUTPUT[cfg.output] });

  return { blob: typed, fileName };
}
