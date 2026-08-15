import { FileText } from 'lucide-react';

const sections = [
  { title: '1. Personal Project', content: 'My PDF Desk is a personal PDF tools project. It is not presented as a commercial SaaS product or incorporated platform.' },
  { title: '2. Current Functionality', content: 'The current frontend includes simulated processing flows for several tools. Connect real PDF processing before relying on it for production document work.' },
  { title: '3. Responsible Use', content: 'Use the workspace only with files you have the right to process. Keep backups of important documents before testing file workflows.' },
  { title: '4. No Paid Plans', content: 'Paid-plan pages, upgrades, and generated upsells have been removed from this project.' },
  { title: '5. Future Updates', content: 'If this becomes a public app, update these notes to reflect the real backend, hosting, storage, analytics, and support details.' },
];

export default function Terms() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-20">
      <section className="py-14 bg-gradient-to-br from-blue-50 to-violet-50 dark:from-gray-900 dark:to-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center mx-auto mb-5">
            <FileText size={26} className="text-blue-600" />
          </div>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">Usage Notes</h1>
          <p className="text-gray-500 dark:text-gray-400">A short, honest description of how this personal project should be used.</p>
        </div>
      </section>

      <section className="py-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <div className="space-y-8">
            {sections.map(({ title, content }) => (
              <div key={title}>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-3">{title}</h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">{content}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 p-5 rounded-2xl bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Replace this section with your preferred contact details before publishing the project publicly.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
