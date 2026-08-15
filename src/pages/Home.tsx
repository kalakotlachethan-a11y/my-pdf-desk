import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CheckCircle, Zap, Shield, Globe, Users,
  FileText, Star, TrendingUp, Award,
} from 'lucide-react';
import ToolCard from '../components/ToolCard';
import { tools, categories } from '../data/tools';

function AnimatedCounter({ end, suffix = '' }: { end: number; suffix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started.current) {
        started.current = true;
        const duration = 1000;
        const steps = 40;
        const increment = end / steps;
        let current = 0;
        const timer = setInterval(() => {
          current += increment;
          if (current >= end) {
            setCount(end);
            clearInterval(timer);
          } else {
            setCount(Math.floor(current));
          }
        }, duration / steps);
      }
    }, { threshold: 0.5 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end]);

  return <span ref={ref}>{count.toLocaleString()}{suffix}</span>;
}

const stats = [
  { label: 'Tool Categories', value: 6, icon: FileText, color: 'text-blue-600' },
  { label: 'PDF Utilities', value: 31, icon: Users, color: 'text-violet-600' },
  { label: 'Quick Actions', value: 12, icon: TrendingUp, color: 'text-emerald-600' },
  { label: 'Browser Based', value: 1, icon: Globe, color: 'text-orange-600' },
];

const features = [
  { icon: Zap, title: 'Fast to Reach', desc: 'Common PDF actions are grouped so the right tool is only a click away.', color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
  { icon: Shield, title: 'Privacy Minded', desc: 'The interface is designed around temporary file handling and clear reset states.', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
  { icon: Globe, title: 'No Installation', desc: 'Runs in the browser with a responsive layout for desktop and mobile.', color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  { icon: Award, title: 'Personal Workflow', desc: 'Focused on the PDF tasks I actually want collected in one workspace.', color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
];

const popularTools = tools.filter(t => t.popular);

export default function Home() {
  const [activeCategory, setActiveCategory] = useState('All');
  const filteredTools = activeCategory === 'All' ? tools : tools.filter(t => t.category === activeCategory);

  return (
    <div className="bg-white dark:bg-gray-900 min-h-screen">
      <section className="relative pt-24 pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-violet-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-900" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
            <div className="flex-1 text-center lg:text-left">
              <div className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 rounded-full px-4 py-1.5 text-sm font-medium mb-6 border border-blue-100 dark:border-blue-800">
                <Zap size={14} className="fill-current" />
                Personal PDF workspace
              </div>
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-gray-900 dark:text-white leading-tight text-balance mb-6">
                My <span className="gradient-text">PDF Desk</span> for Everyday Files
              </h1>
              <p className="text-xl text-gray-500 dark:text-gray-400 leading-relaxed mb-8 max-w-2xl">
                Compress, edit, convert, merge, split, protect, and sign PDFs from one clean workspace.
              </p>
              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-4 mb-8">
                <Link to="/tools/compress-pdf" className="btn-primary text-base px-8 py-3.5">
                  Open a Tool <ArrowRight size={18} />
                </Link>
                <Link to="#tools" className="btn-secondary text-base px-8 py-3.5">
                  Browse Tools
                </Link>
              </div>
              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-6 text-sm text-gray-500 dark:text-gray-400">
                {['No sign-up wall', 'Simple file flow', 'Dark mode ready'].map(text => (
                  <span key={text} className="flex items-center gap-1.5">
                    <CheckCircle size={15} className="text-emerald-500" />
                    {text}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex-1 flex justify-center lg:justify-end">
              <div className="relative w-full max-w-sm">
                <div className="relative bg-white dark:bg-gray-800 rounded-3xl shadow-2xl p-8 border border-gray-100 dark:border-gray-700 animate-float">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 rounded-2xl gradient-bg flex items-center justify-center shadow-lg">
                      <FileText size={24} className="text-white" />
                    </div>
                    <div>
                      <div className="font-bold text-gray-900 dark:text-white">report_final.pdf</div>
                      <div className="text-sm text-gray-400">12.4 MB to compress</div>
                    </div>
                  </div>
                  <div className="mb-4">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-gray-500 dark:text-gray-400">Compressing</span>
                      <span className="font-semibold gradient-text">73%</span>
                    </div>
                    <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full w-3/4 gradient-bg rounded-full" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle size={14} />
                    Estimated size: 3.2 MB
                  </div>
                </div>

                <div className="absolute -top-6 -right-6 bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-3 border border-gray-100 dark:border-gray-700 flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center">
                    <Shield size={16} className="text-emerald-600" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-gray-900 dark:text-white">Private</div>
                    <div className="text-xs text-gray-400">by design</div>
                  </div>
                </div>

                <div className="absolute -bottom-4 -left-6 bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-3 border border-gray-100 dark:border-gray-700 flex items-center gap-2">
                  <div className="flex -space-x-1">
                    {['bg-blue-500', 'bg-violet-500', 'bg-emerald-500'].map((c, i) => (
                      <div key={i} className={`w-6 h-6 rounded-full ${c} border-2 border-white dark:border-gray-800`} />
                    ))}
                  </div>
                  <div className="text-xs">
                    <div className="font-bold text-gray-900 dark:text-white">My workspace</div>
                    <div className="text-gray-400">organized</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 bg-gray-50 dark:bg-gray-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="text-center">
                <div className="text-4xl font-bold text-gray-900 dark:text-white mb-1">
                  <AnimatedCounter end={value} />
                </div>
                <div className="flex items-center justify-center gap-1.5 text-gray-500 dark:text-gray-400 text-sm">
                  <Icon size={14} className={color} />
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 rounded-full px-4 py-1.5 text-sm font-medium mb-4 border border-blue-100 dark:border-blue-800">
              <Star size={14} className="fill-current" />
              Favorite Starting Points
            </div>
            <h2 className="section-heading">Most-Used PDF Tools</h2>
            <p className="section-subheading">Start with the tools I reach for most often</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {popularTools.map(tool => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      </section>

      <section id="tools" className="py-20 bg-gray-50 dark:bg-gray-800/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="section-heading">All PDF Tools</h2>
            <p className="section-subheading">Everything I need to work with PDFs in one place</p>
          </div>

          <div className="flex flex-wrap justify-center gap-2 mb-10">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                  activeCategory === cat
                    ? 'gradient-bg text-white shadow-md'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 border border-gray-200 dark:border-gray-700'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredTools.map(tool => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="section-heading">Why I Built This</h2>
            <p className="section-subheading">A simple home for the document actions I keep needing</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map(({ icon: Icon, title, desc, color, bg }) => (
              <div key={title} className="flex flex-col gap-4 p-6 rounded-2xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow">
                <div className={`w-12 h-12 rounded-xl ${bg} flex items-center justify-center`}>
                  <Icon size={22} className={color} />
                </div>
                <div>
                  <h3 className="font-bold text-gray-900 dark:text-white mb-1">{title}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="relative rounded-3xl gradient-bg overflow-hidden p-12 text-center">
            <div className="relative">
              <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">Ready to clean up a file?</h2>
              <p className="text-blue-100 text-lg mb-8 max-w-xl mx-auto">
                Pick a tool, add your document, and keep the workflow moving without an upsell screen in the way.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <Link to="/tools/compress-pdf" className="inline-flex items-center gap-2 bg-white text-blue-700 font-semibold px-8 py-3.5 rounded-xl hover:bg-blue-50 transition-colors shadow-lg">
                  Open Compress Tool <ArrowRight size={18} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
