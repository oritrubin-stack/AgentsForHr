/**
 * @file src/agents/OrchestratorAgent.ts
 * @description The Orchestrator Agent — composes HunterAgent and AnalyzerAgent
 * into a single, end-to-end recruitment campaign.
 *
 * Architecture position
 * ──────────────────────
 * ```
 *                ┌──────────────────────────────────────┐
 *   API Layer    │  POST /api/recruit                   │
 *                └────────────────┬─────────────────────┘
 *                                 │
 *               ► OrchestratorAgent.runCampaign()   ◄── you are here
 *                         │               │
 *               HunterAgent.hunt()   AnalyzerAgent.analyze() × N (concurrent)
 *                         │               │
 *               RawCandidateProfile[]  AnalyzedCandidate[]
 * ```
 *
 * Concurrency model
 * ──────────────────
 * Analysis calls run concurrently via `Promise.allSettled`.  Each profile is
 * sent to Claude independently so total analysis time equals the slowest
 * single call, not the sum of all calls.
 *
 * Failure isolation
 * ──────────────────
 * `Promise.allSettled` (not `Promise.all`) is used deliberately:
 *  • One profile failing to analyse does NOT abort the whole campaign.
 *  • Failures are logged with the profile URL and reason, then discarded.
 *  • The caller receives only successfully analysed candidates.
 *
 * Rate-limit note
 * ────────────────
 * Sending all profiles to Claude simultaneously can trigger API rate limits
 * on large campaigns.  For production use, replace the bare `Promise.allSettled`
 * with a p-limit / semaphore to cap concurrency (e.g. max 5 concurrent calls).
 * This initial implementation keeps the code simple; the refactor is isolated
 * to `_analyzeAll()`.
 *
 * Single Responsibility
 * ─────────────────────
 * The Orchestrator owns ONE concern: **coordinate hunter + analyzer and
 * deliver a scored candidate list**.  It does NOT:
 *  • Know anything about HTTP, Express, or request formats.
 *  • Know HOW scraping or analysis works — it delegates entirely.
 *  • Persist data — that belongs to a repository layer.
 */

import Anthropic                from '@anthropic-ai/sdk';
import { HunterAgent }          from './hunter/HunterAgent';
import { AnalyzerAgent }        from './analyzer/AnalyzerAgent';
import { BudgetExhaustedError } from '../errors/BudgetExhaustedError';
import {
  JobSearchQuery,
  AnalyzedCandidate,
  RawCandidateProfile,
} from '../types/candidate.types';

// ─── Result envelope ──────────────────────────────────────────────────────────

/**
 * Detailed summary of a `runCampaign` execution, including telemetry that
 * the API layer can forward to the client for observability.
 */
export interface CampaignResult {
  /** The analysed candidates, sorted by `matchScore` descending. */
  candidates: AnalyzedCandidate[];

  /** The query that drove the campaign (echoed back for traceability). */
  query: JobSearchQuery;

  /** Total profiles the Hunter discovered before the `limit` slice. */
  totalDiscovered: number;

  /** How many profiles were submitted for analysis (`rawProfiles.slice(0, limit)`). */
  totalAnalyzed: number;

  /** How many analysis calls failed and were discarded. */
  failedAnalyses: number;

  /** Non-fatal messages from the Hunter (e.g. platform-level rate-limit warnings). */
  warnings: string[];

  /** ISO-8601 timestamp when `runCampaign` was called. */
  startedAt: string;

  /** ISO-8601 timestamp when `runCampaign` returned. */
  completedAt: string;
}

// ─── OrchestratorAgent ────────────────────────────────────────────────────────

/**
 * The Orchestrator Agent.
 *
 * Runs a complete candidate-discovery-and-evaluation pipeline by composing the
 * {@link HunterAgent} (scraping) and {@link AnalyzerAgent} (LLM evaluation).
 *
 * @example
 * ```ts
 * const orchestrator = new OrchestratorAgent(
 *   new HunterAgent(new PlaywrightService()),
 *   new AnalyzerAgent(),
 * );
 *
 * const result = await orchestrator.runCampaign(
 *   { jobTitle: 'Senior TypeScript Engineer', keywords: ['Node.js'], platform: 'mock' },
 *   10,
 * );
 *
 * console.log(result.candidates[0]?.matchScore); // e.g. 82
 * ```
 */
export class OrchestratorAgent {
  constructor(
    private readonly hunter:   HunterAgent,
    private readonly analyzer: AnalyzerAgent,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Runs an end-to-end recruitment campaign:
   *  1. Hunts for raw candidate profiles matching `query`.
   *  2. Slices the result to at most `limit` profiles.
   *  3. Analyses all sliced profiles concurrently with Claude.
   *  4. Returns only the successfully analysed candidates, sorted by score.
   *
   * @param query - The job search parameters forwarded to HunterAgent.
   * @param limit - Maximum number of profiles to analyse.  The Hunter may
   *   discover more than this — only the first `limit` are passed to the
   *   Analyzer.  Capped internally at 50 to prevent accidental large bills.
   * @returns A {@link CampaignResult} envelope with candidates and telemetry.
   *
   * @throws {ScrapingError} If the Hunter encounters a hard API failure
   *   (e.g. HTTP 401 on Proxycurl) that cannot be recovered from.
   */
  async runCampaign(
    query: JobSearchQuery,
    limit: number,
  ): Promise<CampaignResult> {
    const startedAt = new Date().toISOString();

    // Safety cap — never accidentally analyse 200 profiles in one call.
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    console.log(
      `[OrchestratorAgent] Campaign started — ` +
      `platform="${query.platform}" ` +
      `title="${query.jobTitle}" ` +
      `limit=${safeLimit}`,
    );

    // ── Step 1: Hunt ──────────────────────────────────────────────────────
    const huntResult = await this.hunter.hunt(query);
    const rawProfiles = huntResult.profiles.slice(0, safeLimit);

    console.log(
      `[OrchestratorAgent] Hunter found ${huntResult.profiles.length} profile(s); ` +
      `analysing ${rawProfiles.length}.`,
    );

    // ── Step 2: Analyse concurrently ──────────────────────────────────────
    const candidates = await this._analyzeAll(rawProfiles, query);

    // ── Step 3: Sort by match score descending ────────────────────────────
    candidates.sort((a, b) => b.matchScore - a.matchScore);

    const completedAt = new Date().toISOString();
    const failedCount = rawProfiles.length - candidates.length;

    console.log(
      `[OrchestratorAgent] Campaign complete — ` +
      `${candidates.length} analysed, ` +
      `${failedCount} failed, ` +
      `${huntResult.warnings.length} hunter warning(s).`,
    );

    return {
      candidates,
      query,
      totalDiscovered:  huntResult.profiles.length,
      totalAnalyzed:    rawProfiles.length,
      failedAnalyses:   failedCount,
      warnings:         huntResult.warnings,
      startedAt,
      completedAt,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Submits all profiles to the Analyzer concurrently and returns only the
   * successful results.
   *
   * `Promise.allSettled` (not `Promise.all`) ensures a single analysis failure
   * does not abort the whole campaign.  Each rejection is logged and discarded.
   *
   * Future enhancement: wrap this in a p-limit semaphore to cap the number of
   * simultaneous Anthropic API calls and avoid 429 rate-limit errors on large
   * batches.
   *
   * @param profiles - The sliced raw profiles to analyse.
   * @param query    - The job query passed to each `analyzer.analyze()` call.
   */
  private async _analyzeAll(
    profiles: RawCandidateProfile[],
    query: JobSearchQuery,
  ): Promise<AnalyzedCandidate[]> {
    const settled = await Promise.allSettled(
      profiles.map((profile) => this.analyzer.analyze(profile, query)),
    );

    // A 402 means the account is out of credits — no further calls will
    // succeed.  Surface it as a hard campaign failure instead of silently
    // discarding it alongside per-profile failures.
    const budgetExhausted = settled.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof Anthropic.APIError &&
        outcome.reason.status === 402,
    );
    if (budgetExhausted) {
      console.error(
        '[OrchestratorAgent] Anthropic HTTP 402 — account has insufficient credits. ' +
        'Campaign aborted.',
      );
      throw new BudgetExhaustedError();
    }

    const results: AnalyzedCandidate[] = [];

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const profileUrl = profiles[index]?.profileUrl ?? `index:${index}`;
        const reason = outcome.reason as Error;

        // Surface Anthropic SDK errors (4xx / 5xx) with their HTTP status code
        // so we can distinguish 400 Bad Request, 401 Unauthorized, and
        // 403 / 529 Insufficient Credits / Overloaded at a glance in the logs.
        if (reason instanceof Anthropic.APIError) {
          console.error(
            `[OrchestratorAgent] Analysis failed for "${profileUrl}" — ` +
            `Anthropic API error: HTTP ${reason.status} ${reason.name}: ${reason.message}`,
          );
        } else {
          console.error(
            `[OrchestratorAgent] Analysis failed for "${profileUrl}": ` +
            `${reason?.message ?? String(reason)}`,
          );
        }

        // Always emit the full serialised error so any field the Anthropic SDK
        // attaches (request_id, error.type, error.message) is visible in logs.
        try {
          console.error(
            `[OrchestratorAgent] Full error detail: ${JSON.stringify(
              outcome.reason,
              // Custom replacer: Error objects don't serialise with JSON.stringify
              // by default because their properties are non-enumerable.
              // This replacer captures message, name, stack, and all own keys.
              (_key, value: unknown) => {
                if (value instanceof Error) {
                  const obj: Record<string, unknown> = {
                    name:    value.name,
                    message: value.message,
                    stack:   value.stack,
                  };
                  // Capture enumerable own properties (e.g. Anthropic status, headers).
                  for (const k of Object.keys(value)) {
                    obj[k] = (value as unknown as Record<string, unknown>)[k];
                  }
                  return obj;
                }
                return value;
              },
              2,
            )}`,
          );
        } catch {
          // JSON.stringify can fail on circular structures — fall back to String().
          console.error(
            `[OrchestratorAgent] Full error detail (non-serialisable): ${String(outcome.reason)}`,
          );
        }
      }
    }

    return results;
  }
}
