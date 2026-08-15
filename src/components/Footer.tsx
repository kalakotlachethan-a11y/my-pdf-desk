import { Link } from 'react-router-dom';
import { FileText, Github, Mail, Heart } from 'lucide-react';

const footerLinks = {
  Tools: [
    { label: 'Compress PDF', href: '/tools/compress-pdf' },
    { label: 'Merge PDFs', href: '/tools/merge-pdfs' },
    { label: 'Split PDF', href: '/tools/split-pdf' },
    { label: 'PDF to Word', href: '/tools/pdf-to-word' },
    { label: 'PDF Editor', href: '/tools/pdf-editor' },
    { label: 'e-Sign PDF', href: '/tools/esign-pdf' },
  ],
  Convert: [
    { label: 'PDF to JPG', href: '/tools/pdf-to-jpg' },
    { label: 'JPG to PDF', href: '/tools/jpg-to-pdf' },
    { label: 'Word to PDF', href: '/tools/word-to-pdf' },
    { label: 'Excel to PDF', href: '/tools/excel-to-pdf' },
    { label: 'PDF to Excel', href: '/tools/pdf-to-excel' },
    { label: 'PDF to PNG', href: '/tools/pdf-to-png' },
  ],
  Workspace: [
    { label: 'Dashboard', href: '/dashboard' },
    { label: 'About', href: '/about' },
    { label: 'Contact', href: '/contact' },
    { label: 'Privacy Notes', href: '/privacy' },
    { label: 'Usage Notes', href: '/terms' },
  ],
};

export default function Footer() {
  return (
    <footer className="bg-gray-900 dark:bg-gray-950 text-gray-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-12">
          <div className="col-span-2">
            <Link to="/" className="flex items-center gap-2 mb-4">
              <div className="w-9 h-9 rounded-xl gradient-bg flex items-center justify-center">
                <FileText size={18} className="text-white" />
              </div>
              <span className="text-xl font-bold text-white">My PDF Desk</span>
            </Link>
            <p className="text-sm leading-relaxed mb-6 max-w-xs">
              A personal PDF workspace for everyday document tasks: compress, convert, edit, protect, and sign files from one tidy place.
            </p>
            <div className="flex items-center gap-3">
              {[Github, Mail].map((Icon, i) => (
                <a
                  key={i}
                  href="#"
                  className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-blue-600 flex items-center justify-center transition-colors duration-200"
                  aria-label={Icon === Github ? 'GitHub' : 'Email'}
                >
                  <Icon size={16} className="text-gray-400 hover:text-white" />
                </a>
              ))}
            </div>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h3 className="text-white font-semibold text-sm mb-4">{title}</h3>
              <ul className="space-y-2">
                {links.map(link => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className="text-sm hover:text-blue-400 transition-colors duration-150"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-800 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm">(c) {new Date().getFullYear()} My PDF Desk.</p>
          <p className="text-sm flex items-center gap-1">
            Built with <Heart size={14} className="text-red-400 fill-current" /> for cleaner document work
          </p>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/privacy" className="hover:text-blue-400 transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-blue-400 transition-colors">Usage</Link>
            <Link to="/contact" className="hover:text-blue-400 transition-colors">Contact</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
