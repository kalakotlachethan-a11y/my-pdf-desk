import { Shield, Lock } from 'lucide-react';

const sections = [
  { title: '1. Project Scope', content: 'My PDF Desk is currently a frontend workspace for PDF-related tools. Some file processing behavior is simulated until real processing services are connected.' },
  { title: '2. File Handling', content: 'Uploaded files are held by the browser interface while you interact with a tool. If backend processing is added later, the file handling rules should be updated here before publishing.' },
  { title: '3. Local Preferences', content: 'The app stores your light or dark theme preference in localStorage so the interface remembers your choice.' },
  { title: '4. Tracking and Ads', content: 'Generated ad scripts and paid-plan flows have been removed. The project should stay free of unnecessary tracking unless you intentionally add analytics later.' },
  { title: '5. Contact Details', content: 'Replace placeholder contact details with your preferred email or support destination before sharing the app publicly.' },
];

export default function Privacy() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-20">
      <section className="py-14 bg-gradient-to-br from-blue-50 to-violet-50 dark:from-gray-900 dark:to-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center mx-auto mb-5">
            <Shield size={26} className="text-emerald-600" />
          </div>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">Privacy Notes</h1>
          <p className="text-gray-500 dark:text-gray-400">Plain-language notes for this personal PDF workspace.</p>
        </div>
      </section>

      <section className="py-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-5 mb-8 flex items-start gap-3">
            <Lock size={18} className="text-emerald-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-emerald-800 dark:text-emerald-300">
              <strong>Current setup:</strong> this is a personal frontend project, not a hosted commercial file-processing service.
            </p>
          </div>

          <div className="space-y-8">
            {sections.map(({ title, content }) => (
              <div key={title}>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-3">{title}</h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">{content}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
