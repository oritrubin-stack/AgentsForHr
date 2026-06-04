/**
 * @file src/components/Sidebar.tsx
 * @description Fixed navigation sidebar — B2B SaaS style.
 */

import { BrainCircuit, LayoutDashboard, Users, BarChart3, Settings, Briefcase } from 'lucide-react';
import { clsx } from 'clsx';

interface NavItem {
  icon:   React.ElementType;
  label:  string;
  active: boolean;
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { icon: LayoutDashboard, label: 'Dashboard',  active: true  },
  { icon: Briefcase,       label: 'Campaigns',  active: false },
  { icon: Users,           label: 'Candidates', active: false },
  { icon: BarChart3,       label: 'Analytics',  active: false },
  { icon: Settings,        label: 'Settings',   active: false },
];

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 w-64 bg-slate-900 flex flex-col z-20">

      {/* ── Brand ── */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-700/60">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-indigo-600 shadow-lg shadow-indigo-900/40">
          <BrainCircuit size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-none">AgentsForHR</p>
          <p className="text-[11px] text-slate-400 mt-0.5">AI Recruitment Platform</p>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ icon: Icon, label, active, badge }) => (
          <button
            key={label}
            className={clsx(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
              active
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-900/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800',
            )}
          >
            <Icon size={17} />
            <span className="flex-1 text-left">{label}</span>
            {badge != null && (
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500 text-[10px] font-bold text-white">
                {badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* ── User card ── */}
      <div className="px-4 py-4 border-t border-slate-700/60">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 text-white text-xs font-bold flex-shrink-0">
            HR
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white truncate">HR Manager</p>
            <p className="text-[10px] text-slate-500 truncate">oritkoreng@gmail.com</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
