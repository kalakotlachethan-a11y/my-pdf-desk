import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowLeft, Bold, Check, ChevronLeft, ChevronRight, Download,
  Expand, FileText, Italic, Loader2, Maximize2, Minus, MousePointer2,
  Plus, Redo2, Trash2, Type, Underline, Undo2, Upload, X,
} from 'lucide-react';
// Legacy build: polyfills Uint8Array.toHex etc., required for the Freebuff/older Chromium runtimes
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfDocumentProxy = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy['getPage']>>;
type PageViewport = ReturnType<PdfPageProxy['getViewport']>;
type RenderTask = ReturnType<PdfPageProxy['render']>;

interface TextSpan {
  id: string;
  pageIndex: number;
  text: string;
  pdfX: number;
  pdfY: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  left: number;
  top: number;
  screenWidth: number;
  screenHeight: number;
}

interface TextChange {
  id: string;
  sourceId?: string;
  type: 'existing' | 'added';
  pageIndex: number;
  text: string;
  originalText?: string;
  pdfX: number;
  pdfY: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  deleted?: boolean;
  originalBox?: { x: number; y: number; w: number; h: number };
}

type Selection = { type: 'existing'; id: string } | { type: 'added'; id: string } | null;

const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const fontChoices = ['Helvetica', 'Times New Roman', 'Courier New', 'Arial', 'Georgia', 'Verdana'];
const maxFileSize = 60 * 1024 * 1024;
const historyLimit = 60;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function bytesToBlobPart(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function fileBaseName(name: string) {
  return name.replace(/\.pdf$/i, '') || 'document';
}

/** Replace characters the standard PDF fonts cannot encode so export never hard-fails. */
function sanitizeForPdf(text: string) {
  return text
    .replace(/\r/g, '')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\t/g, '    ');
}

function fontVariant(doc: PDFDocument, family: string, bold: boolean, italic: boolean): Promise<PDFFont> {
  const isCourier = family.includes('Courier');
  const isTimes = family.includes('Times');
  if (isCourier) {
    return doc.embedFont(bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier);
  }
  if (isTimes) {
    return doc.embedFont(bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman);
  }
  // Helvetica, Arial, Georgia, Verdana all map to the Helvetica family.
  return doc.embedFont(bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica);
}

function transformTextItem(item: unknown, viewport: PageViewport, pageIndex: number, index: number): TextSpan | null {
  const textItem = item as {
    str?: string;
    width?: number;
    height?: number;
    transform?: number[];
    fontName?: string;
  };
  if (!textItem.str?.trim() || !textItem.transform) return null;

  const tx = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
  const fontSize = Math.max(6, Math.hypot(textItem.transform[2], textItem.transform[3]));
  const screenHeight = Math.max(6, Math.hypot(tx[2], tx[3]));
  const rawWidth = textItem.width ?? textItem.str.length * fontSize * 0.5;

  return {
    id: `s-${pageIndex}-${index}`,
    pageIndex,
    text: textItem.str,
    pdfX: textItem.transform[4],
    pdfY: textItem.transform[5],
    width: Math.max(4, rawWidth),
    height: Math.max(6, textItem.height ?? fontSize),
    fontSize,
    fontFamily: textItem.fontName?.includes('Courier') ? 'Courier New' : textItem.fontName?.includes('Times') ? 'Times New Roman' : 'Helvetica',
    left: tx[4],
    top: tx[5] - screenHeight,
    screenWidth: Math.max(6, rawWidth * viewport.scale),
    screenHeight,
  };
}

function changeToScreen(change: TextChange, viewport: PageViewport) {
  const [left, topBaseline] = viewport.convertToViewportPoint(change.pdfX, change.pdfY);
  return {
    left,
    top: topBaseline - change.fontSize * viewport.scale,
    width: Math.max(24, change.width * viewport.scale),
    height: Math.max(16, change.fontSize * change.lineHeight * viewport.scale),
    fontSize: Math.max(6, change.fontSize * viewport.scale),
  };
}

function makeChangeFromSpan(span: TextSpan): TextChange {
  return {
    id: `edit-${span.id}`,
    sourceId: span.id,
    type: 'existing',
    pageIndex: span.pageIndex,
    text: span.text,
    originalText: span.text,
    pdfX: span.pdfX,
    pdfY: span.pdfY,
    width: span.width,
    height: span.height,
    fontSize: span.fontSize,
    fontFamily: span.fontFamily,
    color: '#111827',
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    lineHeight: 1.25,
    originalBox: { x: span.pdfX, y: span.pdfY - span.height * 0.22, w: span.width, h: span.height * 1.22 },
  };
}

/** Wrap a single logical line into physical lines that fit maxWidth (PDF points). */
function wrapLine(font: PDFFont, line: string, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(line, size) <= maxWidth || maxWidth <= 0) return [line];
  const words = line.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [line];
}

function PageThumbnail({ pdfDoc, pageNumber, active, onSelect }: {
  pdfDoc: PdfDocumentProxy | null;
  pageNumber: number;
  active: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || cancelled) return;
      observer.disconnect();
      void (async () => {
        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 0.22 });
        if (cancelled) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) return;
        task = page.render({ canvasContext: context, viewport } as never);
        await task.promise;
      })().catch(() => { /* thumbnail rendering is best-effort */ });
    }, { rootMargin: '300px' });
    observer.observe(canvas);
    return () => {
      cancelled = true;
      observer.disconnect();
      task?.cancel();
    };
  }, [pdfDoc, pageNumber]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Go to page ${pageNumber}`}
      aria-current={active}
      className={`w-full rounded-xl border-2 p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        active ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50' : 'border-transparent hover:border-blue-300'
      }`}
    >
      <div className="aspect-[3/4] w-full overflow-hidden rounded-md bg-white">
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
      </div>
      <span className={`mt-1 block text-center text-xs font-semibold ${active ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}`}>
        {pageNumber}
      </span>
    </button>
  );
}

export default function PdfEditorPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderIdRef = useRef(0);
  const dragRef = useRef<{ id: string; startX: number; startY: number; originalX: number; originalY: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; startWidth: number; startSize: number } | null>(null);
  const historyRef = useRef<{ stack: TextChange[][]; index: number }>({ stack: [[]], index: 0 });
  const changesRef = useRef<TextChange[]>([]);
  const inlineEditDraftRef = useRef<{ id: string; text: string } | null>(null);

  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [textSpans, setTextSpans] = useState<TextSpan[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'select' | 'add-text'>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [changes, setChanges] = useState<TextChange[]>([]);
  const [historyMeta, setHistoryMeta] = useState({ canUndo: false, canRedo: false });
  const [isExporting, setIsExporting] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const pinchRef = useRef({ pointers: new Map<number, { x: number; y: number }>(), baseZoom: 1, baseDist: 0 });
  const didInitialFitRef = useRef(false);

  changesRef.current = changes;

  const pageChanges = useMemo(() => changes.filter(change => change.pageIndex === currentPage - 1), [changes, currentPage]);
  const selectedChange = useMemo(() => {
    if (!selection) return null;
    return changes.find(change => change.id === selection.id || change.sourceId === selection.id) ?? null;
  }, [changes, selection]);
  const selectedSpan = useMemo(() => selection?.type === 'existing' ? textSpans.find(span => span.id === selection.id) ?? null : null, [selection, textSpans]);
  const hasText = textSpans.length > 0;

  const selectedEditable = selectedChange ?? (selectedSpan ? makeChangeFromSpan(selectedSpan) : null);
  const showMobileSheet = !isDesktop && Boolean(inlineEditId);

  const commit = useCallback((next: TextChange[]) => {
    const history = historyRef.current;
    const trimmed = history.stack.slice(0, history.index + 1);
    trimmed.push(next);
    history.stack = trimmed.length > historyLimit ? trimmed.slice(trimmed.length - historyLimit) : trimmed;
    history.index = history.stack.length - 1;
    setChanges(next);
    setHistoryMeta({ canUndo: history.index > 0, canRedo: false });
  }, []);

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (history.index <= 0) return;
    history.index -= 1;
    setChanges(history.stack[history.index]);
    setHistoryMeta({ canUndo: history.index > 0, canRedo: true });
  }, []);

  const redo = useCallback(() => {
    const history = historyRef.current;
    if (history.index >= history.stack.length - 1) return;
    history.index += 1;
    setChanges(history.stack[history.index]);
    setHistoryMeta({ canUndo: true, canRedo: history.index < history.stack.length - 1 });
  }, []);

  const applyProperty = useCallback((field: keyof TextChange, value: string | number | boolean) => {
    const existing = changesRef.current.find(change => change.id === selectedEditable?.id);
    if (!existing) {
      // Selection predates its change object (e.g. after undo): create it first.
      if (selectedEditable) {
        commit([...changesRef.current, { ...selectedEditable, [field]: value }]);
      }
      return;
    }
    commit(changesRef.current.map(change => change.id === existing.id ? { ...change, [field]: value } : change));
  }, [commit, selectedEditable]);

  const loadPdf = useCallback(async (file: File) => {
    setError('');
    setNotice('');

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a valid PDF file. Accepted format: .pdf');
      return;
    }
    if (file.size > maxFileSize) {
      setError('This PDF is larger than 60 MB. Try a smaller file for browser editing.');
      return;
    }

    setIsLoading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loaded = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false } as Parameters<typeof pdfjsLib.getDocument>[0]).promise;
      setPdfFile(file);
      setPdfDoc(loaded);
      setPageCount(loaded.numPages);
      setCurrentPage(1);
      setSelection(null);
      setInlineEditId(null);
      setChanges([]);
      historyRef.current = { stack: [[]], index: 0 };
      setHistoryMeta({ canUndo: false, canRedo: false });
      setMode('select');
      setZoom(1);
      didInitialFitRef.current = false;
    } catch (err) {
      if ((err as { name?: string }).name === 'PasswordException') {
        setError('This PDF is password protected. Remove the password and try again.');
      } else {
        setError('Unable to open this PDF. It may be corrupted or use unsupported features.');
      }
      setPdfDoc(null);
      setPdfFile(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    const renderId = renderIdRef.current + 1;
    renderIdRef.current = renderId;
    const activeDoc = pdfDoc;

    async function renderPage() {
      const page = await activeDoc.getPage(currentPage);
      const nextViewport = page.getViewport({ scale: zoom });
      const canvas = canvasRef.current;
      if (!canvas || cancelled || renderId !== renderIdRef.current) return;

      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = Math.ceil(nextViewport.width);
      canvas.height = Math.ceil(nextViewport.height);
      canvas.style.width = `${Math.ceil(nextViewport.width)}px`;
      canvas.style.height = `${Math.ceil(nextViewport.height)}px`;

      context.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport: nextViewport } as never).promise;
      const content = await page.getTextContent();
      const spans = content.items
        .map((item, index) => transformTextItem(item, nextViewport, currentPage - 1, index))
        .filter((item): item is TextSpan => Boolean(item));

      if (!cancelled && renderId === renderIdRef.current) {
        setViewport(nextViewport);
        setTextSpans(spans);
        setNotice(spans.length
          ? 'Your PDF stays in your browser and is not uploaded to our server.'
          : 'This page appears to be scanned. Existing text cannot be directly edited. You can use Add Text to place new text on the page.');
      }
    }

    renderPage().catch(() => setError('Unable to render this page. Try another page or file.'));

    return () => {
      cancelled = true;
    };
  }, [currentPage, pdfDoc, zoom]);

  // Ctrl + wheel zoom, synchronized across canvas, text layer, and controls.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handler = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(prev => {
        const target = prev * (event.deltaY < 0 ? 1.12 : 1 / 1.12);
        const closest = zoomLevels.reduce((best, level) => Math.abs(level - target) < Math.abs(best - target) ? level : best, zoomLevels[0]);
        return Math.min(3, Math.max(0.5, closest));
      });
    };
    container.addEventListener('wheel', handler, { passive: false });
    return () => container.removeEventListener('wheel', handler);
  }, [pdfDoc]);

  // Keep the on-screen keyboard from covering the mobile edit sheet.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;
    const updateInset = () => setKeyboardInset(Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop));
    updateInset();
    visualViewport.addEventListener('resize', updateInset);
    visualViewport.addEventListener('scroll', updateInset);
    return () => {
      visualViewport.removeEventListener('resize', updateInset);
      visualViewport.removeEventListener('scroll', updateInset);
    };
  }, []);

  // Mobile: bring the box being edited into view above the keyboard.
  useEffect(() => {
    if (!inlineEditId || isDesktop) return;
    const id = inlineEditId;
    const timer = window.setTimeout(() => {
      const element = pageWrapRef.current?.querySelector(`[data-change-id="${id}"]`);
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [inlineEditId, isDesktop]);

  // Phones: fit the page to the screen width on first render.
  useEffect(() => {
    if (!viewport || didInitialFitRef.current) return;
    didInitialFitRef.current = true;
    if (!window.matchMedia('(max-width: 1023px)').matches) return;
    const container = scrollRef.current;
    if (!container) return;
    const pageWidthPt = viewport.width / zoom;
    const target = Math.min(2, Math.max(0.5, (container.clientWidth - 24) / pageWidthPt));
    setZoom(Math.round(target * 100) / 100);
  }, [viewport, zoom]);

  // Pinch-to-zoom: two-pointer tracking on the scroll section. The section keeps
  // touch-action: pan (native one-finger scrolling); the browser does not claim
  // two-finger pinch there, so we receive both pointers and zoom ourselves.
  const pinchDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const handleSectionPointerDown = (event: React.PointerEvent) => {
    pinchRef.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchRef.current.pointers.size === 2) {
      const [a, b] = [...pinchRef.current.pointers.values()];
      pinchRef.current.baseDist = pinchDistance(a, b);
      pinchRef.current.baseZoom = zoom;
    }
  };

  const handleSectionPointerMove = (event: React.PointerEvent) => {
    const pinch = pinchRef.current;
    const position = pinch.pointers.get(event.pointerId);
    if (!position) return;
    position.x = event.clientX;
    position.y = event.clientY;
    if (pinch.pointers.size === 2 && pinch.baseDist > 0) {
      const [a, b] = [...pinch.pointers.values()];
      const next = Math.min(3, Math.max(0.5, pinch.baseZoom * (pinchDistance(a, b) / pinch.baseDist)));
      setZoom(Math.round(next * 100) / 100);
    }
  };

  const handleSectionPointerUp = (event: React.PointerEvent) => {
    const pinch = pinchRef.current;
    pinch.pointers.delete(event.pointerId);
    if (pinch.pointers.size < 2) pinch.baseDist = 0;
  };

  const changeZoom = (direction: 1 | -1) => {
    const candidates = direction === 1
      ? zoomLevels.filter(level => level > zoom + 0.001)
      : [...zoomLevels].reverse().filter(level => level < zoom - 0.001);
    setZoom(candidates[0] ?? (direction === 1 ? zoomLevels[zoomLevels.length - 1] : zoomLevels[0]));
  };

  const fitTo = (fitMode: 'width' | 'page') => {
    if (!viewport || !scrollRef.current) return;
    const container = scrollRef.current;
    const margin = window.matchMedia('(max-width: 1023px)').matches ? 24 : 64;
    const availableWidth = Math.max(280, container.clientWidth - margin);
    const availableHeight = Math.max(380, container.clientHeight - margin);
    const pageWidthPt = viewport.width / zoom;
    const pageHeightPt = viewport.height / zoom;
    const target = fitMode === 'width'
      ? availableWidth / pageWidthPt
      : Math.min(availableWidth / pageWidthPt, availableHeight / pageHeightPt);
    setZoom(Math.min(3, Math.max(0.5, Math.round(target * 100) / 100)));
  };

  const startEditingSpan = useCallback((span: TextSpan) => {
    // Mobile sheet edits are discard-until-Done: switching targets reverts them.
    if (inlineEditId && !isDesktop) setChanges(historyRef.current.stack[historyRef.current.index]);
    const existing = changesRef.current.find(change => change.sourceId === span.id);
    inlineEditDraftRef.current = null;
    if (existing) {
      setSelection({ type: 'existing', id: span.id });
      setInlineEditId(existing.id);
      return;
    }
    const change = makeChangeFromSpan(span);
    commit([...changesRef.current, change]);
    setSelection({ type: 'existing', id: span.id });
    setInlineEditId(change.id);
  }, [commit, inlineEditId, isDesktop]);

  const addTextAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!viewport) return;
    if (mode !== 'add-text') {
      // Clicking the page background while the inline editor is open must COMMIT the
      // draft (what the user typed) instead of discarding it with the unmount.
      const draft = inlineEditDraftRef.current;
      if (inlineEditId && draft) {
        const current = changesRef.current.find(item => item.id === draft.id);
        if (current && draft.text !== current.text) {
          commit(changesRef.current.map(item => item.id === draft.id ? { ...item, text: draft.text } : item));
        }
        inlineEditDraftRef.current = null;
      }
      if (!isDesktop) setChanges(historyRef.current.stack[historyRef.current.index]);
      setSelection(null);
      setInlineEditId(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const left = event.clientX - rect.left;
    const top = event.clientY - rect.top;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(left, top);
    const id = `add-${Date.now()}`;
    const change: TextChange = {
      id,
      type: 'added',
      pageIndex: currentPage - 1,
      text: 'New text',
      pdfX,
      pdfY,
      width: 120,
      height: 24,
      fontSize: 18,
      fontFamily: 'Helvetica',
      color: '#111827',
      bold: false,
      italic: false,
      underline: false,
      align: 'left',
      lineHeight: 1.25,
    };
    commit([...changesRef.current, change]);
    setSelection({ type: 'added', id });
    setInlineEditId(id);
    setMode('select');
  };

  const deleteSelected = useCallback(() => {
    const current = changesRef.current;
    if (!selection) return;
    if (selection.type === 'added') {
      commit(current.filter(change => change.id !== selection.id));
      setSelection(null);
      setInlineEditId(null);
      return;
    }
    const span = textSpans.find(item => item.id === selection.id);
    if (!span) return;
    const existing = current.find(change => change.sourceId === span.id);
    if (existing) {
      commit(current.map(change => change.id === existing.id ? { ...change, deleted: true, text: '' } : change));
    } else {
      commit([...current, { ...makeChangeFromSpan(span), deleted: true, text: '' }]);
    }
    setSelection(null);
    setInlineEditId(null);
  }, [commit, selection, textSpans]);

  const beginDrag = (event: React.PointerEvent, change: TextChange) => {
    if (inlineEditId === change.id) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      id: change.id,
      startX: event.clientX,
      startY: event.clientY,
      originalX: change.pdfX,
      originalY: change.pdfY,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const dragText = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    setChanges(prev => prev.map(change => change.id === drag.id ? { ...change, pdfX: drag.originalX + dx, pdfY: drag.originalY - dy } : change));
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    commit(changesRef.current);
  };

  const beginResize = (event: React.PointerEvent, change: TextChange) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      id: change.id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: Math.max(40, change.width * zoom),
      startSize: change.fontSize,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const resizeText = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    if (!resize) return;
    const ratio = Math.min(6, Math.max(0.25, (resize.startWidth + (event.clientX - resize.startX)) / resize.startWidth));
    setChanges(prev => prev.map(change => change.id === resize.id
      ? { ...change, fontSize: Math.round(Math.min(200, Math.max(6, resize.startSize * ratio)) * 10) / 10 }
      : change));
  };

  const endResize = () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    commit(changesRef.current);
  };

  const downloadEditedPdf = useCallback(async () => {
    const file = pdfFile;
    if (!file) return;
    setIsExporting(true);
    try {
      const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      if (doc.getPageCount() === 0) throw new Error('empty');

      // Pass 1: cover original text areas, so replacement text draws above them.
      const coverFont = await doc.embedFont(StandardFonts.Helvetica);
      for (const change of changes) {
        if (change.type !== 'existing') continue;
        try {
          const page = doc.getPage(change.pageIndex);
          const box = change.originalBox ?? {
            x: change.pdfX,
            y: change.pdfY - change.height * 0.22,
            w: Math.max(change.width, coverFont.widthOfTextAtSize(change.originalText ?? change.text, change.fontSize)),
            h: change.height * 1.22,
          };
          page.drawRectangle({
            x: box.x - 1.5,
            y: box.y - 1,
            width: Math.max(4, box.w + 3),
            height: Math.max(4, box.h + 2),
            color: rgb(1, 1, 1),
          });
        } catch { /* keep exporting the remaining changes */ }
      }

      // Pass 2: draw replacement and added text.
      let failed = 0;
      for (const change of changes) {
        if (change.deleted || !change.text.trim()) continue;
        try {
          const page = doc.getPage(change.pageIndex);
          const font = await fontVariant(doc, change.fontFamily, change.bold, change.italic);
          const size = change.fontSize;
          const boxWidth = Math.max(change.width, 40);
          const logicalLines = sanitizeForPdf(change.text).split('\n');
          const physicalLines = logicalLines.flatMap(line => wrapLine(font, line, size, boxWidth));

          physicalLines.forEach((line, index) => {
            const lineWidth = font.widthOfTextAtSize(line, size);
            let x = change.pdfX;
            if (change.align === 'center') x = change.pdfX + (boxWidth - lineWidth) / 2;
            if (change.align === 'right') x = change.pdfX + boxWidth - lineWidth;
            const y = change.pdfY - index * size * change.lineHeight;
            page.drawText(line, { x, y, size, font, color: hexToRgb(change.color) });
            if (change.underline) {
              page.drawRectangle({
                x,
                y: y - size * 0.16,
                width: lineWidth,
                height: Math.max(0.6, size * 0.07),
                color: hexToRgb(change.color),
              });
            }
          });
        } catch {
          failed += 1;
        }
      }

      const bytes = await doc.save({ useObjectStreams: true });
      const blob = new Blob([bytesToBlobPart(bytes)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBaseName(file.name)}-edited.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 500);
      if (failed > 0) {
        setNotice(`Downloaded, but ${failed} text object${failed > 1 ? 's' : ''} used characters the selected font cannot embed and may be missing. Try Helvetica or a simpler font.`);
      } else {
        setNotice('Downloaded PDF embeds your edits as real, selectable text.');
      }
    } catch {
      setError('Unable to export this PDF. Try a simpler PDF or fewer edits.');
    } finally {
      setIsExporting(false);
    }
  }, [changes, pdfFile]);

  const downloadRef = useRef(downloadEditedPdf);
  downloadRef.current = downloadEditedPdf;

  // Mobile sheet: discard edits made in the bottom sheet unless Done is pressed.
  const revertUncommittedEdits = useCallback(() => {
    setChanges(historyRef.current.stack[historyRef.current.index]);
  }, []);

  const cancelMobileSheet = useCallback(() => {
    revertUncommittedEdits();
    setInlineEditId(null);
  }, [revertUncommittedEdits]);

  const doneMobileSheet = useCallback(() => {
    const committed = historyRef.current.stack[historyRef.current.index];
    if (changesRef.current !== committed) commit(changesRef.current);
    setInlineEditId(null);
  }, [commit]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        redo();
      } else if (mod && key === 's') {
        event.preventDefault();
        void downloadRef.current();
      } else if (!isTyping && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === 'Escape') {
        if (inlineEditId) {
          if (!isDesktop) revertUncommittedEdits();
          setInlineEditId(null);
        } else {
          setSelection(null);
          setMode('select');
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [deleteSelected, inlineEditId, isDesktop, redo, revertUncommittedEdits, undo]);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadPdf(file);
  };

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".pdf,application/pdf"
      className="hidden"
      aria-hidden="true"
      onChange={event => {
        const file = event.target.files?.[0];
        if (file) void loadPdf(file);
        event.target.value = '';
      }}
    />
  );

  const toolButton = (active: boolean) =>
    `flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border p-0 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 lg:h-10 lg:w-10 ${
      active ? 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/60 dark:text-blue-200' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
    }`;

  const renderFloatingToolbar = () => {
    if (!viewport || (!selectedChange && mode !== 'add-text')) return null;
    let left = 16;
    let top = 12;
    if (selectedChange) {
      const screen = changeToScreen(selectedChange, viewport);
      left = screen.left;
      top = screen.top - 48;
    }
    left = Math.max(8, Math.min(left, (viewport.width ?? 612) - 560));
    top = Math.max(8, top);

    const current = selectedChange;
    return (
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="absolute z-20 flex flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1.5"
        style={{ left, top, maxWidth: 'calc(100% - 16px)' }}
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
      >
        {current ? (
          <>
            <select
              value={current.fontFamily}
              onChange={event => applyProperty('fontFamily', event.target.value)}
              aria-label="Font family"
              className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 px-1.5 py-1 text-gray-800 dark:text-gray-100"
            >
              {fontChoices.map(font => <option key={font} value={font}>{font}</option>)}
            </select>
            <input
              type="number"
              min={6}
              max={200}
              value={Math.round(current.fontSize)}
              onChange={event => applyProperty('fontSize', Number(event.target.value) || 12)}
              aria-label="Font size"
              className="w-14 text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 px-1.5 py-1 text-gray-800 dark:text-gray-100"
            />
            <button type="button" onClick={() => applyProperty('bold', !current.bold)} aria-label="Bold" aria-pressed={current.bold} title="Bold" className={`p-1.5 rounded-md border ${current.bold ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'}`}><Bold size={14} /></button>
            <button type="button" onClick={() => applyProperty('italic', !current.italic)} aria-label="Italic" aria-pressed={current.italic} title="Italic" className={`p-1.5 rounded-md border ${current.italic ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'}`}><Italic size={14} /></button>
            <button type="button" onClick={() => applyProperty('underline', !current.underline)} aria-label="Underline" aria-pressed={current.underline} title="Underline" className={`p-1.5 rounded-md border ${current.underline ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'}`}><Underline size={14} /></button>
            <input
              type="color"
              value={current.color}
              onChange={event => applyProperty('color', event.target.value)}
              aria-label="Text color"
              title="Text color"
              className="h-7 w-7 cursor-pointer rounded-md border border-gray-200 dark:border-gray-700 bg-transparent p-0.5"
            />
            <button
              type="button"
              onClick={() => applyProperty('align', current.align === 'left' ? 'center' : current.align === 'center' ? 'right' : 'left')}
              aria-label={`Alignment: ${current.align}`}
              title={`Alignment: ${current.align}`}
              className="p-1.5 rounded-md border border-transparent hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {current.align === 'left' ? <AlignLeft size={14} /> : current.align === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
            </button>
            <button type="button" onClick={deleteSelected} aria-label="Delete selected text" title="Delete selected text" className="p-1.5 rounded-md border border-transparent text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"><Trash2 size={14} /></button>
          </>
        ) : (
          <span className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">Click anywhere on the page to place your text.</span>
        )}
      </div>
    );
  };

  const renderTextLayer = () => {
    if (!viewport) return null;
    return (
      <>
        {textSpans.map(span => {
          const change = changes.find(item => item.sourceId === span.id);
          if (change && !change.deleted) return null; // overlay box replaces the span
          if (change?.deleted) return null; // deleted text is no longer selectable
          const selected = selection?.type === 'existing' && selection.id === span.id;
          return (
            <button
              key={span.id}
              type="button"
              aria-label={`Select text: ${span.text}`}
              title="Click to edit text"
              onClick={event => {
                event.stopPropagation();
                setMode('select');
                startEditingSpan(span);
              }}
              className={`absolute before:absolute before:-inset-2 before:content-[''] text-left border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                selected ? 'bg-blue-500/20 border-blue-500' : 'border-transparent hover:bg-blue-400/10 hover:border-blue-300'
              }`}
              style={{
                left: span.left,
                top: span.top,
                width: span.screenWidth,
                height: span.screenHeight,
                cursor: 'text',
              }}
            >
              <span className="sr-only">{change?.deleted ? 'Deleted text' : span.text}</span>
            </button>
          );
        })}

        {pageChanges.map(change => {
          const screen = changeToScreen(change, viewport);
          const selected = (selection?.type === 'added' && selection.id === change.id) || (selection?.type === 'existing' && selection.id === change.sourceId);
          const editing = inlineEditId === change.id;
          if (change.deleted) {
            const box = change.originalBox;
            return (
              <div
                key={change.id}
                role="presentation"
                aria-label="Deleted text"
                className="absolute"
                style={box
                  ? {
                      left: viewport.convertToViewportPoint(box.x, box.y + box.h)[0],
                      top: viewport.convertToViewportPoint(box.x, box.y + box.h)[1],
                      width: Math.max(4, box.w * viewport.scale),
                      height: Math.max(4, box.h * viewport.scale),
                      backgroundColor: '#ffffff',
                    }
                  : { left: screen.left, top: screen.top, width: screen.width, height: screen.height, backgroundColor: '#ffffff' }}
              />
            );
          }
          return (
            <div
              key={change.id}
              data-change-id={change.id}
              role="button"
              tabIndex={0}
              aria-label={`Editable text: ${change.text || 'empty text box'}`}
              onPointerDown={event => beginDrag(event, change)}
              onPointerMove={editing ? undefined : dragText}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={event => {
                event.stopPropagation();
                setSelection(change.type === 'added' ? { type: 'added', id: change.id } : { type: 'existing', id: change.sourceId ?? change.id });
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !editing) {
                  event.preventDefault();
                  setInlineEditId(change.id);
                }
              }}
              className={`absolute rounded-sm ${selected ? 'ring-2 ring-blue-500' : 'ring-1 ring-blue-300/50'} cursor-move`}
              style={{
                left: screen.left,
                top: screen.top,
                width: Math.max(screen.width, change.width * viewport.scale),
                minHeight: screen.height,
                backgroundColor: '#ffffff',
                padding: '1px 2px',
                touchAction: 'none',
              }}
            >
              {editing && isDesktop ? (
                <div
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Edit text"
                  className="outline-none whitespace-pre-wrap break-words focus:outline-none"
                  style={{
                    color: change.color,
                    fontSize: screen.fontSize,
                    lineHeight: change.lineHeight,
                    fontFamily: change.fontFamily,
                    fontWeight: change.bold ? 700 : 400,
                    fontStyle: change.italic ? 'italic' : 'normal',
                    textAlign: change.align,
                    textDecoration: change.underline ? 'underline' : 'none',
                  }}
                  ref={element => {
                    if (element && document.activeElement !== element) {
                      element.focus();
                      const range = document.createRange();
                      range.selectNodeContents(element);
                      const sel = window.getSelection();
                      sel?.removeAllRanges();
                      sel?.addRange(range);
                    }
                  }}
                  onBlur={event => {
                    // Prefer the draft captured on input: a background-click re-render can
                    // restore the original innerText before blur fires.
                    const draft = inlineEditDraftRef.current;
                    const domText = (event.currentTarget.innerText ?? '').replace(/\u00a0/g, ' ');
                    const nextText = draft && draft.id === change.id ? draft.text : domText;
                    inlineEditDraftRef.current = null;
                    setInlineEditId(null);
                    if (nextText !== change.text) {
                      commit(changesRef.current.map(item => item.id === change.id ? { ...item, text: nextText } : item));
                    }
                  }}
                  onInput={event => {
                    inlineEditDraftRef.current = { id: change.id, text: (event.currentTarget.innerText ?? '').replace(/\u00a0/g, ' ') };
                  }}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      (event.currentTarget as HTMLElement).blur();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      (event.currentTarget as HTMLElement).blur();
                    }
                  }}
                >
                  {change.text}
                </div>
              ) : (
                <span
                  className="block whitespace-pre-wrap break-words"
                  style={{
                    color: change.color,
                    fontSize: screen.fontSize,
                    lineHeight: change.lineHeight,
                    fontFamily: change.fontFamily,
                    fontWeight: change.bold ? 700 : 400,
                    fontStyle: change.italic ? 'italic' : 'normal',
                    textAlign: change.align,
                    textDecoration: change.underline ? 'underline' : 'none',
                  }}
                >
                  {change.text}
                </span>
              )}
              {selected && (
                <span
                  role="presentation"
                  onPointerDown={event => beginResize(event, change)}
                  onPointerMove={resizeText}
                  onPointerUp={endResize}
                  onPointerCancel={endResize}
                  className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-blue-600 shadow"
                  title="Drag to resize text"
                />
              )}
            </div>
          );
        })}
        {renderFloatingToolbar()}
      </>
    );
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950 pt-16">
      {!pdfDoc ? (
        <div className="max-w-4xl mx-auto px-4 py-12">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 mb-8">
            <ArrowLeft size={16} /> Back to all tools
          </Link>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-14 h-14 rounded-2xl gradient-bg flex items-center justify-center">
                <FileText size={26} className="text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Edit PDF</h1>
                <p className="text-gray-500 dark:text-gray-400">Upload your PDF and edit text directly in your browser.</p>
              </div>
            </div>

            <div
              onDrop={handleDrop}
              onDragOver={event => {
                event.preventDefault();
                setIsDraggingFile(true);
              }}
              onDragLeave={() => setIsDraggingFile(false)}
              className={`upload-zone min-h-[260px] ${isDraggingFile ? 'border-blue-500 bg-blue-100 dark:bg-blue-900/40' : ''}`}
            >
              {fileInput}
              <Upload size={32} className="text-blue-600" />
              <div className="text-center">
                <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">Drag and drop a PDF here</p>
                <p className="text-sm text-gray-400">Accepted format: .pdf, up to 60 MB</p>
              </div>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-primary">
                Choose PDF
              </button>
            </div>

            {isLoading && <p className="mt-4 text-sm text-blue-600 flex items-center gap-2" role="status"><Loader2 size={16} className="animate-spin" /> Loading PDF...</p>}
            {error && <p className="mt-4 text-sm text-red-600" role="alert">{error}</p>}
            <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">Your PDF stays in your browser and is not uploaded to our server.</p>
          </div>
        </div>
      ) : (
        <div className="h-[calc(100vh-4rem)] flex flex-col">
          <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-3 lg:px-5 py-2.5 flex flex-nowrap lg:flex-wrap items-center gap-2 overflow-x-auto lg:overflow-x-visible">
            <Link to="/" className="font-bold gradient-text mr-1 shrink-0">My PDF Desk</Link>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary text-xs py-2 px-3 shrink-0" title="Open a different PDF">
              <Upload size={15} /> Open PDF
            </button>
            {fileInput}
            <button type="button" onClick={undo} disabled={!historyMeta.canUndo} className={`${toolButton(false)} disabled:opacity-40`} title="Undo (Ctrl + Z)" aria-label="Undo">
              <Undo2 size={17} />
            </button>
            <button type="button" onClick={redo} disabled={!historyMeta.canRedo} className={`${toolButton(false)} disabled:opacity-40`} title="Redo (Ctrl + Y)" aria-label="Redo">
              <Redo2 size={17} />
            </button>
            <button type="button" onClick={() => setMode(mode === 'add-text' ? 'select' : 'add-text')} className={toolButton(mode === 'add-text')} title="Add Text — then click the page" aria-label="Add text" aria-pressed={mode === 'add-text'}>
              <Type size={17} />
            </button>
            <button type="button" onClick={() => setMode('select')} className={toolButton(mode === 'select')} title="Edit / select mode" aria-label="Select or edit" aria-pressed={mode === 'select'}>
              <MousePointer2 size={17} />
            </button>
            <button type="button" onClick={deleteSelected} disabled={!selection} className={`${toolButton(false)} disabled:opacity-40`} title="Delete selected text" aria-label="Delete selected object">
              <Trash2 size={17} />
            </button>
            <span className="mx-1 h-6 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
            <button type="button" onClick={() => changeZoom(-1)} className={toolButton(false)} title="Zoom out" aria-label="Zoom out">
              <Minus size={17} />
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-300 min-w-12 shrink-0 text-center" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => changeZoom(1)} className={toolButton(false)} title="Zoom in" aria-label="Zoom in">
              <Plus size={17} />
            </button>
            <button type="button" onClick={() => fitTo('width')} className={toolButton(false)} title="Fit to width" aria-label="Fit to width">
              <Maximize2 size={17} />
            </button>
            <button type="button" onClick={() => fitTo('page')} className={toolButton(false)} title="Fit to page" aria-label="Fit to page">
              <Expand size={17} />
            </button>
            <button type="button" onClick={() => void downloadEditedPdf()} disabled={isExporting} className="btn-primary text-xs py-2 px-3 ml-auto shrink-0 disabled:opacity-60" title="Download PDF (Ctrl + S)">
              {isExporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download PDF
            </button>
          </div>

          <div className="flex-1 grid grid-cols-1 lg:grid-cols-[92px_minmax(0,1fr)_280px] overflow-hidden">
            <aside className="hidden lg:flex bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 overflow-y-auto p-2.5" aria-label="Page thumbnails">
              <div className="space-y-2 w-full">
                {Array.from({ length: pageCount }, (_, index) => (
                  <PageThumbnail
                    key={index}
                    pdfDoc={pdfDoc}
                    pageNumber={index + 1}
                    active={currentPage === index + 1}
                    onSelect={() => setCurrentPage(index + 1)}
                  />
                ))}
              </div>
            </aside>

            <section
              ref={scrollRef}
              className="overflow-auto overscroll-contain bg-gray-100 dark:bg-gray-950 pb-16 lg:pb-0"
              onPointerDown={handleSectionPointerDown}
              onPointerMove={handleSectionPointerMove}
              onPointerUp={handleSectionPointerUp}
              onPointerCancel={handleSectionPointerUp}
            >
              <div className="sticky top-0 z-10 bg-gray-100/95 dark:bg-gray-950/95 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button type="button" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-40">Previous</button>
                  <span className="text-sm text-gray-700 dark:text-gray-300">Page {currentPage} of {pageCount}</span>
                  <button type="button" disabled={currentPage >= pageCount} onClick={() => setCurrentPage(p => Math.min(pageCount, p + 1))} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-40">Next</button>
                </div>
                <label className="text-sm text-gray-500 dark:text-gray-400">
                  Jump to{' '}
                  <input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={currentPage}
                    onChange={event => setCurrentPage(Math.max(1, Math.min(pageCount, Number(event.target.value) || 1)))}
                    className="w-16 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  />
                </label>
              </div>

              <div className="p-4 pb-6 lg:p-8 flex justify-center">
                <div
                  ref={pageWrapRef}
                  onClick={addTextAt}
                  className={`relative bg-white shadow-xl ${mode === 'add-text' ? 'cursor-text' : 'cursor-default'}`}
                  style={{ width: viewport?.width ?? 612, height: viewport?.height ?? 792 }}
                >
                  <canvas ref={canvasRef} className="block" aria-label={`PDF page ${currentPage} preview`} />
                  <div className="absolute inset-0">
                    {renderTextLayer()}
                  </div>
                </div>
              </div>
            </section>

            <aside className="bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 overflow-y-auto p-5" aria-label="Text properties">
              <h2 className="font-bold text-gray-900 dark:text-white mb-2">Text Properties</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4" role="status">{notice}</p>
              {!hasText && (
                <p className="text-sm text-amber-600 dark:text-amber-300 mb-4" role="alert">
                  This page appears to be scanned. Existing text cannot be directly edited. You can use Add Text to place new text on the page.
                </p>
              )}
              {error && <p className="text-sm text-red-600 mb-4" role="alert">{error}</p>}
              {selectedEditable ? (
                <div className="space-y-4">
                  <label className="block">
                    <span className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Text</span>
                    <textarea
                      value={selectedEditable.text}
                      onChange={event => {
                        const value = event.target.value;
                        setChanges(prev => prev.some(item => item.id === selectedEditable.id)
                          ? prev.map(item => item.id === selectedEditable.id ? { ...item, text: value } : item)
                          : [...prev, { ...selectedEditable, text: value }]);
                      }}
                      onBlur={() => commit(changesRef.current)}
                      rows={3}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Font</span>
                    <select value={selectedEditable.fontFamily} onChange={event => applyProperty('fontFamily', event.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white text-sm">
                      {fontChoices.map(font => <option key={font} value={font}>{font}</option>)}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Size</span>
                      <input type="number" min={6} max={200} value={Math.round(selectedEditable.fontSize)} onChange={event => applyProperty('fontSize', Number(event.target.value) || 12)} className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white text-sm" />
                    </label>
                    <label className="block">
                      <span className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Color</span>
                      <input type="color" value={selectedEditable.color} onChange={event => applyProperty('color', event.target.value)} className="w-full h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950" />
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => applyProperty('bold', !selectedEditable.bold)} aria-pressed={selectedEditable.bold} className={`p-2 rounded-lg border ${selectedEditable.bold ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-gray-200 dark:border-gray-700'}`} title="Bold"><Bold size={16} /></button>
                    <button type="button" onClick={() => applyProperty('italic', !selectedEditable.italic)} aria-pressed={selectedEditable.italic} className={`p-2 rounded-lg border ${selectedEditable.italic ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-gray-200 dark:border-gray-700'}`} title="Italic"><Italic size={16} /></button>
                    <button type="button" onClick={() => applyProperty('underline', !selectedEditable.underline)} aria-pressed={selectedEditable.underline} className={`p-2 rounded-lg border ${selectedEditable.underline ? 'bg-blue-100 text-blue-700 border-blue-300' : 'border-gray-200 dark:border-gray-700'}`} title="Underline"><Underline size={16} /></button>
                    <button type="button" onClick={deleteSelected} className="p-2 rounded-lg border border-red-200 text-red-600" title="Delete selected text"><Trash2 size={16} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <div>X: {Math.round(selectedEditable.pdfX)} pt</div>
                    <div>Y: {Math.round(selectedEditable.pdfY)} pt</div>
                    <div>W: {Math.round(selectedEditable.width)} pt</div>
                    <div>H: {Math.round(selectedEditable.fontSize)} pt</div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-4 text-sm text-gray-500 dark:text-gray-400">
                  Click text on the PDF to edit it, or use Add Text to create a movable text object. Drag the blue dot to resize.
                </div>
              )}
              <div className="mt-6 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900 p-4 text-sm text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
                <Check size={16} className="mt-0.5 flex-shrink-0" />
                <span>Downloaded PDFs keep all original pages, images, and content — your edits are embedded as real PDF text.</span>
              </div>
              <div className="mt-3 flex items-start gap-2 text-xs text-gray-400">
                <X size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>Shortcuts: Ctrl+Z undo · Ctrl+Y redo · Ctrl+S download · Del removes selection · Esc exits mode</span>
              </div>
            </aside>
          </div>

          {/* Mobile: fixed page navigation that never covers the PDF */}
          <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 flex items-center justify-center gap-4 border-t border-gray-200 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 px-4 py-1.5 backdrop-blur" aria-label="Page navigation">
            <button type="button" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} aria-label="Previous page" className="flex h-10 min-w-[44px] items-center justify-center rounded-lg border border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40">
              <ChevronLeft size={20} />
            </button>
            <span className="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-300" aria-live="polite">{currentPage} / {pageCount}</span>
            <button type="button" disabled={currentPage >= pageCount} onClick={() => setCurrentPage(p => Math.min(pageCount, p + 1))} aria-label="Next page" className="flex h-10 min-w-[44px] items-center justify-center rounded-lg border border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300 disabled:opacity-40">
              <ChevronRight size={20} />
            </button>
          </nav>

          {/* Mobile: bottom sheet for comfortable text editing above the keyboard */}
          {showMobileSheet && selectedEditable && (
            <div
              className="lg:hidden fixed inset-x-2 z-40 rounded-2xl border border-gray-200 bg-white p-3 shadow-2xl dark:border-gray-700 dark:bg-gray-900"
              style={{ bottom: `calc(3.25rem + ${keyboardInset}px)` }}
              onPointerDown={event => event.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Edit text</span>
                <div className="flex gap-2">
                  <button type="button" onClick={cancelMobileSheet} className="btn-secondary text-xs py-2 px-3">Cancel</button>
                  <button type="button" onClick={doneMobileSheet} className="btn-primary text-xs py-2 px-4">Done</button>
                </div>
              </div>
              <textarea
                autoFocus
                rows={3}
                value={selectedEditable.text}
                onChange={event => {
                  const value = event.target.value;
                  setChanges(prev => prev.some(item => item.id === selectedEditable.id)
                    ? prev.map(item => item.id === selectedEditable.id ? { ...item, text: value } : item)
                    : [...prev, { ...selectedEditable, text: value }]);
                }}
                className="w-full min-h-[96px] rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-base text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
