import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FileText, Menu, X, Sun, Moon, ChevronDown } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

const toolsMenu = [
  { label: 'Convert', items: [
    { label: 'PDF to JPG', href: '/tools/pdf-to-jpg' },
    { label: 'JPG to PDF', href: '/tools/jpg-to-pdf' },
    { label: 'PDF to Word', href: '/tools/pdf-to-word' },
    { label: 'Word to PDF', href: '/tools/word-to-pdf' },
    { label: 'PDF to Excel', href: '/tools/pdf-to-excel' },
    { label: 'PDF to PNG', href: '/tools/pdf-to-png' },
  ]},
  { label: 'Edit', items: [
    { label: 'PDF Editor', href: '/tools/pdf-editor' },
    { label: 'Merge PDFs', href: '/tools/merge-pdfs' },
    { label: 'Split PDF', href: '/tools/split-pdf' },
    { label: 'Rotate PDF', href: '/tools/rotate-pdf' },
    { label: 'Delete Pages', href: '/tools/delete-pages' },
  ]},
  { label: 'Optimize', items: [
    { label: 'Compress PDF', href: '/tools/compress-pdf' },
    { label: 'OCR PDF', href: '/tools/ocr-pdf' },
    { label: 'PDF Scanner', href: '/tools/pdf-scanner' },
  ]},
  { label: 'Secure', items: [
    { label: 'Protect PDF', href: '/tools/protect-pdf' },
    { label: 'Unlock PDF', href: '/tools/unlock-pdf' },
    { label: 'Watermark PDF', href: '/tools/watermark-pdf' },
    { label: 'e-Sign PDF', href: '/tools/esign-pdf' },
  ]},
];

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setOpenDropdown(null);
  }, [location]);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled
        ? 'bg-white/95 dark:bg-gray-900/95 backdrop-blur-md shadow-lg border-b border-gray-100 dark:border-gray-800'
        : 'bg-transparent'
    }`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl gradient-bg flex items-center justify-center shadow-md">
              <FileText size={18} className="text-white" />
            </div>
            <span className="text-xl font-bold gradient-text">My PDF Desk</span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {toolsMenu.map(cat => (
              <div key={cat.label} className="relative">
                <button
                  onMouseEnter={() => setOpenDropdown(cat.label)}
                  onMouseLeave={() => setOpenDropdown(null)}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-all"
                >
                  {cat.label}
                  <ChevronDown size={14} className={`transition-transform ${openDropdown === cat.label ? 'rotate-180' : ''}`} />
                </button>
                {openDropdown === cat.label && (
                  <div
                    onMouseEnter={() => setOpenDropdown(cat.label)}
                    onMouseLeave={() => setOpenDropdown(null)}
                    className="absolute top-full left-0 pt-1 z-50"
                  >
                    <div className="w-48 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-100 dark:border-gray-700 py-2">
                      {cat.items.map(item => (
                        <Link
                          key={item.href}
                          to={item.href}
                          className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <Link to="/about" className="px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-all">
              About
            </Link>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <Link to="/dashboard" className="btn-secondary text-sm py-2 px-4">
              Dashboard
            </Link>
          </div>

          <div className="flex md:hidden items-center gap-2">
            <button onClick={toggleTheme} className="p-2 rounded-lg text-gray-600 dark:text-gray-400">
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              onClick={() => setMobileOpen(o => !o)}
              className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              {mobileOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800 shadow-xl">
          <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-1">
            {toolsMenu.map(cat => (
              <div key={cat.label}>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 py-2 mt-2">{cat.label}</div>
                {cat.items.map(item => (
                  <Link
                    key={item.href}
                    to={item.href}
                    className="block px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
            <div className="border-t border-gray-100 dark:border-gray-800 mt-3 pt-3 flex flex-col gap-2">
              <Link to="/about" className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300">About</Link>
              <Link to="/dashboard" className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300">Dashboard</Link>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
