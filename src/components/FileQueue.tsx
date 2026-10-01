import { useRef, useState } from 'react';
import { Plus, Trash2, GripVertical, FileText, FileSpreadsheet, FileImage, FileType2, File as FileIcon, Loader2, CheckCircle } from 'lucide-react';

export interface QueueFile {
  id: string;
  file: File;
  preview?: string;
}

interface FileQueueProps {
  files: QueueFile[];
  accept: string;
  busy: boolean;
  done: boolean;
  onAdd: (files: File[]) => void;
  onRejected: (files: File[]) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}

function ExtensionIcon({ name }: { name: string }) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const cls = 'h-6 w-6';
  if (ext === 'pdf') return <FileText className={`${cls} text-red-500`} />;
  if (['doc', 'docx', 'rtf', 'odt', 'txt'].includes(ext)) return <FileType2 className={`${cls} text-blue-600`} />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return <FileSpreadsheet className={`${cls} text-emerald-600`} />;
  if (['ppt', 'pptx'].includes(ext)) return <FileText className={`${cls} text-orange-500`} />;
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) return <FileImage className={`${cls} text-violet-500`} />;
  return <FileIcon className={cls} />;
}

export default function FileQueue({ files, accept, busy, done, onAdd, onRejected, onRemove, onReorder }: FileQueueProps) {
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const classify = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const allowed = accept.split(',').map(ext => ext.trim().toLowerCase());
    const ok: File[] = [];
    const bad: File[] = [];
    for (const file of Array.from(list)) {
      const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
      if (allowed.includes(ext) || allowed.includes(file.type)) ok.push(file);
      else bad.push(file);
    }
    if (ok.length) onAdd(ok);
    if (bad.length) onRejected(bad);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {files.length} file{files.length === 1 ? '' : 's'} in queue
        </h3>
        <span className="hidden text-xs text-gray-400 sm:block">Drag cards to reorder</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" role="list" aria-label="Files queued for processing">
        {files.map(({ id, file, preview }, index) => (
          <div
            key={id}
            role="listitem"
            draggable={!busy && !done}
            aria-grabbed={overIndex === index}
            onDragStart={e => { dragIndex.current = index; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { e.preventDefault(); setOverIndex(index); }}
            onDragLeave={() => setOverIndex(null)}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              const from = dragIndex.current;
              setOverIndex(null);
              dragIndex.current = null;
              if (from !== null && from !== index) onReorder(from, index);
            }}
            onDragEnd={() => { setOverIndex(null); dragIndex.current = null; }}
            className={`group relative flex items-center gap-3 rounded-2xl border p-3 transition-all
              ${overIndex === index && dragIndex.current !== null
                ? 'border-blue-400 bg-blue-50/80 dark:bg-blue-950/40 ring-2 ring-blue-300 dark:ring-blue-700'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-300 hover:shadow-md'}
              ${busy || done ? 'opacity-90' : 'cursor-grab active:cursor-grabbing'}`}
          >
            {!busy && !done && (
              <span aria-hidden className="flex h-8 w-5 flex-shrink-0 cursor-grab items-center justify-center text-gray-300 group-hover:text-gray-400">
                <GripVertical size={16} />
              </span>
            )}
            {preview ? (
              <img src={preview} alt="" className="h-12 w-12 flex-shrink-0 rounded-xl object-cover ring-1 ring-gray-200 dark:ring-gray-700" />
            ) : (
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gray-50 dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-700">
                <ExtensionIcon name={file.name} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-white" title={file.name}>{file.name}</p>
              <p className="mt-0.5 text-xs text-gray-400">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
            {busy && <Loader2 size={17} className="flex-shrink-0 animate-spin text-blue-500" />}
            {done && <CheckCircle size={17} className="flex-shrink-0 text-emerald-500" />}
            {!busy && !done && (
              <button
                type="button"
                aria-label={`Remove ${file.name} from queue`}
                onClick={() => onRemove(id)}
                className="flex-shrink-0 rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}

        {!done && (
          <>
            <button
              type="button"
              onClick={() => addInputRef.current?.click()}
              disabled={busy}
              className="flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-gray-300 dark:border-gray-600 p-3 text-gray-400 transition-all hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-600 dark:hover:bg-blue-950/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={20} />
              <span className="text-xs font-medium">Add more files</span>
            </button>
            <input ref={addInputRef} type="file" accept={accept} multiple className="hidden" onChange={e => { classify(e.target.files); e.target.value = ''; }} />
          </>
        )}
      </div>
    </div>
  );
}
