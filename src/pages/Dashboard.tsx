import { useState, useEffect, useRef } from 'react';
import { FileText, TrendingUp, Users, Archive, Zap, ArrowUpRight, Clock, CheckCircle, Globe, Activity } from 'lucide-react';
import { Link } from 'react-router-dom';
import { tools } from '../data/tools';

function Counter({ end, suffix = '' }: { end: number; suffix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started.current) {
        started.current = true;
        const steps = 40;
        const increment = end / steps;
        let cur = 0;
        const t = setInterval(() => {
          cur += increment;
          if (cur >= end) { setCount(end); clearInterval(t); }
          else setCount(Math.floor(cur));
        }, 1000 / steps);
      }
    }, { threshold: 0.5 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end]);

  return <div ref={ref}>{count.toLocaleString()}{suffix}</div>;
}

const statCards = [
  { label: 'Tools Available', value: 31, icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/40', change: 'Ready' },
  { label: 'Compression Tools', value: 3, icon: Archive, color: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-950/40', change: 'Set' },
  { label: 'Categories', value: 6, icon: Users, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/40', change: 'Grouped' },
  { label: 'Convert Tools', value: 10, icon: TrendingUp, color: 'text-orange-600', bg: 'bg-orange-50 dark:bg-orange-950/40', change: 'Handy' },
];

const recentActivity = [
  { action: 'Compressed', file: 'annual_report.pdf', size: '18.4 MB to 3.1 MB', time: 'sample', icon: Archive, color: 'text-violet-600', bg: 'bg-violet-100 dark:bg-violet-950/40' },
  { action: 'Converted', file: 'invoice_draft.docx', size: 'DOCX to PDF', time: 'sample', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-950/40' },
  { action: 'Merged', file: '3 files combined', size: 'contract_bundle.pdf', time: 'sample', icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-950/40' },
  { action: 'Protected', file: 'financial_data.pdf', size: 'password protection', time: 'sample', icon: Zap, color: 'text-orange-600', bg: 'bg-orange-100 dark:bg-orange-950/40' },
  { action: 'Signed', file: 'nda_agreement.pdf', size: 'signature added', time: 'sample', icon: CheckCircle, color: 'text-teal-600', bg: 'bg-teal-100 dark:bg-teal-950/40' },
];

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 pt-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">My Dashboard</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">A quick overview of the PDF workspace and favorite tools.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
          {statCards.map(({ label, value, icon: Icon, color, bg, change }) => (
            <div key={label} className="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-100 dark:border-gray-700 shadow-sm">
              <div className="flex items-start justify-between mb-4">
                <div className={`w-11 h-11 rounded-xl ${bg} flex items-center justify-center`}>
                  <Icon size={22} className={color} />
                </div>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                  <ArrowUpRight size={11} />{change}
                </span>
              </div>
              <div className={`text-3xl font-bold mb-1 ${color}`}>
                <Counter end={value} />
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-bold text-gray-900 dark:text-white">Sample Workflow</h2>
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Activity size={13} className="animate-pulse" />
                Local preview
              </span>
            </div>
            <div className="space-y-4">
              {recentActivity.map(({ action, file, size, time, icon: Icon, color, bg }) => (
                <div key={file} className="flex items-center gap-4 p-3 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={18} className={color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{action}: {file}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{size}</p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
                    <Clock size={11} />
                    {time}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-bold text-gray-900 dark:text-white">Favorite Tools</h2>
              <Link to="/#tools" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">View all</Link>
            </div>
            <div className="space-y-3">
              {tools.filter(t => t.popular).slice(0, 6).map(tool => {
                const Icon = tool.icon;
                return (
                  <Link key={tool.id} to={`/tools/${tool.id}`} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group">
                    <div className={`w-9 h-9 rounded-xl ${tool.bgColor} flex items-center justify-center flex-shrink-0`}>
                      <Icon size={16} className={tool.color} />
                    </div>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{tool.label}</span>
                    <ArrowUpRight size={14} className="ml-auto text-gray-300 group-hover:text-blue-500 transition-colors" />
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
