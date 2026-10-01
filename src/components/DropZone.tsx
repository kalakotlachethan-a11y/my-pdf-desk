import { useCallback, useRef, useState } from 'react';
import { Upload, ShieldCheck } from 'lucide-react';

interface DropZoneProps {
  /** Comma-separated accept string, e.g. ".pdf" or ".docx". */
  accept: string;
  /** Human label for the accepted formats, e.g. "PDF". */
  acceptLabel: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onRejected: (files: File[]) => void;
}

/** Classifies picked/dropped files against the accept list. */
export function classifyFiles(files: File[], accept: string): { ok: File[]; bad: File[] } {
  const allowed = accept.split(',').map(ext => ext.trim().toLowerCase());
  const ok: File[] = [];
  const bad: File[] = [];
  for (const file of files) {
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (allowed.includes(ext) || allowed.includes(file.type)) ok.push(file);
    else bad.push(file);
  }
  return { ok, bad };
}

export default function DropZone({ accept, acceptLabel, multiple = true, onFiles, onRejected }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);

  const classify = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    const { ok, bad } = classifyFiles(Array.from(list), accept);
    if (ok.length) onFiles(ok);
    if (bad.length) onRejected(bad);
  }, [accept, onFiles, onRejected]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Upload ${acceptLabel} files. Press Enter to browse your device, or drop files here.`}
      onClick={() => inputRef.current?.click()}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={e => { e.preventDefault(); setIsOver(true); }}
      onDragLeave={() => setIsOver(false)}
      onDrop={e => { e.preventDefault(); setIsOver(false); classify(e.dataTransfer.files); }}
      className={`group relative flex min-h-[320px] cursor-pointer flex-col items-center justify-center gap-5 rounded-3xl border-2 border-dashed px-6 py-14 text-center outline-none transition-all duration-300
        focus-visible:ring-4 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900
        ${isOver
          ? 'border-blue-500 bg-blue-50/90 dark:bg-blue-950/40 scale-[1.02] shadow-2xl shadow-blue-200/60 dark:shadow-blue-900/40'
          : 'border-blue-300 dark:border-blue-800 bg-gradient-to-b from-blue-50/70 to-violet-50/50 dark:from-gray-800/60 dark:to-gray-800/30 hover:border-blue-400 hover:shadow-xl hover:shadow-blue-100/60 dark:hover:shadow-blue-900/20'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={e => { classify(e.target.files); e.target.value = ''; }}
      />
      <div className={`flex h-20 w-20 items-center justify-center rounded-2xl transition-all duration-300 ${isOver ? 'gradient-bg scale-110 rotate-3' : 'bg-blue-600/10 group-hover:scale-105'}`}>
        <Upload size={34} className={`transition-colors ${isOver ? 'text-white' : 'text-blue-600'}`} />
      </div>
      <div>
        <p className={`text-xl font-bold transition-colors ${isOver ? 'text-blue-600 dark:text-blue-300' : 'text-gray-900 dark:text-white'}`}>
          {isOver ? 'Drop your files here' : `Select ${acceptLabel} files`}
        </p>
        <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">or drop them here — everything stays on your device</p>
      </div>
      <span className="inline-flex items-center gap-2 rounded-full bg-white dark:bg-gray-800 px-4 py-2 text-sm font-semibold text-blue-600 dark:text-blue-300 shadow-sm ring-1 ring-blue-200 dark:ring-blue-800 group-hover:bg-blue-600 group-hover:text-white dark:group-hover:bg-blue-600 transition-colors">
        <Upload size={15} /> Choose files
      </span>
      <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
        <ShieldCheck size={13} className="text-emerald-500" />
        Files are processed locally in your browser and never uploaded
      </div>
    </div>
  );
}
