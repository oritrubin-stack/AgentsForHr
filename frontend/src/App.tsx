/**
 * @file src/App.tsx
 * @description Root application component — B2B SaaS dashboard shell.
 *
 * Layout
 * ───────
 *  ┌──────────────────────────────────────────────────────┐
 *  │  Sidebar (fixed 256 px)  │  Main content area        │
 *  │  - Brand logo            │  - Page header            │
 *  │  - Navigation            │  - SearchForm             │
 *  │  - User card             │  - Stats bar (post-search)│
 *  │                          │  - ResultsTable           │
 *  └──────────────────────────┴──────────────────────────-┘
 */

import {
  BrainCircuit,
  Sparkles,
  AlertTriangle,
  RefreshCw,
  Users,
  TrendingUp,
  Clock,
} from 'lucide-react';
import { Sidebar }        from './components/Sidebar';
import { SearchForm }     from './components/SearchForm';
import { ResultsTable }   from './components/ResultsTable';
import { useRecruitment } from './hooks/useRecruitment';
import type { RecruitRequest } from './types/candidate';

// ─── Sub-components ───────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <header className="flex items-center justify-between mb-8">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={16} className="text-indigo-500" />
          <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 leading-tight">
          Recruitment Dashboard
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Find, evaluate, and connect with top candidates 
        </p>
      </div>

      {/* Live indicator */}
      <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span className="text-xs font-medium text-emerald-700">API Online</span>
      </div>
    </header>
  );
}

function LoadingOverlay() {
  return (
    <div className="card p-12 flex flex-col items-center justify-center gap-4 text-center">
      {/* Animated concentric rings */}
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-4 border-indigo-100" />
        <div className="absolute inset-0 rounded-full border-4 border-indigo-500 border-t-transparent animate-spin" />
        <div className="absolute inset-2 rounded-full border-4 border-indigo-200 border-b-transparent animate-spin-slow" />
        <BrainCircuit size={18} className="absolute inset-0 m-auto text-indigo-600" />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-800">Campaign Running</p>
        <p className="text-xs text-slate-400 mt-1 max-w-xs">
          Hunting for candidates and evaluating them with Claude AI.
          This may take up to 60 seconds…
        </p>
      </div>
      {/* Progress steps */}
      <div className="flex items-center gap-3 mt-2">
        {['Searching', 'Scraping', 'Analysing', 'Ranking'].map((step, i) => (
          <div key={step} className="flex items-center gap-1.5">
            {i > 0 && <div className="w-6 h-px bg-slate-200" />}
            <div className="flex flex-col items-center gap-1">
              <div
                className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"
                style={{ animationDelay: `${i * 300}ms` }}
              />
              <span className="text-[10px] text-slate-400">{step}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ErrorBannerProps {
  message:   string;
  errorType: string;
  retryable: boolean;
  onDismiss: () => void;
}

function ErrorBanner({ message, errorType, retryable, onDismiss }: ErrorBannerProps) {
  return (
    <div className="card border-red-200 bg-red-50 p-5">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-red-100 flex items-center justify-center">
          <AlertTriangle size={17} className="text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-800">{errorType}</p>
          <p className="text-xs text-red-600 mt-1 leading-relaxed">{message}</p>
          {retryable && (
            <p className="text-[11px] text-red-500 mt-1">
              This error is transient — try again in a moment.
            </p>
          )}
          <button
            onClick={onDismiss}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:text-red-800 underline underline-offset-2"
          >
            <RefreshCw size={12} />
            Dismiss &amp; try again
          </button>
        </div>
      </div>
    </div>
  );
}

function StatsBar({
  count,
  discovered,
  failed,
}: {
  count:      number;
  discovered: number;
  failed:     number;
}) {
  const stats = [
    { icon: Users,      label: 'Matched',    value: count,      color: 'text-indigo-600'  },
    { icon: TrendingUp, label: 'Discovered', value: discovered, color: 'text-emerald-600' },
    { icon: Clock,      label: 'Dropped',    value: failed,     color: 'text-amber-600'   },
  ];

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      {stats.map(({ icon: Icon, label, value, color }) => (
        <div key={label} className="card px-5 py-4 flex items-center gap-3">
          <div className={`${color} opacity-80`}>
            <Icon size={20} />
          </div>
          <div>
            <p className={`text-xl font-bold leading-none ${color}`}>{value}</p>
            <p className="text-[11px] text-slate-400 font-medium mt-0.5">{label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { status, result, error, search, reset } = useRecruitment();

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      {/* Main content — offset by sidebar width */}
      <main className="flex-1 ml-64 min-h-screen">
        <div className="max-w-6xl mx-auto px-8 py-8">
          <PageHeader />

          {/* Two-column on large screens */}
          <div className="flex flex-col lg:flex-row gap-6 items-start">

            {/* Left col — Search form (sticky on desktop) */}
            <div className="w-full lg:w-80 lg:sticky lg:top-8 flex-shrink-0">
              <SearchForm
                onSubmit={(payload: RecruitRequest) => search(payload)}
                onReset={reset}
                isLoading={status === 'loading'}
              />
            </div>

            {/* Right col — Results */}
            <div className="flex-1 min-w-0">

              {/* Idle state */}
              {status === 'idle' && (
                <div className="card border-dashed border-2 border-slate-200 p-12 flex flex-col items-center justify-center text-center text-slate-400">
                  <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                    <BrainCircuit size={24} className="text-slate-300" />
                  </div>
                  <p className="text-sm font-semibold text-slate-500">No campaign running yet</p>
                  <p className="text-xs mt-1 max-w-xs">
                    Fill in the search form and click{' '}
                    <span className="font-semibold text-indigo-600">Run Campaign</span>{' '}
                    to discover and evaluate candidates.
                  </p>
                </div>
              )}

              {/* Loading state */}
              {status === 'loading' && <LoadingOverlay />}

              {/* Error state */}
              {status === 'error' && error && (
                <ErrorBanner
                  errorType={error.errorType}
                  message={error.message}
                  retryable={error.retryable}
                  onDismiss={reset}
                />
              )}

              {/* Success state */}
              {status === 'success' && result && (
                <>
                  <StatsBar
                    count={result.count}
                    discovered={result.totalDiscovered}
                    failed={result.failedAnalyses}
                  />
                  <ResultsTable
                    candidates={result.candidates}
                    totalDiscovered={result.totalDiscovered}
                    totalAnalyzed={result.totalAnalyzed}
                    failedAnalyses={result.failedAnalyses}
                    warnings={result.warnings}
                    startedAt={result.startedAt}
                    completedAt={result.completedAt}
                  />
                </>
              )}

            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
