/**
 * @file src/agents/hunter/strategies/IScraperStrategy.ts
 * @description Strategy interface that every platform-specific scraper must implement.
 *
 * Design: Strategy Pattern
 * ────────────────────────
 * `HunterAgent` depends on this interface, **not** on concrete implementations.
 * This satisfies the Dependency Inversion Principle (SOLID "D"):
 *
 *   HunterAgent  →  IScraperStrategy  ←  LinkedInApiStrategy
 *                                     ←  GitHubStrategy          (future)
 *                                     ←  StackOverflowStrategy   (future)
 *
 * Adding a new platform
 * ──────────────────────
 * 1. Create `src/agents/hunter/strategies/<Platform>Strategy.ts`.
 * 2. `implements IScraperStrategy` with the `execute()` method.
 * 3. Register the strategy in `HunterAgent`'s constructor call site.
 * 4. Done — `HunterAgent` source itself never changes.
 *
 * Contract guarantees
 * ────────────────────
 * • `execute()` MUST throw {@link ScrapingError} for all recoverable external
 *   failures (auth, rate-limit, upstream errors).  Generic `Error` is reserved
 *   for programming errors (e.g. mis-configured strategy).
 * • `execute()` returns an empty array instead of `null` / `undefined` when no
 *   candidates were found — callers should never need to null-check the return.
 * • `platform` is `readonly` so the registry can index strategies by platform
 *   without additional metadata.
 */

import { SupportedPlatform, JobSearchQuery, RawCandidateProfile } from '../../../types/candidate.types';
import { ScrapingError } from '../../../errors/ScrapingError';

/**
 * Minimal HTTP client abstraction used by strategies.
 *
 * Declaring our own interface (rather than importing `AxiosInstance` directly)
 * keeps strategies decoupled from axios and makes unit-testing trivial:
 * inject any object that satisfies this shape — no mocking library required.
 *
 * An `AxiosInstance` satisfies this interface out of the box.
 *
 * @template TResponse - Expected response body shape.
 */
export interface IHttpClient {
  /**
   * Makes a GET request and returns the response data and status.
   *
   * @param url    - Absolute URL to request.
   * @param config - Optional request configuration (headers, query params).
   * @throws For non-2xx responses axios throws — strategies must catch and
   *         convert to {@link ScrapingError}.
   */
  get<TResponse = unknown>(
    url: string,
    config?: {
      headers?: Record<string, string>;
      params?:  Record<string, string | number | boolean | undefined>;
    },
  ): Promise<{ data: TResponse; status: number; headers: Record<string, string> }>;
}

/**
 * Contract every platform-specific scraping strategy must fulfil.
 *
 * @example
 * ```ts
 * class MyStrategy implements IScraperStrategy {
 *   readonly platform = 'myplatform' as const;
 *
 *   async execute(query: JobSearchQuery): Promise<RawCandidateProfile[]> {
 *     // ... call external API, map result, return profiles
 *   }
 * }
 * ```
 */
export interface IScraperStrategy {
  /**
   * The platform this strategy handles.
   * Used as the lookup key in `HunterAgent`'s strategy registry.
   */
  readonly platform: SupportedPlatform;

  /**
   * Executes the scraping/search logic for a given query.
   *
   * @param query - Search parameters (title, keywords, location, maxResults).
   * @returns Array of raw candidate profiles.  Never `null`; returns `[]` if
   *          no candidates were found.
   * @throws {@link ScrapingError} on all recoverable upstream failures
   *         (auth errors, rate limits, unexpected HTTP status codes).
   * @throws `Error` on unrecoverable programming errors.
   */
  execute(query: JobSearchQuery): Promise<RawCandidateProfile[]>;
}

// Re-export ScrapingError here so strategy implementers can import everything
// they need from this single module.
export { ScrapingError };
