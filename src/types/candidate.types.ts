/**
 * @file src/types/candidate.types.ts
 * @description Domain types for candidate discovery and profile representation.
 *
 * These interfaces form the **shared contract** between every layer of the
 * Multi-Agent system:
 *
 *  • The **Hunter Agent** produces `RawCandidateProfile` values from web scraping.
 *  • The **Ranker / Screener Agents** consume them and emit enriched variants.
 *  • The **API layer** serialises them into HTTP responses.
 *
 * Design rules
 * ─────────────
 * • All fields that may be absent from a real scrape are explicitly `| null`
 *   rather than optional (`?`).  This forces consuming code to make the
 *   null-case explicit rather than accidentally ignoring it.
 * • Optional (`?`) is reserved for fields that are genuinely never scraped
 *   from certain platforms (i.e. the field does not exist in the source).
 * • No `any` — every field has a precise type so callers get full IDE support.
 */

// ─── Search / Query types ────────────────────────────────────────────────────

/**
 * The platforms the Hunter Agent can target.
 *
 * Extend this union when new platform-specific scrapers are added.
 */
export type SupportedPlatform =
  | 'linkedin'
  | 'github'
  | 'stackoverflow'
  | 'glassdoor'
  | 'indeed'
  | 'email'  // Inbound: candidates arrive via IMAP / Outlook inbox (CVs, applications)
  | 'mock';  // Used in tests / dry-runs without a real browser session

/**
 * Input parameters that drive a candidate search session.
 *
 * Passed directly to `HunterAgent.hunt()`.
 *
 * @example
 * ```ts
 * const query: JobSearchQuery = {
 *   jobTitle:  'Senior TypeScript Engineer',
 *   keywords:  ['Node.js', 'LangChain', 'multi-agent'],
 *   platform:  'linkedin',
 *   location:  'Tel Aviv',
 *   maxResults: 20,
 * };
 * ```
 */
export interface JobSearchQuery {
  /**
   * The target role or job title to search for.
   * @example "Senior Backend Engineer", "ML Engineer"
   */
  jobTitle: string;

  /**
   * Additional skill or technology keywords to narrow the search.
   * These are injected into the platform's search query string.
   * @example ['Node.js', 'TypeScript', 'AWS']
   */
  keywords: string[];

  /**
   * The platform to scrape.
   * The Hunter Agent selects the appropriate scraping strategy based on this.
   */
  platform: SupportedPlatform;

  /**
   * Optional geographic filter.
   * Not all platforms support location filtering — the agent ignores it
   * gracefully when unsupported.
   * @example "New York", "Remote", "Tel Aviv, Israel"
   */
  location?: string;

  /**
   * Maximum number of candidate profiles to return.
   * The agent will stop scraping once this limit is reached.
   * Defaults to 10 inside `HunterAgent` if omitted.
   */
  maxResults?: number;

  /**
   * Optional arbitrary metadata the caller wants to attach to this query.
   * Useful for tracing (e.g. job-req ID, pipeline run ID).
   */
  meta?: Record<string, unknown>;
}

// ─── Profile types ───────────────────────────────────────────────────────────

/**
 * A work experience entry extracted from a candidate's profile.
 */
export interface WorkExperience {
  /** Job title / role at this position. */
  title: string;
  /** Employer / company name. */
  company: string;
  /**
   * Free-text duration string as it appears on the platform.
   * @example "Jan 2021 – Present", "2 years 3 months"
   */
  duration: string | null;
  /** Short description or bullet points for the role, if available. */
  description: string | null;
}

/**
 * An educational credential extracted from a candidate's profile.
 */
export interface Education {
  /** Degree or qualification name. @example "B.Sc. Computer Science" */
  degree: string | null;
  /** Institution name. */
  institution: string;
  /**
   * Graduation year or free-text date range as shown on the platform.
   * @example "2018", "2015 – 2019"
   */
  graduationYear: string | null;
}

/**
 * The raw, unvalidated candidate profile produced by the Hunter Agent
 * immediately after scraping.
 *
 * "Raw" signals that this data has **not** been:
 *  • Deduplicated against existing records.
 *  • Validated for completeness.
 *  • Enriched by secondary agents (Ranker, Screener).
 *
 * Downstream agents are responsible for those steps.  This keeps the Hunter
 * Agent focused on a single responsibility: data extraction.
 *
 * @example
 * ```ts
 * const profile: RawCandidateProfile = {
 *   profileUrl:  'https://linkedin.com/in/jdoe',
 *   platform:    'linkedin',
 *   name:        'Jane Doe',
 *   currentRole: 'Senior Engineer @ Acme',
 *   location:    'Tel Aviv',
 *   summary:     'Passionate about distributed systems…',
 *   skills:      ['TypeScript', 'Node.js', 'Kubernetes'],
 *   experience:  [],
 *   education:   [],
 *   scrapedAt:   new Date(),
 *   rawHtml:     null,
 * };
 * ```
 */
export interface RawCandidateProfile {
  /**
   * Canonical URL of the candidate's public profile on the source platform.
   * For email-sourced candidates this is a synthetic URI derived from the
   * email Message-ID, e.g. `email://<messageId>`.
   * This is the primary key used for deduplication.
   */
  profileUrl: string;

  /** Platform from which this profile was scraped or received. */
  platform: SupportedPlatform;

  /**
   * Human-readable source label that identifies where this candidate came from.
   *
   * For platform-sourced candidates this mirrors the platform name (e.g.
   * `'LinkedIn'`, `'GitHub'`).  For email-inbound candidates it is derived
   * intelligently from the sender domain / subject line (e.g. `'Drushim IL'`,
   * `'Facebook Jobs'`, `'Direct Email'`).
   *
   * @example 'LinkedIn', 'Drushim IL', 'GitHub', 'Facebook Jobs', 'Direct Email'
   */
  source: string;

  /**
   * Contact email address extracted from the profile or CV text.
   * `null` when no email address was found in the source material.
   */
  email: string | null;

  /**
   * Contact phone number extracted from the profile or CV text.
   * Stored as a raw string (no normalisation) to preserve the candidate's
   * original formatting.  `null` when no phone number was found.
   * @example '+972-54-123-4567', '054 123 4567', '+1 (415) 555-0123'
   */
  phone: string | null;

  /** Full display name as it appears on the profile page. */
  name: string | null;

  /**
   * Current job title and/or company as shown in the profile header.
   * @example "Senior Engineer @ Acme Corp"
   */
  currentRole: string | null;

  /**
   * Self-reported location (city, country, or remote).
   * @example "Tel Aviv, Israel", "Remote"
   */
  location: string | null;

  /**
   * Bio / "About" section text.
   * May be very long; downstream agents should truncate before passing to LLMs.
   */
  summary: string | null;

  /**
   * Flat list of skills / technologies extracted from the profile.
   * Deduplication and normalisation are done by downstream agents.
   */
  skills: string[];

  /**
   * Chronological list of work experience entries.
   * Empty array when the platform doesn't expose this data or the section is
   * absent from the profile.
   */
  experience: WorkExperience[];

  /**
   * Educational background entries, most recent first.
   */
  education: Education[];

  /**
   * UTC timestamp when this profile was scraped.
   * Used to invalidate stale cache entries.
   */
  scrapedAt: Date;

  /**
   * The raw HTML of the profile page, if the scraper was configured to
   * preserve it.  Kept for debugging and re-parsing without a second HTTP
   * request.  `null` when `HunterAgent` is run without the `captureHtml`
   * option.
   */
  rawHtml: string | null;
}

// ─── Analyzed / enriched candidate ──────────────────────────────────────────

/**
 * A `RawCandidateProfile` enriched by the **Analyzer Agent**.
 *
 * After the Hunter Agent discovers a raw profile, the Analyzer Agent calls
 * Claude to evaluate the candidate against the open job and appends four
 * AI-generated fields.  The rest of the profile data is preserved verbatim.
 *
 * @example
 * ```ts
 * const analyzed: AnalyzedCandidate = await analyzerAgent.analyze(raw, query);
 * // analyzed.matchScore  → 78
 * // analyzed.aiSummary   → "Strong Node.js background …"
 * // analyzed.greenFlags  → ["8 years Node.js", "Open-source contributor"]
 * // analyzed.redFlags    → ["No TypeScript experience listed"]
 * ```
 */
export interface AnalyzedCandidate extends RawCandidateProfile {
  /**
   * Overall fit score between 0 and 100.
   *
   * Scoring rubric (applied by the LLM):
   *  • 80–100 — Excellent match; meets / exceeds all key requirements.
   *  • 60–79  — Good match; meets most requirements, minor gaps.
   *  • 40–59  — Partial match; relevant background but notable skill gaps.
   *  • 0–39   — Weak match; fundamentally misaligned with the role.
   */
  matchScore: number;

  /**
   * 2–4 sentence AI-generated summary explaining the score.
   * Should be written as a concise executive briefing a recruiter can skim.
   */
  aiSummary: string;

  /**
   * Positive signals that support hiring this candidate.
   * Each entry is a short, evidence-based phrase (not a full sentence).
   * @example ["10 years TypeScript", "Ex-FAANG", "LangChain OSS contributor"]
   */
  greenFlags: string[];

  /**
   * Risks or gaps that may disqualify or concern the hiring team.
   * Each entry is a short, actionable phrase.
   * @example ["No leadership experience", "React not mentioned", "Short tenure at 3 companies"]
   */
  redFlags: string[];
}

// ─── Result / error envelope ─────────────────────────────────────────────────

/**
 * Wrapper returned by `HunterAgent.hunt()`.
 *
 * Using a result envelope (rather than a plain array) lets callers distinguish
 * between a partial success (some profiles scraped before a soft error) and a
 * total failure.
 */
export interface HuntResult {
  /** Successfully scraped profiles. */
  profiles: RawCandidateProfile[];

  /**
   * The query that produced these results — echoed back for traceability
   * in logs and downstream agent pipelines.
   */
  query: JobSearchQuery;

  /**
   * Non-fatal errors encountered during scraping (e.g. one page timed out
   * but others succeeded).  An empty array means a clean run.
   */
  warnings: string[];

  /**
   * ISO-8601 timestamp when the hunt session started.
   * Useful for monitoring scrape duration.
   */
  startedAt: string;

  /** ISO-8601 timestamp when the hunt session completed. */
  completedAt: string;
}
