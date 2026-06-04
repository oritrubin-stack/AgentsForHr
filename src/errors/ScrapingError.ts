/**
 * @file src/errors/ScrapingError.ts
 * @description Domain-level error class for all scraping / external-API failures.
 *
 * Why a custom error class?
 * ──────────────────────────
 * Generic `Error` objects carry only a message.  Scraping failures need richer
 * context so the error-handling layer can make intelligent decisions:
 *  • Is this retryable?  (transient network blip vs hard auth failure)
 *  • Which platform failed?  (for per-platform circuit-breakers / alerting)
 *  • What HTTP status code did the upstream API return?  (for 429 backoff logic)
 *
 * Usage
 * ──────
 * ```ts
 * throw new ScrapingError({
 *   message:    'LinkedIn API rate limit exceeded.',
 *   platform:   'linkedin',
 *   statusCode: 429,
 *   retryable:  true,
 * });
 * ```
 *
 * Catching with instanceof
 * ─────────────────────────
 * ```ts
 * try {
 *   await strategy.execute(query);
 * } catch (err) {
 *   if (err instanceof ScrapingError && err.retryable) {
 *     // schedule retry with exponential back-off
 *   }
 * }
 * ```
 */

import { SupportedPlatform } from '../types/candidate.types';

// ─── Well-known HTTP status codes used in scraping contexts ─────────────────

/** HTTP status codes the scraper handles explicitly. */
export const HTTP_STATUS = {
  UNAUTHORIZED:        401,
  FORBIDDEN:           403,
  NOT_FOUND:           404,
  TOO_MANY_REQUESTS:   429,
  INTERNAL_SERVER_ERR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatusCode = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

// ─── ScrapingError constructor options ───────────────────────────────────────

export interface ScrapingErrorOptions {
  /**
   * Human-readable description of what went wrong.
   * Include the original upstream message where possible.
   */
  message: string;

  /**
   * The platform that raised this error.
   * Used for per-platform alerting and circuit-breaker logic.
   */
  platform: SupportedPlatform;

  /**
   * HTTP status code returned by the upstream API, if available.
   * `null` for non-HTTP errors (e.g. DNS failures, timeouts).
   */
  statusCode?: number | null;

  /**
   * Whether the operation that caused this error can be safely retried.
   *
   * General rules:
   *  • `true`  — transient failures: 429 (rate limit), 503 (upstream down), timeout
   *  • `false` — permanent failures: 401 (bad key), 403 (blocked), 404 (not found)
   *
   * @default false
   */
  retryable?: boolean;

  /**
   * The original error that triggered this `ScrapingError`.
   * Preserved in `cause` so the full stack trace is reachable.
   */
  cause?: Error;

  /**
   * Optional key-value context attached to the error for structured logging.
   * @example { profileUrl: 'https://linkedin.com/in/jdoe', attempt: 2 }
   */
  context?: Record<string, unknown>;
}

// ─── ScrapingError class ─────────────────────────────────────────────────────

/**
 * Structured error thrown by scraper strategies when an external API call
 * fails in a way that requires explicit handling by the caller.
 *
 * Extends the built-in `Error` so it works seamlessly with `instanceof`,
 * `try/catch`, and Node.js `unhandledRejection` handlers.
 */
export class ScrapingError extends Error {
  /** Always `'ScrapingError'` — lets you discriminate in logs without `instanceof`. */
  readonly name = 'ScrapingError' as const;

  /** Platform that raised this error. */
  readonly platform: SupportedPlatform;

  /**
   * HTTP status code from the upstream API.
   * `null` for non-HTTP failures.
   */
  readonly statusCode: number | null;

  /**
   * Whether it is safe to retry the failed operation.
   * The caller is responsible for implementing back-off logic.
   */
  readonly retryable: boolean;

  /**
   * The original lower-level error, if available.
   * Matches the TC39 `Error.cause` proposal (Node ≥ 16.9).
   * Note: `override` is omitted because `Error.cause` is only part of ES2022
   * lib; our target is ES2020.
   */
  readonly cause?: Error;

  /** Arbitrary structured context for logging / observability. */
  readonly context: Record<string, unknown>;

  constructor(options: ScrapingErrorOptions) {
    super(options.message);

    this.platform   = options.platform;
    this.statusCode = options.statusCode ?? null;
    this.retryable  = options.retryable ?? false;
    this.cause      = options.cause;
    this.context    = options.context ?? {};

    // Fix prototype chain so `instanceof ScrapingError` works after transpilation.
    Object.setPrototypeOf(this, ScrapingError.prototype);

    // Capture a clean stack trace pointing at the throw site, not the constructor.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ScrapingError);
    }
  }

  // ── Factory helpers ────────────────────────────────────────────────────────

  /**
   * Creates a `ScrapingError` for HTTP 401 Unauthorized.
   * Always non-retryable — the API key is invalid and retrying won't help.
   *
   * @param platform - Platform that returned the 401.
   * @param cause    - Original axios error.
   */
  static unauthorized(platform: SupportedPlatform, cause?: Error): ScrapingError {
    return new ScrapingError({
      message:    `[${platform}] API key is invalid or missing (HTTP 401). ` +
                  `Check the ${platform.toUpperCase()}_API_KEY environment variable.`,
      platform,
      statusCode: HTTP_STATUS.UNAUTHORIZED,
      retryable:  false,
      cause,
    });
  }

  /**
   * Creates a `ScrapingError` for HTTP 429 Too Many Requests.
   * Always retryable — the caller should back off and try again later.
   *
   * @param platform    - Platform that returned the 429.
   * @param retryAfterS - Optional `Retry-After` header value in seconds.
   * @param cause       - Original axios error.
   */
  static rateLimited(
    platform: SupportedPlatform,
    retryAfterS?: number,
    cause?: Error,
  ): ScrapingError {
    const retryHint = retryAfterS != null
      ? ` Retry after ${retryAfterS}s.`
      : ' Back off before retrying.';

    return new ScrapingError({
      message:    `[${platform}] Rate limit exceeded (HTTP 429).${retryHint}`,
      platform,
      statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
      retryable:  true,
      cause,
      context:    retryAfterS != null ? { retryAfterSeconds: retryAfterS } : {},
    });
  }

  /**
   * Creates a `ScrapingError` for an unexpected HTTP status code.
   *
   * @param platform   - Source platform.
   * @param statusCode - The unexpected status code.
   * @param cause      - Original axios error.
   */
  static unexpectedStatus(
    platform: SupportedPlatform,
    statusCode: number,
    cause?: Error,
  ): ScrapingError {
    const retryable = statusCode >= 500; // 5xx are generally transient
    return new ScrapingError({
      message:    `[${platform}] Unexpected HTTP ${statusCode} from upstream API.`,
      platform,
      statusCode,
      retryable,
      cause,
    });
  }

  /**
   * Serialises the error to a plain object suitable for structured logging
   * (e.g. Winston / Pino JSON transport).
   */
  toJSON(): Record<string, unknown> {
    return {
      name:       this.name,
      message:    this.message,
      platform:   this.platform,
      statusCode: this.statusCode,
      retryable:  this.retryable,
      context:    this.context,
      stack:      this.stack,
      cause:      this.cause?.message,
    };
  }
}
