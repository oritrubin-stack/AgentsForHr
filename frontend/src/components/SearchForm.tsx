/**
 * @file src/components/SearchForm.tsx
 * @description Campaign search form with validation and loading state.
 *
 * Controlled form — all field state is local; the parent receives a
 * submitted `RecruitRequest` via `onSubmit`.
 */

import { useState, FormEvent } from 'react';
import { Search, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { RecruitRequest, SupportedPlatform } from '../types/candidate';

interface Props {
  onSubmit:  (payload: RecruitRequest) => void;
  onReset?:  () => void;
  isLoading: boolean;
}

interface FormState {
  jobTitle:  string;
  keywords:  string;   // comma-separated; split on submit
  platform:  SupportedPlatform;
  location:  string;
  limit:     number;
}

const PLATFORM_OPTIONS: { value: SupportedPlatform; label: string; description: string }[] = [
  {
    value:       'linkedin',
    label:       'LinkedIn',
    description: 'Via Proxycurl API',
  },
  {
    value:       'email',
    label:       'Email Inbox',
    description: 'Via IMAP / Outlook',
  },
  {
    value:       'mock',
    label:       'Demo / Mock',
    description: 'No API key needed',
  },
];

const INITIAL: FormState = {
  jobTitle:  '',
  keywords:  '',
  platform:  'mock',
  location:  '',
  limit:     5,
};

export function SearchForm({ onSubmit, onReset, isLoading }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  // ── Validation ──────────────────────────────────────────────────────────
  function validate(): boolean {
    const next: typeof errors = {};
    if (!form.jobTitle.trim())                 next.jobTitle = 'Job title is required.';
    if (form.limit < 1 || form.limit > 50)     next.limit    = 'Limit must be between 1 and 50.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ── Handlers ────────────────────────────────────────────────────────────
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const keywords = form.keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    onSubmit({
      jobTitle:  form.jobTitle.trim(),
      keywords,
      platform:  form.platform,
      location:  form.location.trim() || undefined,
      limit:     form.limit,
    });
  }

  function handleReset() {
    setForm(INITIAL);
    setErrors({});
    onReset?.();
  }

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="card p-6">
      <div className="mb-5">
        <h2 className="text-base font-bold text-slate-900">New Campaign</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Configure your search parameters and let AI find the best candidates.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Job Title */}
          <div className="md:col-span-2">
            <label className="label" htmlFor="jobTitle">Job Title *</label>
            <input
              id="jobTitle"
              type="text"
              className={clsx('input-field', errors.jobTitle && 'ring-2 ring-red-400 border-transparent')}
              placeholder="e.g. Senior TypeScript Engineer"
              value={form.jobTitle}
              onChange={(e) => set('jobTitle', e.target.value)}
              disabled={isLoading}
            />
            {errors.jobTitle && (
              <p className="mt-1 text-xs text-red-500">{errors.jobTitle}</p>
            )}
          </div>

          {/* Keywords */}
          <div className="md:col-span-2">
            <label className="label" htmlFor="keywords">Keywords</label>
            <input
              id="keywords"
              type="text"
              className="input-field"
              placeholder="Node.js, TypeScript, AWS  (comma-separated)"
              value={form.keywords}
              onChange={(e) => set('keywords', e.target.value)}
              disabled={isLoading}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Separate multiple skills with commas.
            </p>
          </div>

          {/* Location */}
          <div>
            <label className="label" htmlFor="location">Location</label>
            <input
              id="location"
              type="text"
              className="input-field"
              placeholder="e.g. Israel, Remote, New York"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              disabled={isLoading}
            />
          </div>

          {/* Limit */}
          <div>
            <label className="label" htmlFor="limit">
              Candidate Limit
            </label>
            <input
              id="limit"
              type="number"
              min={1}
              max={50}
              className={clsx('input-field', errors.limit && 'ring-2 ring-red-400 border-transparent')}
              value={form.limit}
              onChange={(e) => set('limit', Math.max(1, parseInt(e.target.value) || 1))}
              disabled={isLoading}
            />
            {errors.limit && (
              <p className="mt-1 text-xs text-red-500">{errors.limit}</p>
            )}
          </div>

          {/* Platform */}
          <div className="md:col-span-2">
            <label className="label">Platform</label>
            <div className="flex flex-col gap-2">
              {PLATFORM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('platform', opt.value)}
                  disabled={isLoading}
                  className={clsx(
                    'relative flex items-start gap-3 p-3 rounded-lg border-2 text-left transition-all duration-150',
                    form.platform === opt.value
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-slate-200 bg-white hover:border-slate-300',
                    isLoading && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {/* Radio dot */}
                  <div className={clsx(
                    'mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                    form.platform === opt.value
                      ? 'border-indigo-500'
                      : 'border-slate-300',
                  )}>
                    {form.platform === opt.value && (
                      <div className="w-2 h-2 rounded-full bg-indigo-500" />
                    )}
                  </div>
                  <div>
                    <p className={clsx(
                      'text-sm font-semibold',
                      form.platform === opt.value ? 'text-indigo-700' : 'text-slate-700',
                    )}>
                      {opt.label}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{opt.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 mt-6 pt-5 border-t border-slate-100">
          <button
            type="submit"
            disabled={isLoading}
            className="btn-primary flex-1 justify-center"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Analysing candidates…
              </>
            ) : (
              <>
                <Search size={16} />
                Run Campaign
              </>
            )}
          </button>

          {(form.jobTitle || form.keywords || form.location) && !isLoading && (
            <button
              type="button"
              onClick={handleReset}
              className="btn-secondary"
              title="Clear form"
            >
              <X size={15} />
              Clear
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
