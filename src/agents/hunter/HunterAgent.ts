/**
 * @file src/agents/hunter/HunterAgent.ts
 * @description The Hunter Agent — orchestrates candidate discovery across platforms.
 *
 * Architecture position
 * ──────────────────────
 * ```
 *   HTTP Layer (Express)
 *        │
 *   Service Layer  ◄── orchestrates agents
 *        │
 *   ► HunterAgent  ◄── you are here
 *        │  │
 *        │  └─ IScraperStrategy registry
 *        │        ├── LinkedInApiStrategy  (axios → Proxycurl)
 *        │        └── [future strategies…]
 *        │
 *   PlaywrightService  ◄── browser-based strategies (GitHub, etc.)
 * ```
 *
 * Strategy dispatch — two tiers
 * ───────────────────────────────
 * Tier 1 — **Registry** (preferred): if an `IScraperStrategy` is registered for
 *   the requested platform, delegate entirely to it.  The strategy owns its own
 *   HTTP client, error handling, and adapter logic.
 *
 * Tier 2 — **Built-in browser strategies** (fallback): GitHub and mock platforms
 *   are implemented directly inside the agent using Playwright.  These are used
 *   when no registered strategy exists for the platform.
 *
 * Single Responsibility
 * ─────────────────────
 * The Hunter Agent owns exactly ONE concern: **given a search query, return
 * an array of raw candidate profiles**.  It does NOT:
 *  • Rank, score, or filter candidates — that belongs to the Ranker Agent.
 *  • Validate profiles for completeness — that belongs to the Screener Agent.
 *  • Persist data to a database — that belongs to a repository / service.
 *  • Know anything about HTTP or Express.
 */

import { Page } from 'playwright';
import { PlaywrightService } from '../../services/scraper/PlaywrightService';
import {
  JobSearchQuery,
  RawCandidateProfile,
  HuntResult,
  SupportedPlatform,
  WorkExperience,
  Education,
} from '../../types/candidate.types';
import { IScraperStrategy } from './strategies/IScraperStrategy';

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Fine-tuning options for a single `hunt()` call.
 * All fields are optional — reasonable defaults are applied inside the agent.
 */
export interface HuntOptions {
  /**
   * Whether to capture the raw HTML of each profile page (browser strategies only).
   * Has no effect on API-backed strategies (e.g. LinkedIn).
   * @default false
   */
  captureHtml?: boolean;

  /**
   * Milliseconds to wait between page navigations (browser strategies only).
   * @default 1200
   */
  delayBetweenRequestsMs?: number;
}

const DEFAULT_HUNT_OPTIONS: Required<HuntOptions> = {
  captureHtml:            false,
  delayBetweenRequestsMs: 1_200,
};

const DEFAULT_MAX_RESULTS = 10;

/**
 * Map of platform → registered strategy instance.
 * Strategies in this map take priority over the built-in browser methods.
 */
export type StrategyRegistry = Partial<Record<SupportedPlatform, IScraperStrategy>>;

// ─── Agent class ─────────────────────────────────────────────────────────────

/**
 * The Hunter Agent.
 *
 * Discovers and extracts raw candidate profiles from web platforms.  Uses a
 * **strategy registry** to dispatch to platform-specific implementations, with
 * a Playwright browser as the fallback for platforms without a registered
 * strategy.
 *
 * @example — with LinkedIn strategy registered
 * ```ts
 * import { PlaywrightService }     from '../../services/scraper/PlaywrightService';
 * import { LinkedInApiStrategy }   from './strategies/LinkedInApiStrategy';
 *
 * const hunter = new HunterAgent(
 *   new PlaywrightService(),
 *   { linkedin: new LinkedInApiStrategy() },
 * );
 *
 * const result = await hunter.hunt({
 *   jobTitle:   'Senior TypeScript Engineer',
 *   keywords:   ['Node.js', 'LangChain'],
 *   platform:   'linkedin',
 *   maxResults: 10,
 * });
 * ```
 *
 * @example — mock-only (no external API, no real browser)
 * ```ts
 * const hunter = new HunterAgent(new PlaywrightService());
 * const result = await hunter.hunt({ ..., platform: 'mock' });
 * ```
 */
export class HunterAgent {
  /** Browser lifecycle manager (used by Playwright-based strategies). */
  private readonly playwright: PlaywrightService;

  /**
   * Registry of platform-specific strategies.
   * Strategies registered here take precedence over the built-in browser methods.
   */
  private readonly strategies: StrategyRegistry;

  /**
   * @param playwrightService - Browser manager for Playwright-based platforms.
   * @param strategies        - Optional map of platform → `IScraperStrategy`.
   *   Pass strategy instances here to override the built-in browser methods
   *   for specific platforms.
   */
  constructor(
    playwrightService: PlaywrightService,
    strategies: StrategyRegistry = {},
  ) {
    this.playwright = playwrightService;
    this.strategies = strategies;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Executes a candidate-discovery session for the given search query.
   *
   * Dispatch order:
   *  1. If a registered {@link IScraperStrategy} exists for `query.platform`,
   *     delegate to it directly (no browser opened).
   *  2. Otherwise, open a headless browser via {@link PlaywrightService} and
   *     use the built-in browser strategy for the platform.
   *
   * The browser (if opened) is always closed when this method returns, whether
   * it succeeded or threw.
   *
   * @param query   - What to search for and where.
   * @param options - Optional per-hunt tuning.
   * @returns A {@link HuntResult} envelope containing profiles and metadata.
   * @throws {@link ScrapingError} if a registered strategy encounters an
   *         unrecoverable external API failure.
   * @throws `Error` if the browser cannot be launched.
   */
  async hunt(
    query: JobSearchQuery,
    options: HuntOptions = {},
  ): Promise<HuntResult> {
    const opts: Required<HuntOptions> = { ...DEFAULT_HUNT_OPTIONS, ...options };
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    this._validateQuery(query);

    console.log(
      `[HunterAgent] Starting hunt — platform="${query.platform}" ` +
      `title="${query.jobTitle}" keywords=[${query.keywords.join(', ')}]`,
    );

    let profiles: RawCandidateProfile[];

    const registeredStrategy = this.strategies[query.platform];

    if (registeredStrategy) {
      // ── Tier 1: Registered strategy (no browser needed) ─────────────────
      console.log(
        `[HunterAgent] Using registered strategy for platform="${query.platform}".`,
      );
      profiles = await registeredStrategy.execute(query);

    } else {
      // ── Tier 2: Built-in browser strategy ───────────────────────────────
      console.log(
        `[HunterAgent] No registered strategy for "${query.platform}". ` +
        `Falling back to browser-based implementation.`,
      );
      profiles = await this.playwright.withPage(async (page: Page) => {
        return this._dispatchBrowserStrategy(page, query, opts, warnings);
      });
    }

    const completedAt = new Date().toISOString();

    console.log(
      `[HunterAgent] Hunt complete — found ${profiles.length} profile(s). ` +
      `Warnings: ${warnings.length}`,
    );

    return { profiles, query, warnings, startedAt, completedAt };
  }

  // ── Browser strategy dispatcher ────────────────────────────────────────────

  /**
   * Routes the hunt to the correct **built-in** browser strategy.
   * Only called when no `IScraperStrategy` is registered for the platform.
   */
  private async _dispatchBrowserStrategy(
    page: Page,
    query: JobSearchQuery,
    options: Required<HuntOptions>,
    warnings: string[],
  ): Promise<RawCandidateProfile[]> {
    switch (query.platform) {
      case 'mock':
        return this._scrapeMock(query, options);

      case 'github':
        return this._scrapeGitHub(page, query, options, warnings);

      // Platforms with registered strategies should never reach here.
      // If they do (e.g. strategy accidentally omitted at construction time),
      // warn and fall back to mock data to keep the pipeline running.
      case 'linkedin':
      case 'stackoverflow':
      case 'glassdoor':
      case 'indeed':
      case 'email':   // Handled by OutlookImapStrategy in the strategy registry
        warnings.push(
          `Platform "${query.platform}" has no registered strategy and no ` +
          `built-in browser implementation. Falling back to mock data. ` +
          `Register a strategy in the HunterAgent constructor.`,
        );
        return this._scrapeMock(query, options);

      default: {
        const unreachable: never = query.platform;
        throw new Error(
          `[HunterAgent] Unknown platform: "${unreachable as string}"`,
        );
      }
    }
  }

  // ── Built-in browser strategies ────────────────────────────────────────────

  /**
   * **Mock strategy** — returns deterministic synthetic data without opening
   * any URLs.  Used in tests, CI, and dry-run demonstrations.
   */
  private _scrapeMock(
    query: JobSearchQuery,
    options: Required<HuntOptions>,
  ): RawCandidateProfile[] {
    const count = Math.min(query.maxResults ?? DEFAULT_MAX_RESULTS, 5);

    return Array.from({ length: count }, (_, i): RawCandidateProfile => {
      const index = i + 1;
      return {
        profileUrl:  `https://mock-platform.example.com/profiles/candidate-${index}`,
        platform:    'mock',
        source:      'Mock',
        name:        `Mock Candidate ${index}`,
        email:       null,
        phone:       null,
        currentRole: `${query.jobTitle} @ MockCorp ${index}`,
        location:    query.location ?? 'Remote',
        summary:
          `Experienced ${query.jobTitle} with a strong background in ` +
          `${query.keywords.slice(0, 3).join(', ')}. ` +
          `Synthetic data generated by the mock strategy.`,
        skills:      [...query.keywords, 'TypeScript', 'Node.js', 'Git'],
        experience:  this._mockExperience(query.jobTitle, index),
        education:   this._mockEducation(index),
        scrapedAt:   new Date(),
        rawHtml:     options.captureHtml
                       ? `<html><!-- mock HTML for profile ${index} --></html>`
                       : null,
      };
    });
  }

  /**
   * **GitHub strategy** — uses the public GitHub Users Search API via Playwright.
   */
  private async _scrapeGitHub(
    page: Page,
    query: JobSearchQuery,
    options: Required<HuntOptions>,
    warnings: string[],
  ): Promise<RawCandidateProfile[]> {
    const profiles: RawCandidateProfile[] = [];
    const maxResults = Math.min(query.maxResults ?? DEFAULT_MAX_RESULTS, 5);

    try {
      const searchQuery = encodeURIComponent(
        [query.jobTitle, ...query.keywords, query.location ?? ''].join(' ').trim(),
      );
      const apiUrl =
        `https://api.github.com/search/users?q=${searchQuery}+type:user&per_page=${maxResults}`;

      await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });

      const rawJson = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        return pre ? pre.textContent ?? '' : '';
      });

      const parsed = JSON.parse(rawJson) as GitHubSearchResponse;

      if (parsed.items && Array.isArray(parsed.items)) {
        for (const item of parsed.items.slice(0, maxResults)) {
          profiles.push({
            profileUrl:  item.html_url,
            platform:    'github',
            source:      'GitHub',
            name:        item.login,
            email:       null,
            phone:       null,
            currentRole: null,
            location:    null,
            summary:     `GitHub user: ${item.login}. Score: ${item.score}`,
            skills:      query.keywords,
            experience:  [],
            education:   [],
            scrapedAt:   new Date(),
            rawHtml:     options.captureHtml ? await page.content() : null,
          });
          await this._delay(options.delayBetweenRequestsMs);
        }
      } else {
        warnings.push('GitHub API returned no items. Rate limit may have been reached.');
      }

    } catch (err) {
      const msg = `GitHub scraper failed: ${(err as Error).message}`;
      warnings.push(msg);
      console.warn(`[HunterAgent] ${msg}`);
    }

    return profiles;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private _validateQuery(query: JobSearchQuery): void {
    if (!query.jobTitle?.trim()) {
      throw new Error('[HunterAgent] query.jobTitle is required and must be non-empty.');
    }
    if (!Array.isArray(query.keywords)) {
      throw new Error('[HunterAgent] query.keywords must be an array (can be empty).');
    }
    if (!query.platform) {
      throw new Error('[HunterAgent] query.platform is required.');
    }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _mockExperience(jobTitle: string, seed: number): WorkExperience[] {
    return [
      {
        title:       jobTitle,
        company:     `MockCorp ${seed}`,
        duration:    '2022 – Present',
        description: `Led development of scalable services as a ${jobTitle}.`,
      },
      {
        title:       'Software Engineer',
        company:     `StartupCo ${seed * 2}`,
        duration:    '2019 – 2022',
        description: 'Built full-stack features in a fast-paced startup environment.',
      },
    ];
  }

  private _mockEducation(seed: number): Education[] {
    return [
      {
        degree:         'B.Sc. Computer Science',
        institution:    `University of Mock ${seed}`,
        graduationYear: String(2015 + (seed % 5)),
      },
    ];
  }
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface GitHubSearchResponse {
  total_count?: number;
  items?: Array<{ login: string; html_url: string; score: number }>;
}
