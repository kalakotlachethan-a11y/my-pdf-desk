import { ShieldCheck, Download, RefreshCw, X } from 'lucide-react';
import type { ProcessedResult } from '../lib/fileTools';
import { formatBytes } from './formatBytes';

interface ProcessingOverlayProps {
  active: boolean;
  progress: number;
  statusText: string;
  toolLabel: string;
  result: ProcessedResult | null;
  /** Downloads all result files, then purges URL + queue state. */
  onDownloadAndReset: () => void;
  onResetOnly: () => void;
}

/**
 * State C: full-canvas processing dashboard. An animated SVG circular
 * progress indicator tracks the run; when finished it resolves into a
 * completion card whose Download button triggers the native download and
 * then purges all temporary memory (object URLs + file arrays).
 */
export default function ProcessingOverlay({ active, progress, statusText, toolLabel, result, onDownloadAndReset, onResetOnly }: ProcessingOverlayProps) {
  if (!active) return null;

  const pct = Math.min(100, Math.max(0, Math.round(progress)));
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/95 dark:bg-gray-900/95 px-4"
      role="status"
      aria-live="polite"
      aria-label={result ? 'Processing complete' : 'Processing files'}
    >
      {result ? (
        <div className="w-full max-w-md rounded-3xl border border-emerald-200 dark:border-emerald-900 bg-white dark:bg-gray-800 p-8 text-center shadow-2xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/50">
            <ShieldCheck size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Done!</h2>
          <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">{result.message}</p>

          <div className="mt-6 grid grid-cols-2 gap-3 text-left">
            <div className="rounded-xl bg-gray-50 dark:bg-gray-900 p-3">
              <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(result.originalSize)}</div>
              <div className="text-xs text-gray-400">Original</div>
            </div>
            <div className="rounded-xl bg-gray-50 dark:bg-gray-900 p-3">
              <div className="text-lg font-bold text-emerald-600">{formatBytes(result.newSize)}</div>
              <div className="text-xs text-gray-400">Output · {result.files.length} file{result.files.length === 1 ? '' : 's'}</div>
            </div>
          </div>

          <button
            onClick={onDownloadAndReset}
            className="btn-primary mt-6 w-full justify-center py-3.5 text-base"
            autoFocus
          >
            <Download size={18} /> Download{result.files.length > 1 ? ' all' : ''}
          </button>
          <button onClick={onResetOnly} className="btn-secondary mt-3 w-full justify-center py-2.5">
            <RefreshCw size={15} /> Start over
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="relative h-40 w-40">
            <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
              <circle cx="64" cy="64" r={radius} fill="none" strokeWidth="9" className="stroke-blue-100 dark:stroke-blue-950" />
              <circle
                cx="64" cy="64" r={radius} fill="none" strokeWidth="9" strokeLinecap="round"
                className="stroke-blue-600 transition-[stroke-dashoffset] duration-200 ease-out"
                strokeDasharray={circumference}
                strokeDashoffset={circumference - dash}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-extrabold text-gray-900 dark:text-white">{pct}%</span>
            </div>
            <span className="absolute -inset-3 animate-ping rounded-full border-2 border-blue-300/50 dark:border-blue-700/40" aria-hidden />
          </div>
          <p className="mt-8 text-lg font-semibold text-gray-900 dark:text-white">{toolLabel}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{statusText}</p>
          <p className="mt-6 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
            <ShieldCheck size={13} className="text-emerald-500" /> Running locally on your device — nothing leaves your browser
          </p>
          <button
            onClick={onResetOnly}
            aria-label="Cancel processing"
            className="mt-4 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-500 dark:hover:bg-gray-800"
          >
            <X size={13} /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}
