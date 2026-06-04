/**
 * @file src/api/controllers/RecruitmentController.ts
 * @description HTTP controller for the recruitment campaign endpoint.
 *
 * Responsibilities (Single Responsibility Principle)
 * ───────────────────────────────────────────────────
 * This class owns exactly ONE concern: **translate between HTTP and the
 * OrchestratorAgent**.  Specifically it:
 *  1. Parses and validates the request body.
 *  2. Calls `OrchestratorAgent.runCampaign()`.
 *  3. Serialises the result into the HTTP response.
 *  4. Maps domain errors to appropriate HTTP status codes.
 *
 * What does NOT belong here
 * ──────────────────────────
 * • Business logic           → OrchestratorAgent
 * • Scraping logic           → HunterAgent / IScraperStrategy
 * • LLM evaluation logic     → AnalyzerAgent
 * • Route definition / paths → recruitment.routes.ts
 *
 * HTTP contract
 * ──────────────
 * POST /api/recruit
 *
 * Request body (application/json):
 * ```json
 * {
 *   "jobTitle":  "Senior TypeScript Engineer",   // required
 *   "keywords":  ["Node.js", "LangChain"],       // optional, default []
 *   "platform":  "mock",                         // optional, default "mock"
 *   "location":  "Israel",                       // optional
 *   "limit":     10                              // optional, default 10, max 50
 * }
 * ```
 *
 * Success response (200):
 * ```json
 * {
 *   "success":         true,
 *   "count":           3,
 *   "query":           { ... },
 *   "candidates":      [ ... ],
 *   "totalDiscovered": 5,
 *   "totalAnalyzed":   3,
 *   "failedAnalyses":  0,
 *   "warnings":        [],
 *   "startedAt":       "2024-...",
 *   "completedAt":     "2024-..."
 * }
 * ```
 *
 * Error response:
 * ```json
 * {
 *   "success":   false,
 *   "error":     "Bad Gateway",
 *   "message":   "[linkedin] API key is invalid (HTTP 401).",
 *   "retryable": false
 * }
 * ```
 *
 * Dependency injection
 * ─────────────────────
 * The controller receives a pre-built `OrchestratorAgent` via its constructor.
 * This keeps tests simple: inject a mock orchestrator and exercise the full
 * HTTP pipeline without touching real APIs.
 */

import { Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { OrchestratorAgent }  from '../../agents/OrchestratorAgent';
import { ScrapingError }      from '../../errors/ScrapingError';
import { AnalysisError }      from '../../agents/analyzer/AnalyzerAgent';
import {
  JobSearchQuery,
  SupportedPlatform,
} from '../../types/candidate.types';

// ─── Request / Response types ────────────────────────────────────────────────

/**
 * Shape of the request body accepted by `POST /api/recruit`.
 * Typed strictly to document the contract for the React frontend.
 */
export interface RecruitRequestBody {
  /** Role or job title to search for. Required. */
  jobTitle: string;
  /** Additional skill / technology keywords. Optional, default []. */
  keywords?: string[];
  /** Target platform. Optional, default "mock". */
  platform?: SupportedPlatform;
  /** Geographic filter. Optional. */
  location?: string;
  /** Maximum candidates to analyse. Optional, default 10, capped at 50. */
  limit?: number;
}

/** All platforms the controller accepts from callers. */
const VALID_PLATFORMS: SupportedPlatform[] = [
  'linkedin', 'github', 'stackoverflow', 'glassdoor', 'indeed', 'email', 'mock',
];

const DEFAULT_LIMIT    = 10;
const MAX_LIMIT        = 50;
const DEFAULT_PLATFORM: SupportedPlatform = 'mock';

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * Express controller that exposes the recruitment pipeline over HTTP.
 *
 * @example — production wiring (in the router file)
 * ```ts
 * const controller = new RecruitmentController(
 *   new OrchestratorAgent(
 *     new HunterAgent(new PlaywrightService()),
 *     new AnalyzerAgent(),
 *   ),
 * );
 * router.post('/recruit', (req, res, next) => controller.postRecruit(req, res, next));
 * ```
 *
 * @example — test wiring (inject mock)
 * ```ts
 * const controller = new RecruitmentController(mockOrchestrator);
 * ```
 */
export class RecruitmentController {
  constructor(private readonly orchestrator: OrchestratorAgent) {}

  // ── Route handlers ──────────────────────────────────────────────────────────

  /**
   * POST /api/recruit
   *
   * Validates the request, runs the campaign, and returns analysed candidates.
   *
   * Express 5 forwards thrown errors from async handlers automatically,
   * but we still use explicit try/catch so we can map domain errors to
   * specific HTTP status codes before the global error handler fires.
   *
   * @param req  - Express request; body typed as {@link RecruitRequestBody}.
   * @param res  - Express response.
   * @param next - Passed unexpected errors to the global error handler.
   */
  async postRecruit(
    req: Request<unknown, unknown, RecruitRequestBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // ── 1. Validate ────────────────────────────────────────────────────────
    const validationError = this._validate(req.body);
    if (validationError) {
      res.status(400).json({
        success: false,
        error:   'Validation Error',
        message: validationError.message,
        field:   validationError.field,
      });
      return;
    }

    // ── 2. Build query ─────────────────────────────────────────────────────
    const body = req.body;
    const limit: number = this._parseLimit(body.limit);

    const query: JobSearchQuery = {
      jobTitle:   body.jobTitle.trim(),
      keywords:   (body.keywords ?? []).map((k) => String(k).trim()).filter(Boolean),
      platform:   (body.platform as SupportedPlatform) ?? DEFAULT_PLATFORM,
      location:   body.location?.trim() || undefined,
      maxResults: limit,          // Hunter fetches at most `limit` profiles
    };

    // ── 3. Run campaign ────────────────────────────────────────────────────
    try {
      const result = await this.orchestrator.runCampaign(query, limit);

      res.status(200).json({
        success:         true,
        count:           result.candidates.length,
        query:           result.query,
        candidates:      result.candidates,
        totalDiscovered: result.totalDiscovered,
        totalAnalyzed:   result.totalAnalyzed,
        failedAnalyses:  result.failedAnalyses,
        warnings:        result.warnings,
        startedAt:       result.startedAt,
        completedAt:     result.completedAt,
      });

    } catch (err) {
      this._handleError(err, res, next);
    }
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  /**
   * Validates the request body fields.
   * Returns a structured error object if invalid, or `null` if all good.
   *
   * @param body - The raw request body (may have wrong types if a client sends garbage).
   */
  private _validate(body: RecruitRequestBody): { message: string; field: string } | null {
    // jobTitle: required non-empty string
    if (!body || typeof body.jobTitle !== 'string' || !body.jobTitle.trim()) {
      return { message: '"jobTitle" is required and must be a non-empty string.', field: 'jobTitle' };
    }

    // keywords: if provided, must be an array of strings
    if (body.keywords !== undefined) {
      if (!Array.isArray(body.keywords)) {
        return { message: '"keywords" must be an array of strings.', field: 'keywords' };
      }
      if (body.keywords.some((k) => typeof k !== 'string')) {
        return { message: '"keywords" array must contain only strings.', field: 'keywords' };
      }
    }

    // platform: if provided, must be a known SupportedPlatform value
    if (body.platform !== undefined) {
      if (!VALID_PLATFORMS.includes(body.platform as SupportedPlatform)) {
        return {
          message: `"platform" must be one of: ${VALID_PLATFORMS.join(', ')}.`,
          field:   'platform',
        };
      }
    }

    // limit: if provided, must be a positive integer ≤ MAX_LIMIT
    if (body.limit !== undefined) {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1) {
        return { message: `"limit" must be a positive integer (got ${body.limit}).`, field: 'limit' };
      }
      if (n > MAX_LIMIT) {
        return { message: `"limit" must not exceed ${MAX_LIMIT} (got ${n}).`, field: 'limit' };
      }
    }

    return null;
  }

  /**
   * Parses the `limit` field from the request body, applying the default and cap.
   */
  private _parseLimit(raw: number | undefined): number {
    if (raw === undefined || raw === null) return DEFAULT_LIMIT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  }

  // ── Error handling ─────────────────────────────────────────────────────────

  /**
   * Maps domain errors to appropriate HTTP status codes and response bodies.
   *
   * | Error type                          | Status | Meaning                      |
   * |-------------------------------------|--------|------------------------------|
   * | `ScrapingError` non-retryable       | 502    | Upstream auth/config problem |
   * | `ScrapingError` retryable           | 503    | Upstream rate-limit / down   |
   * | `AnalysisError`                     | 422    | LLM contract violation       |
   * | `Anthropic.AuthenticationError`     | 502    | Bad Anthropic API key        |
   * | `Anthropic.RateLimitError`          | 503    | Anthropic rate-limited       |
   * | Everything else                     | pass to global error handler    |
   *
   * @param err  - The caught error.
   * @param res  - Express response (for mapped errors).
   * @param next - Forwards unmapped errors to the global error handler.
   */
  private _handleError(err: unknown, res: Response, next: NextFunction): void {
    // ── ScrapingError (Hunter failures) ────────────────────────────────────
    if (err instanceof ScrapingError) {
      const status = err.retryable ? 503 : 502;
      res.status(status).json({
        success:   false,
        error:     status === 503 ? 'Service Unavailable' : 'Bad Gateway',
        message:   err.message,
        retryable: err.retryable,
        platform:  err.platform,
      });
      return;
    }

    // ── AnalysisError (LLM contract violation) ─────────────────────────────
    // This should be rare — allSettled absorbs per-profile failures.
    // Can surface if something throws outside the allSettled loop.
    if (err instanceof AnalysisError) {
      res.status(422).json({
        success: false,
        error:   'Unprocessable Entity',
        message: err.message,
      });
      return;
    }

    // ── Anthropic SDK errors (propagated directly from Analyzer) ──────────
    if (err instanceof Anthropic.AuthenticationError) {
      res.status(502).json({
        success:   false,
        error:     'Bad Gateway',
        message:   'Anthropic API key is invalid or missing. Check ANTHROPIC_API_KEY.',
        retryable: false,
      });
      return;
    }

    if (err instanceof Anthropic.RateLimitError) {
      res.status(503).json({
        success:   false,
        error:     'Service Unavailable',
        message:   'Anthropic API rate limit exceeded. Please retry after a short delay.',
        retryable: true,
      });
      return;
    }

    // ── Unknown error → forward to global Express error handler ───────────
    next(err);
  }
}
