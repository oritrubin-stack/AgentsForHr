/**
 * @file src/components/ResultsTable.tsx
 * @description Results table with match-score colour coding and LinkedIn action.
 *
 * Columns: Avatar/Name | Platform | Match Score | AI Summary | Action
 *
 * Responsive strategy:
 *  • ≥ lg  — full 5-column table
 *  • < lg  — card-per-row stacked layout
 */

import { useState } from 'react';
import {
  ExternalLink,
  MessageSquare,
  Mail,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Trophy,
  Phone,
  AtSign,
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { AnalyzedCandidate, SupportedPlatform } from '../types/candidate';

// ─── Sub-components ───────────────────────────────────────────────────────────

function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(...inputs));
}

/** Coloured badge showing the platform name. */
function PlatformBadge({ platform }: { platform: SupportedPlatform }) {
  const styles: Record<SupportedPlatform, string> = {
    linkedin:      'bg-blue-100 text-blue-700',
    github:        'bg-slate-100 text-slate-700',
    stackoverflow: 'bg-orange-100 text-orange-700',
    glassdoor:     'bg-green-100 text-green-700',
    indeed:        'bg-blue-100 text-blue-600',
    email:         'bg-emerald-100 text-emerald-700',
    mock:          'bg-purple-100 text-purple-700',
  };
  const labels: Record<SupportedPlatform, string> = {
    linkedin:      'LinkedIn',
    github:        'GitHub',
    stackoverflow: 'StackOverflow',
    glassdoor:     'Glassdoor',
    indeed:        'Indeed',
    email:         'Email',
    mock:          'Mock',
  };
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold',
      styles[platform] ?? 'bg-slate-100 text-slate-600',
    )}>
      {labels[platform] ?? platform}
    </span>
  );
}

/** Circular score badge with colour coding. */
function ScoreBadge({ score }: { score: number }) {
  const { bg, text, ring, label } =
    score >= 80
      ? { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200', label: 'Excellent' }
      : score >= 60
      ? { bg: 'bg-amber-50',   text: 'text-amber-700',   ring: 'ring-amber-200',   label: 'Good'      }
      : { bg: 'bg-red-50',     text: 'text-red-600',      ring: 'ring-red-200',     label: 'Weak'      };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className={cn(
        'flex items-center justify-center w-12 h-12 rounded-full ring-2 font-bold text-lg',
        bg, text, ring,
      )}>
        {score}
      </div>
      <span className={cn('text-[10px] font-semibold uppercase tracking-wide', text)}>
        {label}
      </span>
    </div>
  );
}

/** Initials avatar. */
function Avatar({ name, platform }: { name: string | null; platform: SupportedPlatform }) {
  const initials = name
    ? name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
    : '??';

  const colors: Record<SupportedPlatform, string> = {
    linkedin:      'from-blue-400 to-blue-600',
    github:        'from-slate-400 to-slate-600',
    stackoverflow: 'from-orange-400 to-orange-600',
    glassdoor:     'from-green-400 to-green-600',
    indeed:        'from-blue-300 to-blue-500',
    email:         'from-emerald-400 to-emerald-600',
    mock:          'from-purple-400 to-purple-600',
  };

  return (
    <div className={cn(
      'flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br text-white text-xs font-bold flex-shrink-0',
      colors[platform] ?? 'from-slate-400 to-slate-600',
    )}>
      {initials}
    </div>
  );
}

/** Expanded detail panel shown below a row. */
function DetailPanel({ candidate }: { candidate: AnalyzedCandidate }) {
  return (
    <div className="px-6 pb-5 pt-2 bg-slate-50 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-5">

      {/* Green flags */}
      <div>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 mb-2">
          <CheckCircle2 size={13} />
          Strengths
        </p>
        <ul className="space-y-1">
          {candidate.greenFlags.length > 0
            ? candidate.greenFlags.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                  <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                  {f}
                </li>
              ))
            : <li className="text-xs text-slate-400 italic">None noted</li>
          }
        </ul>
      </div>

      {/* Red flags */}
      <div>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-red-600 mb-2">
          <AlertCircle size={13} />
          Concerns
        </p>
        <ul className="space-y-1">
          {candidate.redFlags.length > 0
            ? candidate.redFlags.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                  <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                  {f}
                </li>
              ))
            : <li className="text-xs text-slate-400 italic">No concerns noted</li>
          }
        </ul>
      </div>

      {/* Skills */}
      {candidate.skills.length > 0 && (
        <div className="md:col-span-2">
          <p className="text-xs font-semibold text-slate-500 mb-2">Skills</p>
          <div className="flex flex-wrap gap-1.5">
            {candidate.skills.map((s, i) => (
              <span key={i} className="px-2 py-0.5 rounded-md bg-white border border-slate-200 text-[11px] text-slate-600 font-medium">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Location / Role / Contact */}
      <div className="md:col-span-2 flex flex-wrap gap-4 text-xs text-slate-500">
        {candidate.currentRole && (
          <span><span className="font-medium text-slate-700">Role:</span> {candidate.currentRole}</span>
        )}
        {candidate.location && (
          <span><span className="font-medium text-slate-700">Location:</span> {candidate.location}</span>
        )}
        {candidate.email && (
          <span className="flex items-center gap-1">
            <AtSign size={11} className="text-slate-400" />
            <a
              href={`mailto:${candidate.email}`}
              className="font-medium text-indigo-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {candidate.email}
            </a>
          </span>
        )}
        {candidate.phone && (
          <span className="flex items-center gap-1">
            <Phone size={11} className="text-slate-400" />
            <a
              href={`tel:${candidate.phone}`}
              className="font-medium text-slate-700 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {candidate.phone}
            </a>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Small badge showing the originating source channel (e.g. "Drushim IL",
 * "Facebook Jobs", "Direct Email").  Colour is derived from a hash so every
 * new string gets a stable, distinct hue without a hard-coded lookup table.
 */
function SourceBadge({ source }: { source: string }) {
  // Deterministic colour bucket from the source string
  const palettes = [
    'bg-sky-100 text-sky-700',
    'bg-violet-100 text-violet-700',
    'bg-rose-100 text-rose-700',
    'bg-amber-100 text-amber-700',
    'bg-teal-100 text-teal-700',
    'bg-indigo-100 text-indigo-700',
    'bg-pink-100 text-pink-700',
    'bg-lime-100 text-lime-700',
  ];
  const idx = [...source].reduce((acc, c) => acc + c.charCodeAt(0), 0) % palettes.length;
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap',
      palettes[idx],
    )}>
      {source}
    </span>
  );
}

/** The LinkedIn "Send Message" button — opens candidate profile in a new tab. */
function LinkedInAction({ profileUrl }: { profileUrl: string }) {
  return (
    <a
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-linkedin whitespace-nowrap"
      title="Open LinkedIn profile to send a message"
    >
      <MessageSquare size={12} />
      Message
    </a>
  );
}

/**
 * Email "Contact" button — opens a mailto: link.
 * Rendered disabled (with tooltip) when no email address is available.
 */
function ContactAction({ email }: { email: string | null }) {
  if (email) {
    return (
      <a
        href={`mailto:${email}`}
        className="btn-email whitespace-nowrap"
        title={`Send email to ${email}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Mail size={12} />
        Contact
      </a>
    );
  }
  return (
    <button
      disabled
      className="btn-email whitespace-nowrap"
      title="No email address available"
    >
      <Mail size={12} />
      Contact
    </button>
  );
}

/** Generic "View Profile" link for non-LinkedIn platforms. */
function ViewProfileAction({ profileUrl }: { profileUrl: string }) {
  return (
    <a
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-secondary text-xs px-3 py-1.5 whitespace-nowrap"
    >
      <ExternalLink size={12} />
      View Profile
    </a>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function CandidateRow({
  candidate,
  rank,
}: {
  candidate: AnalyzedCandidate;
  rank: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className={cn(
          'group transition-colors duration-100 cursor-pointer',
          expanded ? 'bg-slate-50' : 'bg-white hover:bg-slate-50/60',
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Rank */}
        <td className="pl-5 pr-2 py-4 w-10">
          {rank === 1
            ? <Trophy size={15} className="text-amber-400" />
            : <span className="text-xs font-semibold text-slate-400">{rank}</span>
          }
        </td>

        {/* Name */}
        <td className="px-3 py-4 min-w-[200px]">
          <div className="flex items-center gap-3">
            <Avatar name={candidate.name} platform={candidate.platform} />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 leading-snug">
                {candidate.name ?? 'Unknown'}
              </p>
              {candidate.email && (
                <p className="flex items-center gap-1 mt-0.5 text-xs text-gray-500 truncate">
                  <AtSign size={10} className="flex-shrink-0" />
                  <a
                    href={`mailto:${candidate.email}`}
                    className="hover:text-indigo-600 hover:underline truncate"
                    title={candidate.email}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {candidate.email}
                  </a>
                </p>
              )}
              {candidate.phone && (
                <p className="flex items-center gap-1 text-xs text-gray-500">
                  <Phone size={10} className="flex-shrink-0" />
                  <a
                    href={`tel:${candidate.phone}`}
                    className="hover:text-indigo-600 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {candidate.phone}
                  </a>
                </p>
              )}
              <div className="mt-1">
                <PlatformBadge platform={candidate.platform} />
              </div>
            </div>
          </div>
        </td>

        {/* Score */}
        <td className="px-4 py-4 w-24" onClick={(e) => e.stopPropagation()}>
          <ScoreBadge score={candidate.matchScore} />
        </td>

        {/* Source */}
        <td className="px-4 py-4 w-36">
          <SourceBadge source={candidate.source} />
        </td>

        {/* AI Summary */}
        <td className="px-4 py-4 max-w-xs">
          <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">
            {candidate.aiSummary}
          </p>
        </td>

        {/* Action */}
        <td className="px-4 py-4 w-36" onClick={(e) => e.stopPropagation()}>
          {candidate.platform === 'linkedin'
            ? <LinkedInAction profileUrl={candidate.profileUrl} />
            : candidate.platform === 'email'
            ? <ContactAction email={candidate.email} />
            : <ViewProfileAction profileUrl={candidate.profileUrl} />
          }
        </td>

        {/* Expand toggle */}
        <td className="pr-4 py-4 w-8 text-slate-400 group-hover:text-slate-600">
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <DetailPanel candidate={candidate} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main table component ─────────────────────────────────────────────────────

interface Props {
  candidates: AnalyzedCandidate[];
  totalDiscovered: number;
  totalAnalyzed:   number;
  failedAnalyses:  number;
  warnings:        string[];
  startedAt:       string;
  completedAt:     string;
}

export function ResultsTable({
  candidates,
  totalDiscovered,
  totalAnalyzed,
  failedAnalyses,
  warnings,
  startedAt,
  completedAt,
}: Props) {
  const duration = (
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  ).toFixed(1);

  return (
    <div className="card overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
        <div>
          <h3 className="text-sm font-bold text-slate-900">
            Campaign Results
            <span className="ml-2 text-indigo-600">({candidates.length})</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Discovered {totalDiscovered} profiles · Analysed {totalAnalyzed} · {duration}s
            {failedAnalyses > 0 && (
              <span className="ml-1 text-amber-500">· {failedAnalyses} analysis failure{failedAnalyses > 1 ? 's' : ''}</span>
            )}
          </p>
        </div>
        <span className="text-[11px] text-slate-400">
          Ranked by AI match score ↓
        </span>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mx-4 mt-3 mb-1 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p className="text-xs font-semibold text-amber-700 mb-1">Warnings</p>
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600">{w}</p>
          ))}
        </div>
      )}

      {/* Empty state */}
      {candidates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Trophy size={32} className="mb-3 opacity-30" />
          <p className="text-sm font-medium">No candidates matched your criteria.</p>
          <p className="text-xs mt-1">Try broadening the search or switching platforms.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-separate border-spacing-0">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="pl-5 pr-2 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-10">#</th>
                <th className="px-3 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Candidate</th>
                <th className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-36">Source</th>
                <th className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-24">Score</th>
                <th className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">AI Summary</th>
                <th className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-36">Action</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {candidates.map((c, i) => (
                <CandidateRow key={c.profileUrl} candidate={c} rank={i + 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
