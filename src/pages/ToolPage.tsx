import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';import {
  Download, CheckCircle, ArrowLeft, RefreshCw,
  Shield, AlertCircle, PenLine, Undo2, ShieldCheck,
} from 'lucide-react';
import DropZone from '../components/DropZone';
import FileQueue, { type QueueFile } from '../components/FileQueue';
import ProcessingOverlay from '../components/ProcessingOverlay';
import { formatBytes } from '../components/formatBytes';
import { getToolBySlug, tools } from '../data/tools';
import { downloadProcessedFile, processTool, OCR_LANGUAGE_OPTIONS, type ProcessedResult, type VerifyReport } from '../lib/fileTools';

type ProcessingState = 'idle' | 'uploading' | 'processing' | 'done' | 'error';



function getAcceptedTypes(toolId: string): string {
  const map: Record<string, string> = {
    'pdf-to-jpg': '.pdf',
    'pdf-to-png': '.pdf',
    'jpg-to-pdf': '.jpg,.jpeg',
    'png-to-pdf': '.png',
    'pdf-scanner': '.jpg,.jpeg,.png,.webp',
    'word-to-pdf': '.docx',
    'pdf-to-word': '.pdf',
    'excel-to-pdf': '.xls,.xlsx',
    'powerpoint-to-pdf': '.ppt,.pptx',
    'image-compressor': '.jpg,.jpeg,.png,.webp',
    'add-images': '.pdf,.jpg,.jpeg,.png',
    'text-to-pdf': '.txt,.md,.html,.htm',
    'stamp-pdf': '.pdf,.png,.jpg,.jpeg',
  };
  return map[toolId] ?? '.pdf';
}

/** Extensions accepted for a tool, used to validate drops/picks before processing. */
const SIGNATURE_TOOLS = ['esign-pdf', 'draw-signature', 'upload-signature', 'digital-signature'];
const SIGNATURE_ACCEPT = '.png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml';

function getDefaultOptions(slug: string): Record<string, string> {
  const map: Record<string, Record<string, string>> = {
    'compress-pdf': { compression: 'medium' },
    'image-compressor': { compression: 'medium' },
    'batch-compress': { compression: 'medium' },
    'rotate-pdf': { rotation: '90' },
    'delete-pages': { pages: '1' },
    'extract-pages': { pages: '1' },
    'rearrange-pages': { pageOrder: '' },
    'add-text': { text: 'My PDF Desk' },
    'pdf-editor': { text: 'Edited with My PDF Desk' },
    'watermark-pdf': { watermarkText: 'CONFIDENTIAL', opacity: '40', watermarkSize: '16', watermarkRotation: '-45', pages: '' },
    'protect-pdf': { watermarkText: 'Protected Copy', opacity: '15' },
    'encrypt-pdf': { watermarkText: 'Protected Copy', opacity: '15' },
    'esign-pdf': { signature: 'Signed with My PDF Desk' },
    'draw-signature': { signature: 'Signed with My PDF Desk' },
    'upload-signature': { signature: 'Signed with My PDF Desk' },
    'digital-signature': { signature: 'Signed with My PDF Desk' },
    'page-numbering': { numberFormat: 'n-of-total', numberPosition: 'bottom-center', numberSize: 'medium' },
    'ocr-pdf': { ocrLang: 'eng' },
    'pdf-to-word': { mode: 'standard' },
    // Stirling parity defaults
    'overlay-pdfs': { overlayMode: 'sequential' },
    'crop-pdf': { cropTop: '5', cropBottom: '5', cropLeft: '5', cropRight: '5' },
    'multi-page-layout': { pagesPerSheet: '2' },
    'scale-pdf': { scaleFactor: '100' },
    'split-by-size': { maxSizeMb: '5' },
    'sanitize-pdf': { removeJs: 'true', removeMetadata: 'true', removeEmbedded: 'true', removeLinks: 'false' },
    'edit-metadata': { metaTitle: '', metaAuthor: '', metaSubject: '', metaKeywords: '' },
    'filter-pages': { filterMode: 'grayscale', filterContrast: '100', filterBrightness: '100' },
    'pdf-to-csv-xml': { extractFormat: 'csv' },
    'text-to-pdf': { fontSize: '12' },
    'stamp-pdf': { stampText: 'APPROVED', position: '1-1', color: 'black', rotation: '0', pages: 'all', stampImage: 'none' },
  };
  return map[slug] ?? {};
}

function acceptedLabel(accept: string) {
  return accept.replace(/\./g, '').replace(/,/g, ', ').toUpperCase();
}

/** Map raw processing errors to user-friendly messages; full detail stays in the console. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'PasswordException' || /password/i.test(raw)) {
    return 'This PDF is password-protected. Enter the correct password (where the tool offers a password field) and try again.';
  }
  if (/No PDF header|parse|Invalid PDF|invalid structure|corrupt|central directory|zip file|end of data/i.test(raw)) {
    return 'This file could not be read as a valid document. Please check the file — it may be corrupted or in a different format than its name suggests.';
  }
  if (/memory|allocation|Maximum call stack/i.test(raw)) {
    return 'This file is too large for your browser to process in one go. Try a smaller file or fewer pages.';
  }
  if (raw.length > 0 && raw.length <= 140) return raw;
  return 'Something went wrong while processing this file. Please try again with another file.';
}

export default function ToolPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const tool = getToolBySlug(slug);

  const [files, setFiles] = useState<QueueFile[]>([]);
  const [state, setState] = useState<ProcessingState>('idle');
  const [progress, setProgress] = useState(0);
  const [options, setOptions] = useState<Record<string, string>>(getDefaultOptions(slug));
  const [result, setResult] = useState<ProcessedResult | null>(null);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef<Array<{ color: string; width: number; points: Array<{ x: number; y: number }> }>>([]);
  const [inkColor, setInkColor] = useState('#0f172a');
  const [uploadedSignature, setUploadedSignature] = useState<string | null>(null);
  const sigInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const watermarkInputRef = useRef<HTMLInputElement>(null);
  const [verifyReport, setVerifyReport] = useState<VerifyReport | null>(null);

  useEffect(() => {
    setOptions(getDefaultOptions(slug));
    setHasSignature(false);
    setUploadedSignature(null);
    setVerifyReport(null);
    setInkColor('#0f172a');
    strokesRef.current = [];
      setFiles(prev => {
        prev.forEach(item => {
          if (item.preview) URL.revokeObjectURL(item.preview);
        });
        return [];
      });
      setState('idle');
      setProgress(0);
      setResult(null);
      setError('');
    }, [slug]);

  const setOption = useCallback((key: string, val: string) => {
    setOptions(prev => ({ ...prev, [key]: val }));
  }, []);

  /** Adds files to the queue; drops stale result state. */
  const handleFiles = useCallback((newFiles: File[]) => {
    const uploaded: QueueFile[] = newFiles.map(file => ({
      file,
      id: Math.random().toString(36).slice(2),
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    setFiles(prev => [...prev, ...uploaded]);
    setState('idle');
    setResult(null);
    setError('');
  }, []);

  /** Extension guard: blocks mismatches and surfaces an accessible alert. */
  const rejectFiles = useCallback((rejected: File[]) => {
    const names = rejected.map(f => f.name).join(', ');
    setError(`Unsupported file${rejected.length > 1 ? 's' : ''}: ${names.slice(0, 120)}${names.length > 120 ? '…' : ''}. This tool accepts ${acceptedLabel(getAcceptedTypes(slug))} files only.`);
    setState('error');
  }, [slug]);

  const reorderFiles = useCallback((from: number, to: number) => {
    setFiles(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /** Hard purge: revoke every preview URL and empty the queue. */
  const purgeFiles = useCallback(() => {
    setFiles(prev => {
      prev.forEach(item => {
        if (item.preview) URL.revokeObjectURL(item.preview);
      });
      return [];
    });
  }, []);

  const removeFile = (id: string) => {
    setFiles(prev => {
      const removed = prev.find(f => f.id === id);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter(f => f.id !== id);
    });
    setState('idle');
    setResult(null);
    setError('');
  };

  const runProcessing = async () => {
    if (slug === 'protect-pdf' && options.password && options.confirmPassword && options.password !== options.confirmPassword) {
      setError('The passwords do not match. Please re-enter them.');
      setState('error');
      return;
    }
    setState('uploading');
    setProgress(8);
    setError('');

    const finalOptions = { ...options };
    if (SIGNATURE_TOOLS.includes(slug) && canvasRef.current && hasSignature) {
      finalOptions.signatureData = canvasRef.current.toDataURL('image/png');
    }
    if (SIGNATURE_TOOLS.includes(slug) && !finalOptions.signatureData && uploadedSignature) {
      finalOptions.signatureData = uploadedSignature;
    }
    if (slug === 'watermark-pdf' && finalOptions.watermarkImage == null) {
      delete finalOptions.watermarkImage;
    }

    const progressTimer = window.setInterval(() => {
      setProgress(prev => Math.min(prev + 4, 92));
    }, 200);

    try {
      setState('processing');
      const processed = await processTool(slug, files.map(item => item.file), finalOptions);
      window.clearInterval(progressTimer);
      setProgress(100);
      setResult(processed);
      setVerifyReport(processed.verifyReport ?? null);
      setState('done');
    } catch (err) {
      window.clearInterval(progressTimer);
      setProgress(0);
      console.error('Tool processing failed:', err);
      setError(friendlyError(err));
      setState('error');
    }
  };

  const reset = () => {
    purgeFiles();
    setState('idle');
    setProgress(0);
    setResult(null);
    setError('');
    setOptions(getDefaultOptions(slug));
    setHasSignature(false);
  };

  /** Downloads results, then immediately purges blobs + queue (confidentiality). */
  const downloadAndPurge = () => {
    if (!result) return;
    result.files.forEach(downloadProcessedFile);
    // downloadProcessedFile revokes each URL after 500ms; queue purge runs now.
    purgeFiles();
    setState('idle');
    setResult(null);
    setProgress(0);
    setError('');
  };

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokesRef.current) {
      context.strokeStyle = stroke.color;
      context.lineWidth = stroke.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      stroke.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
    }
    setHasSignature(strokesRef.current.length > 0);
  }, []);

  const drawStroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.strokeStyle = inkColor;
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  };

  const undoStroke = () => {
    strokesRef.current.pop();
    redrawCanvas();
  };

  const clearSignature = () => {
    strokesRef.current = [];
    redrawCanvas();
  };

  const handleSignatureImage = useCallback((imageFile: File) => {
    const ok = /\.(png|jpe?g|svg)$/i.test(imageFile.name) || /^image\/(png|jpeg|svg\+xml)$/.test(imageFile.type);
    if (!ok) {
      setError('Unsupported signature file. Please choose a PNG, JPG or SVG image.');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      setUploadedSignature(reader.result as string);
      setHasSignature(false);
    };
    reader.readAsDataURL(imageFile);
  }, []);

  const handleImportSignaturePdf = useCallback(async (pdfFile: File) => {
    setError('');
    try {
      const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjsModule.getDocument({ data: new Uint8Array(await pdfFile.arrayBuffer()) });
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is not available in this browser.');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport } as never).promise;
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 0;
      canvas.height = 0;
      await task.destroy();
      setUploadedSignature(dataUrl);
      setHasSignature(false);
    } catch (err) {
      console.error('Signature import failed:', err);
      setError('Could not read that PDF to import a signature image. Please check the file and try again.');
    }
  }, []);

  if (!tool) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-900 flex items-center justify-center pt-16">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Tool not found</h1>
          <p className="text-gray-500 mb-6">This tool does not exist yet.</p>
          <button onClick={() => navigate('/')} className="btn-primary">Back to Home</button>
        </div>
      </div>
    );
  }

  const Icon = tool.icon;
  const acceptedTypes = getAcceptedTypes(slug);
  const relatedTools = tools.filter(t => t.category === tool.category && t.id !== slug).slice(0, 4);
  const isCompressTool = slug === 'compress-pdf' || slug === 'image-compressor' || slug === 'batch-compress';
  const showPageInput = slug === 'delete-pages' || slug === 'extract-pages';
  const showTextInput = slug === 'add-text' || slug === 'pdf-editor';
  const showSignatureInput = SIGNATURE_TOOLS.includes(slug);
  const showWatermarkInput = slug === 'watermark-pdf';

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-16">
      <div className="bg-gradient-to-br from-blue-50 via-white to-violet-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-6">
            <ArrowLeft size={16} /> Back to all tools
          </Link>
          <div className="flex items-start gap-5">
            <div className={`w-16 h-16 rounded-2xl ${tool.bgColor} flex items-center justify-center flex-shrink-0 shadow-md`}>
              <Icon size={32} className={tool.color} />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded-full">{tool.category}</span>
                {tool.popular && <span className="text-xs font-medium bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded-full">Popular</span>}
              </div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{tool.label}</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">{tool.description}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        {isCompressTool && state === 'idle' && files.length === 0 && (
          <div className="p-6 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4 text-lg">Select Compression Level</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { val: 'low', label: 'Low', desc: 'Best quality', color: 'text-green-600', borderColor: 'border-green-400' },
                { val: 'medium', label: 'Medium', desc: 'Balanced', color: 'text-yellow-600', borderColor: 'border-yellow-400' },
                { val: 'high', label: 'High', desc: 'Smallest output', color: 'text-red-600', borderColor: 'border-red-400' },
              ].map(({ val, label, desc, color, borderColor }) => (
                <button
                  key={val}
                  onClick={() => setOption('compression', val)}
                  className={`p-5 rounded-2xl border-2 transition-all ${
                    options.compression === val
                      ? `${borderColor} bg-white dark:bg-gray-800 shadow-lg scale-[1.02]`
                      : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 hover:shadow-sm'
                  }`}
                >
                  <div className="text-center">
                    <div className={`text-xl font-bold ${options.compression === val ? color : 'text-gray-900 dark:text-white'}`}>{label}</div>
                    <div className="text-sm text-gray-400 mt-1">{desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {(state === 'idle' || state === 'error' || files.length === 0) && (
          <DropZone
            accept={acceptedTypes}
            acceptLabel={acceptedLabel(acceptedTypes)}
            onFiles={handleFiles}
            onRejected={rejectFiles}
          />
        )}

        {files.length > 0 && (
          <FileQueue
            files={files}
            accept={acceptedTypes}
            busy={state === 'uploading' || state === 'processing'}
            done={state === 'done'}
            onAdd={handleFiles}
            onRejected={rejectFiles}
            onRemove={removeFile}
            onReorder={reorderFiles}
          />
        )}

        {(state === 'idle' || state === 'error') && files.length > 0 && (
          <div className="p-5 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700 space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Tool Options</h3>

            {isCompressTool && (
              <div className="grid grid-cols-3 gap-2">
                {['low', 'medium', 'high'].map(level => (
                  <button
                    key={level}
                    onClick={() => setOption('compression', level)}
                    className={`py-2 px-3 rounded-lg text-sm font-medium capitalize transition-all ${
                      options.compression === level
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}

            {slug === 'rotate-pdf' && (
              <>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Rotation</span>
                  <select
                    value={options.rotation ?? '90'}
                    onChange={e => setOption('rotation', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                  >
                    <option value="90">90 degrees clockwise</option>
                    <option value="180">180 degrees</option>
                    <option value="270">270 degrees clockwise</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Pages to rotate</span>
                  <input
                    value={options.pages ?? ''}
                    onChange={e => setOption('pages', e.target.value)}
                    placeholder="Leave blank to rotate all pages, or e.g. 1,3-5"
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                  />
                </label>
              </>
            )}

            {showPageInput && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Pages {slug === 'delete-pages' ? 'to delete' : 'to extract'}
                </span>
                <input
                  value={options.pages ?? '1'}
                  onChange={e => setOption('pages', e.target.value)}
                  placeholder="Example: 1,3-5"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                />
                <p className="text-xs text-gray-400 mt-1">Use page numbers or ranges, like 1,3-5.</p>
              </label>
            )}

            {slug === 'rearrange-pages' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Page order</span>
                <input
                  value={options.pageOrder ?? ''}
                  onChange={e => setOption('pageOrder', e.target.value)}
                  placeholder="Example: 3,1,2 or leave blank to reverse"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                />
              </label>
            )}

            {slug === 'split-pdf' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Split ranges</span>
                <input
                  value={options.ranges ?? ''}
                  onChange={e => setOption('ranges', e.target.value)}
                  placeholder="Leave blank for one file per page, or e.g. 1-3,5"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                />
                <p className="text-xs text-gray-400 mt-1">Each range or page becomes its own PDF. Example: 1-3,5 gives a 3-page PDF and a 1-page PDF.</p>
              </label>
            )}

            {(showTextInput || showWatermarkInput) && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {showWatermarkInput ? 'Watermark text' : 'Text to add'}
                </span>
                <input
                  value={showWatermarkInput ? options.watermarkText ?? '' : options.text ?? ''}
                  onChange={e => setOption(showWatermarkInput ? 'watermarkText' : 'text', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                />
              </label>
            )}

            {/* ---- Stirling parity tool options ---- */}
            {slug === 'overlay-pdfs' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Overlay mode</span>
                <select value={options.overlayMode ?? 'sequential'} onChange={e => setOption('overlayMode', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                  <option value="sequential">Sequential — overlay file N onto file 1's pages</option>
                  <option value="interleaved">Interleaved — alternate overlay pages with base pages</option>
                </select>
              </label>
            )}
            {slug === 'crop-pdf' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(['cropTop', 'cropBottom', 'cropLeft', 'cropRight'] as const).map(key => (
                  <label key={key} className="block">
                    <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 capitalize">{key.replace('crop', '')} %</span>
                    <input type="number" min={0} max={45} value={options[key] ?? '5'} onChange={e => setOption(key, e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                ))}
              </div>
            )}
            {slug === 'multi-page-layout' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Pages per sheet</span>
                <select value={options.pagesPerSheet ?? '2'} onChange={e => setOption('pagesPerSheet', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                  {['2', '3', '4', '6', '9'].map(n => <option key={n} value={n}>{n} pages per sheet</option>)}
                </select>
              </label>
            )}
            {slug === 'scale-pdf' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Scale factor %</span>
                <input type="number" min={10} max={400} value={options.scaleFactor ?? '100'} onChange={e => setOption('scaleFactor', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                <p className="text-xs text-gray-400 mt-1">100 = unchanged; 50 halves content; 200 doubles it.</p>
              </label>
            )}
            {slug === 'split-by-size' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Target size (MB per output file)</span>
                <input type="number" min={0.1} step={0.1} value={options.maxSizeMb ?? '5'} onChange={e => setOption('maxSizeMb', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
              </label>
            )}
            {slug === 'sanitize-pdf' && (
              <div className="space-y-2">
                {[['removeJs', 'Remove JavaScript actions'], ['removeMetadata', 'Remove metadata'], ['removeEmbedded', 'Remove embedded files'], ['removeLinks', 'Remove link annotations']].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input type="checkbox" checked={options[key] !== 'false'} onChange={e => setOption(key, String(e.target.checked))} className="w-4 h-4 accent-blue-600" />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {slug === 'edit-metadata' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {([['metaTitle', 'Title'], ['metaAuthor', 'Author'], ['metaSubject', 'Subject'], ['metaKeywords', 'Keywords']] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</span>
                    <input value={options[key] ?? ''} onChange={e => setOption(key, e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                ))}
              </div>
            )}
            {slug === 'filter-pages' && (
              <div className="space-y-3">
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Filter</span>
                  <select value={options.filterMode ?? 'grayscale'} onChange={e => setOption('filterMode', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                    <option value="grayscale">Grayscale</option>
                    <option value="invert">Invert colors</option>
                    <option value="contrast">Contrast boost</option>
                    <option value="brightness">Brightness boost</option>
                  </select>
                </label>
                {(options.filterMode === 'contrast' || options.filterMode === 'brightness') && (
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Amount %</span>
                    <input type="number" min={50} max={200} value={options.filterAmount ?? '130'} onChange={e => setOption('filterAmount', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                )}
              </div>
            )}
            {slug === 'pdf-to-csv-xml' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Output format</span>
                <select value={options.extractFormat ?? 'csv'} onChange={e => setOption('extractFormat', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                  <option value="csv">CSV</option>
                  <option value="xml">XML</option>
                </select>
              </label>
            )}
            {slug === 'text-to-pdf' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Base font size</span>
                <input type="number" min={8} max={24} value={options.fontSize ?? '12'} onChange={e => setOption('fontSize', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
              </label>
            )}
            {slug === 'stamp-pdf' && (
              <div className="space-y-3">
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Stamp text</span>
                  <input value={options.stampText ?? ''} onChange={e => setOption('stampText', e.target.value)} placeholder="Leave blank when stamping an image" className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Position</span>
                    <select value={options.position ?? '1-1'} onChange={e => setOption('position', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                      <option value="0-0">Bottom left</option>
                      <option value="1-0">Bottom center</option>
                      <option value="2-0">Bottom right</option>
                      <option value="0-1">Middle left</option>
                      <option value="1-1">Center</option>
                      <option value="2-1">Middle right</option>
                      <option value="0-2">Top left</option>
                      <option value="1-2">Top center</option>
                      <option value="2-2">Top right</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Apply to</span>
                    <select value={options.pages ?? 'all'} onChange={e => setOption('pages', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                      <option value="all">All pages</option>
                      <option value="first">First page only</option>
                    </select>
                  </label>
                </div>
              </div>
            )}

            {showSignatureInput && (
              <div className="space-y-4">
                <div>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    <PenLine size={14} /> Draw your signature
                  </span>
                  <canvas
                    ref={canvasRef}
                    width={480}
                    height={140}
                    aria-label="Signature drawing area"
                    className="w-full touch-none bg-white dark:bg-gray-900 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl cursor-crosshair"
                    onPointerDown={e => {
                      e.preventDefault();
                      drawingRef.current = true;
                      const point = getCanvasPoint(e);
                      lastPointRef.current = point;
                      strokesRef.current.push({ color: inkColor, width: 2.5, points: [point] });
                      drawStroke(point, point);
                      setHasSignature(true);
                    }}
                    onPointerMove={e => {
                      if (!drawingRef.current) return;
                      const point = getCanvasPoint(e);
                      if (lastPointRef.current) drawStroke(lastPointRef.current, point);
                      lastPointRef.current = point;
                      const stroke = strokesRef.current[strokesRef.current.length - 1];
                      if (stroke) stroke.points.push(point);
                    }}
                    onPointerUp={() => { drawingRef.current = false; lastPointRef.current = null; }}
                    onPointerLeave={() => { drawingRef.current = false; lastPointRef.current = null; }}
                  />
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Ink:</span>
                      {['#0f172a', '#1d4ed8', '#b91c1c'].map(color => (
                        <button
                          key={color}
                          type="button"
                          aria-label={`Ink color ${color}`}
                          onClick={() => setInkColor(color)}
                          className={`w-5 h-5 rounded-full border-2 ${inkColor === color ? 'border-gray-900 dark:border-white scale-110' : 'border-gray-300'}`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <button type="button" onClick={undoStroke} disabled={!hasSignature} className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40 inline-flex items-center gap-1"><Undo2 size={12} /> Undo</button>
                      <button type="button" onClick={clearSignature} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Clear</button>
                    </div>
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => sigInputRef.current?.click()} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100">Upload image (PNG, JPG, SVG)</button>
                    <button type="button" onClick={() => pdfInputRef.current?.click()} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100">Import from PDF (first page)</button>
                    {uploadedSignature && <button type="button" onClick={() => setUploadedSignature(null)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200">Choose another</button>}
                  </div>
                  <input ref={sigInputRef} type="file" accept={SIGNATURE_ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleSignatureImage(f); e.target.value = ''; }} />
                  <input ref={pdfInputRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleImportSignaturePdf(f); e.target.value = ''; }} />
                  {uploadedSignature ? (
                    <div className="flex items-center gap-3">
                      <img src={uploadedSignature} alt="Signature preview" className="max-h-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white object-contain" />
                      <p className="text-xs text-gray-400">Preview — transparent PNG keeps its transparency. The drawn canvas takes priority if both are used.</p>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">Or draw above / type below. Imported PDF pages become an image snapshot you can place anywhere.</p>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Page</span>
                    <input type="number" min={1} value={options.signPage ?? ''} placeholder="1" onChange={e => setOption('signPage', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">X position (pt)</span>
                    <input type="number" min={0} value={options.signatureX ?? ''} placeholder="42" onChange={e => setOption('signatureX', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Y position (pt from bottom)</span>
                    <input type="number" min={0} value={options.signatureY ?? ''} placeholder="96" onChange={e => setOption('signatureY', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                  </label>
                </div>
                <label className="block">
                  <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Width (pt) — height keeps the aspect ratio</span>
                  <input type="number" min={20} max={400} value={options.signatureWidth ?? ''} placeholder="120" onChange={e => setOption('signatureWidth', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Or type a signature line (used if nothing is drawn)</span>
                  <input
                    value={options.signature ?? ''}
                    onChange={e => setOption('signature', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                  />
                </label>

              </div>
            )}

            {slug === 'protect-pdf' && (
              <div className="space-y-4">
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Password required to open the PDF</span>
                  <input
                    type="password"
                    value={options.password ?? ''}
                    onChange={e => setOption('password', e.target.value)}
                    placeholder="At least 4 characters"
                    autoComplete="new-password"
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                  />
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Confirm password</span>
                  <input
                    type="password"
                    value={options.confirmPassword ?? ''}
                    onChange={e => setOption('confirmPassword', e.target.value)}
                    placeholder="Re-enter the password"
                    autoComplete="new-password"
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                  />
                </label>
                <p className="text-xs text-gray-400">AES-256 encryption, applied in your browser. The password cannot be recovered if lost.</p>
              </div>
            )}

            {slug === 'encrypt-pdf' && (
              <div className="space-y-2">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Allowed actions after opening</span>
                {[
                  ['printing', 'Printing'],
                  ['copying', 'Copying text and content'],
                  ['editing', 'Editing content'],
                  ['annotating', 'Adding annotations'],
                  ['fillingForms', 'Filling forms'],
                ].map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between p-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                    <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
                    <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                      {['allowed', 'blocked'].map(value => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setOption(key, value)}
                          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                            (options[key] ?? 'allowed') === value
                              ? value === 'allowed'
                                ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                                : 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300'
                              : 'bg-white dark:bg-gray-800 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700'
                          }`}
                        >
                          {value === 'allowed' ? 'Allowed' : 'Blocked'}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-gray-400 pt-1">The PDF opens without any password. Permission restrictions depend on the PDF viewer and may not be enforced by every application.</p>
              </div>
            )}

            {slug === 'unlock-pdf' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">PDF password (if known)</span>
                <input
                  type="password"
                  value={options.password ?? ''}
                  onChange={e => setOption('password', e.target.value)}
                  placeholder="Leave empty for restriction-only PDFs"
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white"
                />
              </label>
            )}

            {showWatermarkInput && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Size: {options.watermarkSize ?? '16'}% of page width</span>
                    <input type="range" min="4" max="60" value={options.watermarkSize ?? '16'} onChange={e => setOption('watermarkSize', e.target.value)} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Rotation: {options.watermarkRotation ?? '-45'}°</span>
                    <input type="range" min="-90" max="90" step="15" value={options.watermarkRotation ?? '-45'} onChange={e => setOption('watermarkRotation', e.target.value)} className="w-full" />
                  </label>
                </div>
                <div>
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Pages</span>
                  <input value={options.pages ?? ''} onChange={e => setOption('pages', e.target.value)} placeholder="Leave blank for all pages, or e.g. 1,3-5" className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white" />
                </div>
                <div className="p-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Image watermark (optional — replaces the text)</p>
                  <input ref={watermarkInputRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" onChange={e => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => setOption('watermarkImage', reader.result as string);
                    reader.readAsDataURL(file);
                  }} />
                  {options.watermarkImage ? (
                    <div className="flex items-center gap-3">
                      <img src={options.watermarkImage} alt="Watermark preview" className="max-h-16 rounded border border-gray-200 dark:border-gray-700 bg-white object-contain" />
                      <button type="button" onClick={() => setOption('watermarkImage', '')} className="text-xs text-red-600 hover:underline">Remove image</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => watermarkInputRef.current?.click()} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">Choose an image…</button>
                  )}
                </div>
              </>
            )}

            {slug === 'page-numbering' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Format</span>
                  <select value={options.numberFormat ?? 'n-of-total'} onChange={e => setOption('numberFormat', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                    <option value="n-of-total">1 / 10</option>
                    <option value="page-n">Page 1</option>
                    <option value="n">1</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Position</span>
                  <select value={options.numberPosition ?? 'bottom-center'} onChange={e => setOption('numberPosition', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                    <option value="bottom-center">Bottom centre</option>
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                    <option value="top-center">Top centre</option>
                    <option value="top-right">Top right</option>
                    <option value="top-left">Top left</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Size</span>
                  <select value={options.numberSize ?? 'medium'} onChange={e => setOption('numberSize', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                    <option value="small">Small (~10 pt)</option>
                    <option value="medium">Medium (~13 pt)</option>
                    <option value="large">Large (~16 pt)</option>
                  </select>
                </label>
              </div>
            )}

            {slug === 'pdf-to-word' && (
              <div className="space-y-3">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Conversion mode</span>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['standard', 'Standard', 'For PDFs with selectable text'],
                    ['ocr', 'OCR', 'For scanned or image-only PDFs'],
                  ].map(([value, label, hint]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setOption('mode', value)}
                      className={`p-3 rounded-xl text-left transition-all border ${
                        (options.mode ?? 'standard') === value
                          ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700'
                          : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <span className="block text-sm font-semibold text-gray-900 dark:text-white">{label}</span>
                      <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>
                    </button>
                  ))}
                </div>
                {options.mode === 'ocr' && (
                  <label className="block">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">OCR language</span>
                    <select value={options.ocrLang ?? 'eng'} onChange={e => setOption('ocrLang', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                      {OCR_LANGUAGE_OPTIONS.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                    </select>
                    <p className="text-xs text-gray-400 mt-1">OCR runs entirely in your browser. The language data downloads once, then it is cached.</p>
                  </label>
                )}
                <p className="text-xs text-gray-400">The output is a real, editable Word document — never a screenshot. If the PDF has no selectable text, Standard mode will ask you to switch to OCR.</p>
              </div>
            )}

            {slug === 'ocr-pdf' && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Document language</span>
                <select value={options.ocrLang ?? 'eng'} onChange={e => setOption('ocrLang', e.target.value)} className="w-full px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white">
                  {OCR_LANGUAGE_OPTIONS.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">OCR runs entirely in your browser. The first run downloads the language data once, then it is cached. Up to 30 pages are processed.</p>
              </label>
            )}

            {slug === 'verify-signature' && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                The check inspects the PDF's real signature dictionaries (AcroForm, /FT /Sig, ByteRange). Drawn or image signatures are reported as electronic marks — they cannot be cryptographically verified.
              </p>
            )}

            {showWatermarkInput && (
              <label className="block">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Opacity: {options.opacity ?? '40'}%</span>
                <input
                  type="range"
                  min="10"
                  max="80"
                  value={options.opacity ?? '40'}
                  onChange={e => setOption('opacity', e.target.value)}
                  className="w-full"
                />
              </label>
            )}

            {slug === 'add-images' && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Upload one PDF plus one JPG or PNG image. The image will be placed on the first page.
              </p>
            )}
          </div>
        )}

        <ProcessingOverlay
          active={state === 'uploading' || state === 'processing' || state === 'done'}
          progress={progress}
          statusText={state === 'uploading' ? 'Reading your local files…' : `Applying ${tool.label.toLowerCase()}…`}
          toolLabel={tool.label}
          result={state === 'done' ? result : null}
          onDownloadAndReset={downloadAndPurge}
          onResetOnly={reset}
        />

        {state === 'error' && (
          <div className="p-5 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-red-800 dark:text-red-300">Could not process this file</h3>
                <p className="text-sm text-red-600 dark:text-red-300 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {state === 'done' && result && (
          <div className="p-6 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={22} className="text-emerald-600" />
              <h3 className="font-bold text-emerald-800 dark:text-emerald-300 text-lg">Processing Complete!</h3>
            </div>
            <p className="text-sm text-emerald-700 dark:text-emerald-300 mb-5">{result.message}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <div className="text-center p-4 bg-white dark:bg-gray-800 rounded-xl shadow-sm">
                <div className="text-xl font-bold text-gray-900 dark:text-white">{formatBytes(result.originalSize)}</div>
                <div className="text-sm text-gray-400 mt-1">Original</div>
              </div>
              <div className="text-center p-4 bg-white dark:bg-gray-800 rounded-xl shadow-sm">
                <div className="text-xl font-bold text-emerald-600">{formatBytes(result.newSize)}</div>
                <div className="text-sm text-gray-400 mt-1">Output</div>
              </div>
              <div className="text-center p-4 bg-white dark:bg-gray-800 rounded-xl shadow-sm">
                <div className="text-xl font-bold text-blue-600">{result.files.length}</div>
                <div className="text-sm text-gray-400 mt-1">Download{result.files.length === 1 ? '' : 's'}</div>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <button onClick={downloadAndPurge} className="btn-primary flex-1 justify-center">
                <Download size={18} /> Download {result.files.length > 1 ? 'Results' : 'Result'}
              </button>
              <button onClick={reset} className="btn-secondary flex items-center gap-2 justify-center">
                <RefreshCw size={18} /> Process Another
              </button>
            </div>
            {verifyReport && (
              <div className="mt-5 p-4 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className={verifyReport.status === 'invalid' ? 'text-red-600' : 'text-blue-600'} />
                  <span className="font-semibold text-gray-900 dark:text-white">Signature Status</span>
                  <span className={`ml-auto px-2 py-0.5 rounded-full text-xs font-bold ${
                    verifyReport.status === 'electronic-only' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      : verifyReport.status === 'invalid' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}
                  >
                    {verifyReport.status === 'electronic-only' ? 'Electronic mark only' : verifyReport.status === 'invalid' ? 'Invalid' : verifyReport.status === 'valid' ? 'Valid' : 'Cannot be determined'}
                  </span>
                </div>
                {verifyReport.status === 'electronic-only' && (
                  <p className="text-amber-700 dark:text-amber-300">Electronic signature mark detected — this is a visual/electronic signature. It is not a cryptographic digital signature, so certificate-based authenticity cannot be verified.</p>
                )}
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    ['Signer', verifyReport.signer],
                    ['Certificate', verifyReport.certificate],
                    ['Certificate expiry', verifyReport.certificateExpiry],
                    ['Trust', verifyReport.trust],
                    ['Document integrity', verifyReport.integrity],
                    ['Timestamp', verifyReport.timestamp],
                    ['Signature fields found', String(verifyReport.signatureCount)],
                  ].map(([label, value]) => value != null && (
                    <div key={label} className="flex justify-between gap-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-900">
                      <dt className="text-gray-400">{label}</dt>
                      <dd className="text-gray-800 dark:text-gray-200 text-right">{value}</dd>
                    </div>
                  ))}
                </dl>
                <details className="text-xs text-gray-500 dark:text-gray-400">
                  <summary className="cursor-pointer font-medium">Verification details</summary>
                  <ul className="list-disc pl-5 mt-2 space-y-1">
                    {verifyReport.details.map((detail, index) => <li key={index}>{detail}</li>)}
                  </ul>
                </details>
              </div>
            )}
          </div>
        )}

        {(state === 'idle' || state === 'error') && files.length > 0 && (
          <button onClick={runProcessing} className="btn-primary w-full justify-center text-base py-4">
            <Icon size={20} />
            {tool.label}
          </button>
        )}

        <div className="p-5 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-3">File Handling Notes</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { text: 'Browser-side processing', color: 'text-emerald-500' },
              { text: 'Reset clears selected files', color: 'text-blue-500' },
              { text: 'Downloads created locally', color: 'text-violet-500' },
            ].map(({ text, color }) => (
              <div key={text} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <Shield size={14} className={color} />
                {text}
              </div>
            ))}
          </div>
        </div>

        {relatedTools.length > 0 && (
          <div className="p-5 rounded-2xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Related Tools</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {relatedTools.map(relTool => {
                const RelIcon = relTool.icon;
                return (
                  <Link
                    key={relTool.id}
                    to={`/tools/${relTool.id}`}
                    className="flex items-center gap-2 p-3 rounded-xl bg-white dark:bg-gray-700 hover:shadow-md transition-all group"
                  >
                    <div className={`w-8 h-8 rounded-lg ${relTool.bgColor} flex items-center justify-center flex-shrink-0`}>
                      <RelIcon size={16} className={relTool.color} />
                    </div>
                    <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">{relTool.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
