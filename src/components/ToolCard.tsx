import { Link } from 'react-router-dom';
import { ArrowRight, Star, Zap } from 'lucide-react';
import { Tool } from '../data/tools';

interface ToolCardProps {
  tool: Tool;
}

export default function ToolCard({ tool }: ToolCardProps) {
  const Icon = tool.icon;
  return (
    <Link to={`/tools/${tool.id}`} className="tool-card group shadow-sm">
      {(tool.popular || tool.new) && (
        <span className={`absolute top-3 right-3 text-xs font-semibold px-2 py-0.5 rounded-full ${
          tool.popular
            ? 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
            : 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-300'
        }`}>
          {tool.popular ? (
            <span className="flex items-center gap-1"><Star size={10} fill="currentColor" /> Popular</span>
          ) : (
            <span className="flex items-center gap-1"><Zap size={10} /> New</span>
          )}
        </span>
      )}

      <div className={`w-11 h-11 rounded-xl ${tool.bgColor} flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-110 duration-300`}>
        <Icon size={22} className={tool.color} />
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-gray-900 dark:text-white text-sm leading-tight">{tool.label}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed line-clamp-2">{tool.description}</p>
      </div>

      <div className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        Use tool <ArrowRight size={12} />
      </div>
    </Link>
  );
}
