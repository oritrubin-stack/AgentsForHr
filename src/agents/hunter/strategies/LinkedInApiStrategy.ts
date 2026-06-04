/**
 * @file src/agents/hunter/strategies/LinkedInApiStrategy.ts
 * @description LinkedIn scraping strategy backed by an external scraping API
 * (Proxycurl-compatible).
 *
 * Why an external API instead of direct scraping?
 * ─────────────────────────────────────────────────
 * LinkedIn aggressively blocks headless browsers via:
 *  • Login walls on most profile & search pages.
 *  • Bot-detection fingerprinting (TLS, mouse movements, timing).
 *  • Legal Terms of Service restrictions on automated access.
 *
 * Delegating to a dedicated scraping-API vendor (Proxycurl, Apify, etc.)
 * is the only scalable, maintainable, and legally-safer approach.
 *
 * Proxycurl API contract (simplified)
 * ─────────────────────────────────────
 * Endpoint : GET ${LINKEDIN_API_URL}/api/search/person/
 * Auth     : Bearer ${LINKEDIN_API_KEY}  (Authorization header)
 * Params   : keyword, country, page_size, enrich_profiles=enrich
 * Response : { results: ProxycurlPersonResult[], next_page: string | null }
 *
 * See: https://nubela.co/proxycurl/docs#people-api-person-search-endpoint
 *
 * Adapter pattern
 * ────────────────
 * The Proxycurl JSON schema ≠ our domain schema.  `_adapt()` is the single
 * place that maps between them.  When Proxycurl's API changes, only this
 * method needs updating — the rest of the system is insulated.
 *
 * Error handling
 * ───────────────
 * All axios errors are caught and converted to structured {@link ScrapingError}
 * instances.  Specifically:
 *  • HTTP 401 → `ScrapingError.unauthorized`  (non-retryable, bad key)
 *  • HTTP 429 → `ScrapingError.rateLimited`   (retryable, includes Retry-After)
 *  • Other 4xx/5xx → `ScrapingError.unexpectedStatus`
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '../../../config/env';
import {
  JobSearchQuery,
  RawCandidateProfile,
  WorkExperience,
  Education,
  SupportedPlatform,
} from '../../../types/candidate.types';
import {
  IScraperStrategy,
  IHttpClient,
  ScrapingError,
} from './IScraperStrategy';

// ─── Proxycurl response types (external schema) ───────────────────────────────
// These interfaces model the UPSTREAM API shape, not our domain model.
// Keeping them private to this file prevents leaking vendor-specific types
// into the rest of the codebase.

/** A single date object as returned by Proxycurl. */
interface ProxycurlDate {
  day:   number | null;
  month: number | null;
  year:  number | null;
}

/** A work-experience entry in a Proxycurl profile. */
interface ProxycurlExperience {
  starts_at:   ProxycurlDate | null;
  ends_at:     ProxycurlDate | null;
  company:     string | null;
  title:       string | null;
  description: string | null;
  location:    string | null;
}

/** An education entry in a Proxycurl profile. */
interface ProxycurlEducation {
  school:          string | null;
  degree_name:     string | null;
  field_of_study:  string | null;
  ends_at:         ProxycurlDate | null;
  description:     string | null;
}

/** The enriched person profile embedded in each search result. */
interface ProxycurlPersonProfile {
  public_identifier:      string | null;
  linkedin_profile_url:   string | null;
  first_name:             string | null;
  last_name:              string | null;
  full_name:              string | null;
  occupation:             string | null;
  headline:               string | null;
  summary:                string | null;
  city:                   string | null;
  state:                  string | null;
  country_full_name:      string | null;
  experiences:            ProxycurlExperience[]  | null;
  education:              ProxycurlEducation[]   | null;
  skills:                 string[]               | null;
  profile_pic_url:        string | null;
}

/** A single item in the Proxycurl People Search results array. */
interface ProxycurlPersonResult {
  profile:       ProxycurlPersonProfile;
  last_updated:  string | null;
}

/** Top-level response from Proxycurl's People Search endpoint. */
interface ProxycurlSearchResponse {
  results:    ProxycurlPersonResult[];
  next_page:  string | null;
}

// ─── Strategy configuration ───────────────────────────────────────────────────

/** Options accepted by the `LinkedInApiStrategy` constructor. */
export interface LinkedInApiStrategyOptions {
  /**
   * Override the Proxycurl API base URL.
   * Falls back to `env.LINKEDIN_API_URL` when omitted.
   */
  apiBaseUrl?: string;

  /**
   * Override the API key.
   * Falls back to `env.LINKEDIN_API_KEY` when omitted.
   */
  apiKey?: string;

  /**
   * Inject a custom HTTP client.  Pass a mock here in tests to avoid real
   * network calls.  Falls back to a real `axios` instance in production.
   */
  httpClient?: IHttpClient;
}

// ─── Strategy implementation ──────────────────────────────────────────────────

/**
 * Scraping strategy for the `'linkedin'` platform.
 *
 * Delegates all HTTP work to an external Proxycurl-compatible API and adapts
 * the vendor response into our {@link RawCandidateProfile} domain type.
 *
 * @implements {IScraperStrategy}
 *
 * @example Production usage
 * ```ts
 * // No options needed when env vars are set
 * const strategy = new LinkedInApiStrategy();
 * const profiles = await strategy.execute(query);
 * ```
 *
 * @example Test usage with a mocked HTTP client
 * ```ts
 * const strategy = new LinkedInApiStrategy({ httpClient: mockClient });
 * const profiles = await strategy.execute(query);
 * ```
 */
export class LinkedInApiStrategy implements IScraperStrategy {
  /** This strategy handles the 'linkedin' platform exclusively. */
  readonly platform: SupportedPlatform = 'linkedin';

  private readonly apiBaseUrl: string;
  private readonly apiKey:     string;
  private readonly http:       IHttpClient;

  /** Proxycurl's People Search endpoint path. */
  private static readonly SEARCH_PATH = '/api/search/person/';

  /**
   * @param options - Optional overrides for URL, key, and HTTP client.
   * @throws {ScrapingError} at construction time if the API key or URL is missing
   *   and no override was provided — fail fast rather than blowing up on the first
   *   request.
   */
  constructor(options: LinkedInApiStrategyOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? env.LINKEDIN_API_URL;
    this.apiKey     = options.apiKey     ?? env.LINKEDIN_API_KEY;

    // ── Strict validation at construction time ─────────────────────────────
    // We validate here (not in env.ts) so the server can start without these
    // keys when LinkedIn scraping is not in use.  The error is thrown only
    // when someone actually tries to instantiate this strategy.
    if (!this.apiBaseUrl?.trim()) {
      throw new ScrapingError({
        message:  'LINKEDIN_API_URL is not configured. Set it in your .env file.',
        platform: 'linkedin',
        retryable: false,
      });
    }
    if (!this.apiKey?.trim()) {
      throw new ScrapingError({
        message:  'LINKEDIN_API_KEY is not configured. Set it in your .env file.',
        platform: 'linkedin',
        retryable: false,
      });
    }

    // Use the injected client (for tests) or create a real axios instance.
    this.http = options.httpClient ?? this._createAxiosClient();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Calls the Proxycurl People Search API and returns an array of
   * {@link RawCandidateProfile} objects mapped from the vendor response.
   *
   * @param query - Search parameters.
   * @returns Mapped profiles — empty array if the API returned no results.
   * @throws {@link ScrapingError} on HTTP 401, 429, or any other non-2xx code.
   */
  async execute(query: JobSearchQuery): Promise<RawCandidateProfile[]> {
    const url = `${this.apiBaseUrl}${LinkedInApiStrategy.SEARCH_PATH}`;

    const params: Record<string, string | number | boolean | undefined> = {
      keyword:          [query.jobTitle, ...query.keywords].join(' '),
      page_size:        query.maxResults ?? 10,
      enrich_profiles:  'enrich',                   // Ask Proxycurl to include full profiles
      ...(query.location ? { country: query.location } : {}),
    };

    console.log(
      `[LinkedInApiStrategy] Calling ${url} — keyword="${params['keyword']}"`,
    );

    let response: { data: ProxycurlSearchResponse; status: number; headers: Record<string, string> };

    try {
      response = await this.http.get<ProxycurlSearchResponse>(url, {
        headers: {
          Authorization:  `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
        },
        params,
      });
    } catch (err) {
      throw this._handleHttpError(err);
    }

    console.log(
      `[LinkedInApiStrategy] API responded ${response.status} — ` +
      `${response.data.results?.length ?? 0} result(s).`,
    );

    // Map every vendor result to our domain type, silently skipping malformed ones.
    return (response.data.results ?? [])
      .map((result, index) => this._adapt(result, index))
      .filter((p): p is RawCandidateProfile => p !== null);
  }

  // ── Adapter ────────────────────────────────────────────────────────────────

  /**
   * Maps a single Proxycurl `ProxycurlPersonResult` → `RawCandidateProfile`.
   *
   * This is the **adapter layer** — all vendor-specific field-name knowledge
   * is confined to this method.  The rest of the system only sees our domain
   * interface.
   *
   * Returns `null` for results that lack a `linkedin_profile_url` (the
   * primary key) — these are silently discarded.
   *
   * @param result - Raw vendor result object.
   * @param _index - Position in the result array (reserved for future logging).
   */
  private _adapt(
    result: ProxycurlPersonResult,
    _index: number,
  ): RawCandidateProfile | null {
    const p = result.profile;

    // Primary key — discard results without a usable profile URL.
    const profileUrl = p.linkedin_profile_url ?? p.public_identifier;
    if (!profileUrl) return null;

    return {
      profileUrl,
      platform:    'linkedin',
      source:      'LinkedIn',
      name:        p.full_name
                     ?? this._joinName(p.first_name, p.last_name),
      // Proxycurl's free-tier response does not expose personal email/phone.
      // The AnalyzerAgent may extract them from the summary text if present.
      email:       null,
      phone:       null,
      currentRole: p.occupation ?? p.headline ?? null,
      location:    this._buildLocation(p.city, p.country_full_name),
      summary:     p.summary ?? p.headline ?? null,
      skills:      p.skills ?? [],
      experience:  (p.experiences ?? []).map(this._adaptExperience.bind(this)),
      education:   (p.education   ?? []).map(this._adaptEducation.bind(this)),
      scrapedAt:   new Date(),
      rawHtml:     null, // API-based strategy never yields raw HTML
    };
  }

  /**
   * Maps a `ProxycurlExperience` → `WorkExperience`.
   *
   * @param exp - Vendor experience object.
   */
  private _adaptExperience(exp: ProxycurlExperience): WorkExperience {
    return {
      title:       exp.title   ?? 'Unknown Title',
      company:     exp.company ?? 'Unknown Company',
      duration:    this._buildDuration(exp.starts_at, exp.ends_at),
      description: exp.description ?? null,
    };
  }

  /**
   * Maps a `ProxycurlEducation` → `Education`.
   *
   * @param edu - Vendor education object.
   */
  private _adaptEducation(edu: ProxycurlEducation): Education {
    const degree = [edu.degree_name, edu.field_of_study]
      .filter(Boolean)
      .join(', ') || null;

    return {
      degree,
      institution:    edu.school         ?? 'Unknown Institution',
      graduationYear: edu.ends_at?.year != null
                        ? String(edu.ends_at.year)
                        : null,
    };
  }

  // ── Error handling ─────────────────────────────────────────────────────────

  /**
   * Converts an axios error (or any unknown error) into a typed
   * {@link ScrapingError}.
   *
   * @param err - The raw error thrown by axios.
   * @returns A `ScrapingError` with the correct `statusCode`, `retryable` flag,
   *          and `Retry-After` seconds where applicable.
   */
  private _handleHttpError(err: unknown): ScrapingError {
    // ── Typed axios error ─────────────────────────────────────────────────
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError;
      const status   = axiosErr.response?.status;
      const headers  = axiosErr.response?.headers as Record<string, string> | undefined;
      const cause    = axiosErr instanceof Error ? axiosErr : undefined;

      if (status === 401) {
        return ScrapingError.unauthorized('linkedin', cause);
      }

      if (status === 429) {
        // Parse Retry-After header (seconds or HTTP-date — we handle seconds only).
        const retryAfterRaw = headers?.['retry-after'] ?? headers?.['Retry-After'];
        const retryAfterS   = retryAfterRaw != null
          ? parseInt(retryAfterRaw, 10) || undefined
          : undefined;

        return ScrapingError.rateLimited('linkedin', retryAfterS, cause);
      }

      if (status != null) {
        return ScrapingError.unexpectedStatus('linkedin', status, cause);
      }

      // Network-level error (ECONNREFUSED, timeout, DNS failure)
      return new ScrapingError({
        message:   `[linkedin] Network error: ${axiosErr.message}`,
        platform:  'linkedin',
        retryable:  true, // Network blips are generally transient
        cause:      cause,
      });
    }

    // ── Unknown error ─────────────────────────────────────────────────────
    const cause = err instanceof Error ? err : undefined;
    return new ScrapingError({
      message:   `[linkedin] Unexpected error: ${String(err)}`,
      platform:  'linkedin',
      retryable:  false,
      cause,
    });
  }

  // ── Private utilities ──────────────────────────────────────────────────────

  /**
   * Creates a pre-configured `axios` instance with sensible defaults for
   * Proxycurl API calls.
   */
  private _createAxiosClient(): AxiosInstance {
    return axios.create({
      timeout:        15_000, // 15 s — Proxycurl can be slow on first call
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /**
   * Assembles a location string from city and country parts.
   * Returns `null` when both are absent.
   *
   * @example `_buildLocation('Tel Aviv', 'Israel')` → `'Tel Aviv, Israel'`
   */
  private _buildLocation(
    city:    string | null | undefined,
    country: string | null | undefined,
  ): string | null {
    const parts = [city, country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Builds a human-readable duration string from Proxycurl date objects.
   *
   * @example `_buildDuration({year:2020}, null)` → `'2020 – Present'`
   * @example `_buildDuration({year:2018}, {year:2022})` → `'2018 – 2022'`
   */
  private _buildDuration(
    start: ProxycurlDate | null | undefined,
    end:   ProxycurlDate | null | undefined,
  ): string | null {
    if (!start?.year) return null;
    const endStr = end?.year != null ? String(end.year) : 'Present';
    return `${start.year} – ${endStr}`;
  }

  /**
   * Joins first and last name, skipping nulls.
   * Returns `null` when both parts are absent.
   */
  private _joinName(
    first: string | null | undefined,
    last:  string | null | undefined,
  ): string | null {
    const parts = [first, last].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  }
}
