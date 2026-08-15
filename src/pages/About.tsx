import { Link } from 'react-router-dom';
import { FileText, Zap, Shield, Globe, Award } from 'lucide-react';

const values = [
  { icon: Zap, title: 'Fast Access', desc: 'The tools are grouped around the PDF tasks I need most often.', color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
  { icon: Shield, title: 'Simple Privacy', desc: 'The app avoids accounts, upsell flows, and unnecessary tracking surfaces.', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
  { icon: Globe, title: 'Browser Friendly', desc: 'The workspace is responsive and usable from a desktop or mobile browser.', color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  { icon: Award, title: 'Personal Polish', desc: 'The interface is meant to feel like a useful personal desk, not a generic template.', color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
];

export default function About() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 pt-20">
      <section className="py-20 bg-gradient-to-br from-blue-50 to-violet-50 dark:from-gray-900 dark:to-gray-900 border-b border-gray-100 dark:border-gray-800">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <div className="w-16 h-16 rounded-2xl gradient-bg flex items-center justify-center mx-auto mb-6 shadow-xl">
            <FileText size={30} className="text-white" />
          </div>
          <h1 className="text-5xl font-bold text-gray-900 dark:text-white mb-4">
            About <span className="gradient-text">My PDF Desk</span>
          </h1>
          <p className="text-xl text-gray-500 dark:text-gray-400 max-w-2xl mx-auto leading-relaxed">
            This is a personal PDF workspace built to keep everyday document tasks in one calm, easy-to-use place.
          </p>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Why This Exists</h2>
              <div className="space-y-4 text-gray-600 dark:text-gray-400 leading-relaxed">
                <p>I wanted a focused place for common PDF tasks without upsell walls, fake company stories, or scattered tools.</p>
                <p>The app keeps conversion, compression, editing, organization, security, and signature flows together with a consistent interface.</p>
                <p>Some processing behavior is still simulated in the current frontend, but the project is now shaped as a personal product foundation instead of a generated SaaS landing page.</p>
              </div>
            </div>
            <div className="rounded-3xl bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 p-8 shadow-sm">
              <div className="w-14 h-14 rounded-2xl gradient-bg flex items-center justify-center mb-6">
                <FileText size={26} className="text-white" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">Personal, not corporate</h3>
              <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
                The project now avoids fake user counts, fake team bios, paid plan messaging, and third-party ad scripts.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 bg-gray-50 dark:bg-gray-800/30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white">Design Priorities</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {values.map(({ icon: Icon, title, desc, color, bg }) => (
              <div key={title} className="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-100 dark:border-gray-700 shadow-sm">
                <div className={`w-12 h-12 rounded-xl ${bg} flex items-center justify-center mb-4`}>
                  <Icon size={22} className={color} />
                </div>
                <h3 className="font-bold text-gray-900 dark:text-white mb-2">{title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-2xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">Open the workspace</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-6">Start from the full tool list or jump straight into compression.</p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link to="/#tools" className="btn-primary">View Tools</Link>
            <Link to="/tools/compress-pdf" className="btn-secondary">Compress PDF</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
