/**
 * pdfRest cloud conversion engine.
 *
 * Routes Word/Excel → PDF through the pdfRest "convert-to-pdf" endpoint
 * (https://api.pdfrest.com). Requires an API key supplied at runtime by the
 * user (stored only in localStorage, never committed). Falls back to the
 * local engine when no key is configured or the call fails.
 *
 * API flow per pdfrest-api-samples:
 *   POST /convert-to-pdf  (multipart: file, output; header Api-Key)
 *     -> { outputId }
 *   POST /download (multipart: id)
 *     -> binary PDF
 */

export const PDFREST_API_URL = 'https://api.pdfrest.com';
export const PDFREST_KEY_STORAGE = 'pdfrest-api-key';

export function getPdfRestKey(): string {
  try {
    return localStorage.getItem(PDFREST_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setPdfRestKey(key: string): void {
  try {
    if (key) localStorage.setItem(PDFREST_KEY_STORAGE, key.trim());
    else localStorage.removeItem(PDFREST_KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

export type CloudConversionType = 'word-to-pdf' | 'excel-to-pdf' | 'pdf-to-word';

/** Maps a conversion type to the pdfRest endpoint + accepted input formats. */
export function pdfRestEndpoint(type: CloudConversionType): { path: string; accept: string; outputName: (base: string) => string } {
  switch (type) {
    case 'pdf-to-word':
      return { path: '/pdf-to-word', accept: '.pdf', outputName: base => `${base}.docx` };
    case 'excel-to-pdf':
    case 'word-to-pdf':
    default:
      return { path: '/convert-to-pdf', accept: '.docx,.doc,.xlsx,.xls,.pptx,.csv', outputName: base => `${base}.pdf` };
  }
}

export interface CloudConvertResult {
  blob: Blob;
  fileName: string;
  viaCloud: true;
}

/** Announces progress into the shared overlay (#loadingStatusText). */
function announce(message: string): void {
  const el = document.getElementById('loadingStatusText');
  if (el) el.textContent = message;
}

export function showProcessingOverlay(message = 'Uploading file...'): void {
  const overlay = document.getElementById('processingOverlay');
  if (overlay) {
    overlay.style.display = 'flex';
    announce(message);
  }
}

export function hideProcessingOverlay(): void {
  const overlay = document.getElementById('processingOverlay');
  if (overlay) overlay.style.display = 'none';
}

/**
 * Converts a document through the pdfRest cloud API.
 * Throws with user-friendly messages so callers can fall back to the local engine.
 */
export async function convertDocumentViaCloudApi(
  fileObject: File,
  conversionType: CloudConversionType,
  options?: { apiKey?: string; onStatus?: (message: string) => void },
): Promise<CloudConvertResult> {
  const apiKey = options?.apiKey ?? getPdfRestKey();
  if (!apiKey) {
    throw new Error('No pdfRest API key configured. Add your key in Settings to use cloud conversion.');
  }

  const endpoint = pdfRestEndpoint(conversionType);
  options?.onStatus?.('Uploading file...');
  showProcessingOverlay('Uploading file...');

  try {
    // Step 1: upload + convert
    const form = new FormData();
    form.append('file', fileObject, fileObject.name);
    form.append('output', `${fileObject.name.replace(/\.[^.]+$/, '')}_pdfrest`);

    const uploadRes = await fetch(`${PDFREST_API_URL}${endpoint.path}`, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
        // Do NOT set Content-Type manually — the browser adds the multipart boundary.
      },
      body: form,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => '');
      if (uploadRes.status === 401) throw new Error('pdfRest rejected the API key (401). Check the key in Settings.');
      if (uploadRes.status === 429) throw new Error('pdfRest quota exceeded (429). Try again later or use local conversion.');
      throw new Error(`pdfRest upload failed (${uploadRes.status}). ${detail.slice(0, 140)}`);
    }

    const uploadJson = (await uploadRes.json()) as { outputId?: string };
    const outputId = uploadJson.outputId;
    if (!outputId) throw new Error('pdfRest did not return an outputId.');

    // Step 2: download the converted binary
    options?.onStatus?.('Converting layout...');
    announce('Converting layout...');
    const downloadForm = new FormData();
    downloadForm.append('id', outputId);
    const downloadRes = await fetch(`${PDFREST_API_URL}/download`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey },
      body: downloadForm,
    });
    if (!downloadRes.ok) throw new Error(`pdfRest download failed (${downloadRes.status}).`);

    const blob = await downloadRes.blob();
    const base = fileObject.name.replace(/\.[^.]+$/, '');
    const fileName = endpoint.outputName(base);

    // Purge: nothing object-URL based was created here; the caller owns the
    // returned blob and revokes its URL after the user downloads it.
    options?.onStatus?.('Done');
    return { blob, fileName, viaCloud: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(/pdfRest|API key|quota/.test(message) ? message : `Cloud conversion failed: ${message}`);
  } finally {
    hideProcessingOverlay();
  }
}
