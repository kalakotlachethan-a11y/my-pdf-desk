import { LucideIcon } from 'lucide-react';
import {
  Image, FileType, FileText, FileSpreadsheet, Presentation,
  Scissors, GitMerge, RotateCw, Trash2, FileMinus, FileOutput,
  Archive, Shield, Lock, Unlock, Stamp, PenTool, ScanLine,
  FileSearch, Hash, AlignLeft, Layers, Zap, Type, ImagePlus,
  ShieldCheck, KeyRound,
} from 'lucide-react';

export interface Tool {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  category: string;
  popular?: boolean;
  new?: boolean;
}

export const tools: Tool[] = [
  // Conversion
  { id: 'pdf-to-jpg', label: 'PDF to JPG', description: 'Convert PDF pages to high-quality JPG images', icon: Image, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-950/40', category: 'Convert', popular: true },
  { id: 'jpg-to-pdf', label: 'JPG to PDF', description: 'Turn your JPG images into a PDF document', icon: FileType, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-950/40', category: 'Convert' },
  { id: 'pdf-to-png', label: 'PDF to PNG', description: 'Convert each PDF page into a PNG image', icon: Image, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-950/40', category: 'Convert' },
  { id: 'png-to-pdf', label: 'PNG to PDF', description: 'Convert PNG images to a PDF document', icon: FileType, color: 'text-cyan-600', bgColor: 'bg-cyan-100 dark:bg-cyan-950/40', category: 'Convert' },
  { id: 'pdf-to-word', label: 'PDF to Word', description: 'Convert your PDF to editable Word document', icon: FileText, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-950/40', category: 'Convert', popular: true },
  { id: 'word-to-pdf', label: 'Word to PDF', description: 'Convert Word documents to PDF with ease', icon: FileType, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-950/40', category: 'Convert' },
  { id: 'pdf-to-excel', label: 'PDF to Excel', description: 'Extract tables from PDF to Excel spreadsheet', icon: FileSpreadsheet, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-950/40', category: 'Convert' },
  { id: 'excel-to-pdf', label: 'Excel to PDF', description: 'Convert Excel spreadsheets to PDF', icon: FileType, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-950/40', category: 'Convert' },
  { id: 'pdf-to-powerpoint', label: 'PDF to PowerPoint', description: 'Convert PDF presentations to editable PPTX', icon: Presentation, color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-950/40', category: 'Convert' },
  { id: 'powerpoint-to-pdf', label: 'PowerPoint to PDF', description: 'Convert presentations to PDF format', icon: FileType, color: 'text-red-600', bgColor: 'bg-red-100 dark:bg-red-950/40', category: 'Convert' },

  // Editing
  { id: 'pdf-editor', label: 'PDF Editor', description: 'Edit text, images, and content directly in your PDF', icon: AlignLeft, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-950/40', category: 'Edit', popular: true },
  { id: 'add-text', label: 'Add Text to PDF', description: 'Insert text boxes, labels, and annotations', icon: Type, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-950/40', category: 'Edit' },
  { id: 'add-images', label: 'Add Images to PDF', description: 'Insert images into any page of your PDF', icon: ImagePlus, color: 'text-violet-600', bgColor: 'bg-violet-100 dark:bg-violet-950/40', category: 'Edit' },
  { id: 'rearrange-pages', label: 'Rearrange Pages', description: 'Drag and drop to reorder PDF pages', icon: Layers, color: 'text-indigo-600', bgColor: 'bg-indigo-100 dark:bg-indigo-950/40', category: 'Edit' },
  { id: 'rotate-pdf', label: 'Rotate PDF Pages', description: 'Rotate one or all pages to any angle', icon: RotateCw, color: 'text-indigo-600', bgColor: 'bg-indigo-100 dark:bg-indigo-950/40', category: 'Edit' },
  { id: 'delete-pages', label: 'Delete Pages', description: 'Remove unwanted pages from your PDF', icon: Trash2, color: 'text-pink-600', bgColor: 'bg-pink-100 dark:bg-pink-950/40', category: 'Edit' },
  { id: 'extract-pages', label: 'Extract Pages', description: 'Extract specific pages into a new PDF', icon: FileOutput, color: 'text-pink-600', bgColor: 'bg-pink-100 dark:bg-pink-950/40', category: 'Edit' },

  // Compression
  { id: 'compress-pdf', label: 'Compress PDF', description: 'Reduce PDF file size while keeping quality', icon: Archive, color: 'text-yellow-600', bgColor: 'bg-yellow-100 dark:bg-yellow-950/40', category: 'Compress', popular: true },
  { id: 'image-compressor', label: 'Image Compressor', description: 'Compress images without losing quality', icon: FileMinus, color: 'text-yellow-600', bgColor: 'bg-yellow-100 dark:bg-yellow-950/40', category: 'Compress' },
  { id: 'batch-compress', label: 'Batch Compress', description: 'Compress multiple PDFs at once', icon: Zap, color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-950/40', category: 'Compress', new: true },

  // Security
  { id: 'protect-pdf', label: 'Protect PDF', description: 'Add password protection with AES-256 encryption', icon: Shield, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-950/40', category: 'Security', popular: true },
  { id: 'unlock-pdf', label: 'Unlock PDF', description: 'Remove password protection from your PDF', icon: Unlock, color: 'text-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-950/40', category: 'Security' },
  { id: 'encrypt-pdf', label: 'Encrypt PDF', description: 'Apply advanced encryption to your PDF', icon: Lock, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-950/40', category: 'Security' },
  { id: 'watermark-pdf', label: 'Watermark PDF', description: 'Add text or image watermarks to your PDF', icon: Stamp, color: 'text-teal-600', bgColor: 'bg-teal-100 dark:bg-teal-950/40', category: 'Security' },

  // Organization
  { id: 'merge-pdfs', label: 'Merge PDFs', description: 'Combine multiple PDFs into one document', icon: GitMerge, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-950/40', category: 'Organize', popular: true },
  { id: 'split-pdf', label: 'Split PDF', description: 'Split your PDF into multiple separate files', icon: Scissors, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-950/40', category: 'Organize' },
  { id: 'page-numbering', label: 'Page Numbering', description: 'Add automatic page numbers to your PDF', icon: Hash, color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800', category: 'Organize' },
  { id: 'pdf-scanner', label: 'PDF Scanner', description: 'Scan documents and save as PDF', icon: ScanLine, color: 'text-slate-600', bgColor: 'bg-slate-100 dark:bg-slate-800', category: 'Organize', new: true },
  { id: 'ocr-pdf', label: 'OCR PDF', description: 'Extract text from scanned PDFs with OCR', icon: FileSearch, color: 'text-purple-600', bgColor: 'bg-purple-100 dark:bg-purple-950/40', category: 'Organize' },

  // Signature
  { id: 'esign-pdf', label: 'e-Sign PDF', description: 'Sign PDFs electronically with your signature', icon: PenTool, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-950/40', category: 'Sign', popular: true },
  { id: 'draw-signature', label: 'Draw Signature', description: 'Draw your signature with mouse or touch', icon: PenTool, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-950/40', category: 'Sign' },
  { id: 'upload-signature', label: 'Upload Signature', description: 'Upload your signature image to PDFs', icon: ImagePlus, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-950/40', category: 'Sign' },
  { id: 'verify-signature', label: 'Verify Signature', description: 'Verify digital signature authenticity', icon: ShieldCheck, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-950/40', category: 'Sign', new: true },
  { id: 'digital-signature', label: 'Digital Signature', description: 'Create a certified digital signature', icon: KeyRound, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-950/40', category: 'Sign' },
];

export const categories = ['All', 'Convert', 'Edit', 'Compress', 'Security', 'Organize', 'Sign'];

export const getToolBySlug = (slug: string) => tools.find(t => t.id === slug);
