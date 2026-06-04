/**
 * @file src/agents/hunter/strategies/linkedin.strategy.smoke.ts
 * @description Smoke tests for LinkedInApiStrategy — no real network calls.
 *
 * Testing approach: manual mock injection (zero test-framework dependencies)
 * ────────────────────────────────────────────────────────────────────────────
 * Because `LinkedInApiStrategy` accepts an `IHttpClient` via its constructor,
 * we inject a plain in-memory object whose `get()` method returns pre-defined
 * fixture data.  This is intentionally kept framework-free so it runs with
 * `ts-node` alone:
 *
 *   npx ts-node src/agents/hunter/strategies/linkedin.strategy.smoke.ts
 *
 * Tests covered
 * ──────────────
 *  1. Happy path   — Proxycurl response is correctly adapted to RawCandidateProfile.
 *  2. Empty result — API returns zero results → empty array returned (no throw).
 *  3. HTTP 401     — ScrapingError thrown, non-retryable.
 *  4. HTTP 429     — ScrapingError thrown, retryable, Retry-After propagated.
 *  5. Network err  — Non-HTTP failure wrapped in retryable ScrapingError.
 */

import { AxiosError } from 'axios';
import { LinkedInApiStrategy }            from './LinkedInApiStrategy';
import { ScrapingError, IHttpClient }     from './IScraperStrategy';
import { JobSearchQuery, RawCandidateProfile } from '../../../types/candidate.types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label: string, reason: string): void {
  console.error(`  ❌  ${label} — ${reason}`);
  failed++;
}

/**
 * Micro-assertion helpers.
 * We intentionally avoid an assertion library to keep the smoke test self-contained.
 */
function assert(label: string, condition: boolean, detail = ''): void {
  condition ? pass(label) : fail(label, detail || 'assertion failed');
}

function assertThrowsScrapingError(
  label: string,
  err: unknown,
  expectedStatus: number | null,
  expectedRetryable: boolean,
): void {
  if (!(err instanceof ScrapingError)) {
    fail(label, `Expected ScrapingError but got: ${String(err)}`);
    return;
  }
  if (err.statusCode !== expectedStatus) {
    fail(label, `Expected statusCode=${expectedStatus}, got ${err.statusCode}`);
    return;
  }
  if (err.retryable !== expectedRetryable) {
    fail(label, `Expected retryable=${expectedRetryable}, got ${err.retryable}`);
    return;
  }
  pass(label);
}

// ─── Fixture data (Proxycurl-shaped) ─────────────────────────────────────────

/**
 * A synthetic Proxycurl People Search response with 2 enriched profiles.
 * Field names match the Proxycurl API spec exactly.
 */
const PROXYCURL_FIXTURE = {
  results: [
    {
      profile: {
        public_identifier:    'jane-doe-12345',
        linkedin_profile_url: 'https://www.linkedin.com/in/jane-doe-12345',
        first_name:           'Jane',
        last_name:            'Doe',
        full_name:            'Jane Doe',
        occupation:           'Senior Backend Engineer at TechCorp',
        headline:             'Building scalable distributed systems',
        summary:              'Passionate engineer with 8 years of experience in Node.js.',
        city:                 'Tel Aviv',
        state:                'Tel Aviv District',
        country_full_name:    'Israel',
        skills:               ['Node.js', 'TypeScript', 'AWS', 'Kubernetes'],
        experiences: [
          {
            starts_at:   { day: 1, month: 3, year: 2021 },
            ends_at:     null,
            company:     'TechCorp',
            title:       'Senior Backend Engineer',
            description: 'Led design of microservices platform.',
            location:    'Tel Aviv',
          },
          {
            starts_at:   { day: 1, month: 6, year: 2018 },
            ends_at:     { day: 1, month: 2, year: 2021 },
            company:     'StartupXYZ',
            title:       'Backend Developer',
            description: null,
            location:    'Jerusalem',
          },
        ],
        education: [
          {
            school:         'Tel Aviv University',
            degree_name:    'B.Sc.',
            field_of_study: 'Computer Science',
            ends_at:        { day: 30, month: 6, year: 2018 },
            description:    null,
          },
        ],
        profile_pic_url: 'https://example.com/pic.jpg',
      },
      last_updated: '2024-01-15T00:00:00Z',
    },
    {
      profile: {
        public_identifier:    'john-smith-67890',
        linkedin_profile_url: 'https://www.linkedin.com/in/john-smith-67890',
        first_name:           'John',
        last_name:            'Smith',
        full_name:            null,                     // full_name intentionally absent
        occupation:           null,
        headline:             'TypeScript | Node.js | LangChain',
        summary:              null,
        city:                 'New York',
        state:                'NY',
        country_full_name:    'United States',
        skills:               ['TypeScript', 'LangChain', 'Python'],
        experiences:          [],
        education:            [],
        profile_pic_url:      null,
      },
      last_updated: '2024-01-10T00:00:00Z',
    },
  ],
  next_page: null,
};

// ─── Mock HTTP client factory ─────────────────────────────────────────────────

/**
 * Creates a mock `IHttpClient` that resolves with the given data and status.
 * The generic `<TResponse>` is cast via `as` so the mock satisfies the
 * interface's generic signature without complex type gymnastics.
 */
function makeSuccessMock(data: unknown, status = 200): IHttpClient {
  return {
    async get<TResponse = unknown>(): Promise<{ data: TResponse; status: number; headers: Record<string, string> }> {
      return { data: data as TResponse, status, headers: {} };
    },
  };
}

/**
 * Creates a mock `IHttpClient` that throws an AxiosError with the given status.
 * Accurately replicates what axios throws for non-2xx responses.
 */
function makeHttpErrorMock(
  status: number,
  extraHeaders: Record<string, string> = {},
): IHttpClient {
  return {
    async get() {
      const err = new AxiosError(
        `Request failed with status code ${status}`,
        String(status),
        undefined,              // config
        undefined,              // request
        {                       // response stub
          status,
          statusText: String(status),
          headers:    extraHeaders,
          config:     { headers: {} } as never,
          data:       {},
        },
      );
      throw err;
    },
  };
}

/**
 * Creates a mock `IHttpClient` that throws a non-HTTP (network-level) error.
 */
function makeNetworkErrorMock(): IHttpClient {
  return {
    async get() {
      const err = new AxiosError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED');
      // Mark as a network error (no .response property)
      Object.defineProperty(err, 'isAxiosError', { value: true });
      throw err;
    },
  };
}

/** Shared query used in most tests. */
const QUERY: JobSearchQuery = {
  jobTitle:   'Senior TypeScript Engineer',
  keywords:   ['Node.js', 'LangChain', 'REST API'],
  platform:   'linkedin',
  location:   'Israel',
  maxResults: 5,
};

// ─── Test suites ─────────────────────────────────────────────────────────────

async function testHappyPath(): Promise<void> {
  console.log('\n📋  Suite 1 — Happy path: Proxycurl response → RawCandidateProfile adapter\n');

  const strategy = new LinkedInApiStrategy({
    apiBaseUrl:  'https://mock.proxycurl.local',
    apiKey:      'test-key-abc123',
    httpClient:  makeSuccessMock(PROXYCURL_FIXTURE),
  });

  const profiles: RawCandidateProfile[] = await strategy.execute(QUERY);

  assert('Returns 2 profiles',         profiles.length === 2, `got ${profiles.length}`);

  // ── Profile 0: Jane Doe ────────────────────────────────────────────────
  const jane = profiles[0]!;

  assert('Profile[0]: correct profileUrl',
    jane.profileUrl === 'https://www.linkedin.com/in/jane-doe-12345');

  assert('Profile[0]: platform is "linkedin"',
    jane.platform === 'linkedin');

  assert('Profile[0]: full_name mapped to name',
    jane.name === 'Jane Doe', `got "${jane.name}"`);

  assert('Profile[0]: occupation mapped to currentRole',
    jane.currentRole === 'Senior Backend Engineer at TechCorp', `got "${jane.currentRole}"`);

  assert('Profile[0]: city + country_full_name joined to location',
    jane.location === 'Tel Aviv, Israel', `got "${jane.location}"`);

  assert('Profile[0]: summary mapped',
    jane.summary?.startsWith('Passionate engineer') === true, `got "${jane.summary}"`);

  assert('Profile[0]: 4 skills',
    jane.skills.length === 4, `got ${jane.skills.length}`);

  assert('Profile[0]: skills include TypeScript',
    jane.skills.includes('TypeScript'));

  assert('Profile[0]: 2 experience entries',
    jane.experience.length === 2, `got ${jane.experience.length}`);

  assert('Profile[0]: experience[0] title correct',
    jane.experience[0]!.title === 'Senior Backend Engineer', `got "${jane.experience[0]?.title}"`);

  assert('Profile[0]: experience[0] duration is "2021 – Present"',
    jane.experience[0]!.duration === '2021 – Present', `got "${jane.experience[0]?.duration}"`);

  assert('Profile[0]: experience[1] duration uses end year',
    jane.experience[1]!.duration === '2018 – 2021', `got "${jane.experience[1]?.duration}"`);

  assert('Profile[0]: 1 education entry',
    jane.education.length === 1, `got ${jane.education.length}`);

  assert('Profile[0]: education degree assembled correctly',
    jane.education[0]!.degree === 'B.Sc., Computer Science',
    `got "${jane.education[0]?.degree}"`);

  assert('Profile[0]: graduation year mapped',
    jane.education[0]!.graduationYear === '2018', `got "${jane.education[0]?.graduationYear}"`);

  assert('Profile[0]: rawHtml is null (API strategy)',
    jane.rawHtml === null);

  assert('Profile[0]: scrapedAt is a Date',
    jane.scrapedAt instanceof Date);

  // ── Profile 1: John Smith (null full_name fallback) ───────────────────
  const john = profiles[1]!;

  assert('Profile[1]: falls back to first+last when full_name is null',
    john.name === 'John Smith', `got "${john.name}"`);

  assert('Profile[1]: null occupation → falls back to headline',
    john.currentRole === 'TypeScript | Node.js | LangChain', `got "${john.currentRole}"`);

  assert('Profile[1]: null summary → falls back to headline',
    john.summary === 'TypeScript | Node.js | LangChain', `got "${john.summary}"`);

  assert('Profile[1]: empty experience array',
    john.experience.length === 0);

  assert('Profile[1]: location from city + country',
    john.location === 'New York, United States', `got "${john.location}"`);
}

async function testEmptyResults(): Promise<void> {
  console.log('\n📋  Suite 2 — Empty result set\n');

  const strategy = new LinkedInApiStrategy({
    apiBaseUrl: 'https://mock.proxycurl.local',
    apiKey:     'test-key',
    httpClient: makeSuccessMock({ results: [], next_page: null }),
  });

  const profiles = await strategy.execute(QUERY);
  assert('Returns empty array (no throw)', profiles.length === 0, `got ${profiles.length}`);
}

async function testHttp401(): Promise<void> {
  console.log('\n📋  Suite 3 — HTTP 401 Unauthorized\n');

  const strategy = new LinkedInApiStrategy({
    apiBaseUrl: 'https://mock.proxycurl.local',
    apiKey:     'bad-key',
    httpClient: makeHttpErrorMock(401),
  });

  try {
    await strategy.execute(QUERY);
    fail('Should have thrown ScrapingError', 'no error thrown');
  } catch (err) {
    assertThrowsScrapingError('Throws ScrapingError', err, 401, false);
    assert(
      'Error name is "ScrapingError"',
      err instanceof ScrapingError && err.name === 'ScrapingError',
    );
    assert(
      'Error message mentions 401',
      err instanceof ScrapingError && err.message.includes('401'),
    );
  }
}

async function testHttp429(): Promise<void> {
  console.log('\n📋  Suite 4 — HTTP 429 Too Many Requests\n');

  const strategy = new LinkedInApiStrategy({
    apiBaseUrl: 'https://mock.proxycurl.local',
    apiKey:     'real-key',
    httpClient: makeHttpErrorMock(429, { 'retry-after': '60' }),
  });

  try {
    await strategy.execute(QUERY);
    fail('Should have thrown ScrapingError', 'no error thrown');
  } catch (err) {
    assertThrowsScrapingError('Throws retryable ScrapingError', err, 429, true);
    assert(
      'Error message mentions rate limit',
      err instanceof ScrapingError && err.message.toLowerCase().includes('rate limit'),
    );
    assert(
      'Error message mentions Retry-After',
      err instanceof ScrapingError && err.message.includes('60s'),
    );
  }
}

async function testNetworkError(): Promise<void> {
  console.log('\n📋  Suite 5 — Network-level error (ECONNREFUSED)\n');

  const strategy = new LinkedInApiStrategy({
    apiBaseUrl: 'https://mock.proxycurl.local',
    apiKey:     'real-key',
    httpClient: makeNetworkErrorMock(),
  });

  try {
    await strategy.execute(QUERY);
    fail('Should have thrown ScrapingError', 'no error thrown');
  } catch (err) {
    assertThrowsScrapingError('Throws retryable ScrapingError', err, null, true);
  }
}

async function testMissingCredentials(): Promise<void> {
  console.log('\n📋  Suite 6 — Missing credentials at construction\n');

  // Missing API key
  try {
    new LinkedInApiStrategy({ apiBaseUrl: 'https://mock.local', apiKey: '' });
    fail('Should throw ScrapingError on empty key', 'no error thrown');
  } catch (err) {
    assert(
      'Throws ScrapingError for empty API key',
      err instanceof ScrapingError,
      `got: ${String(err)}`,
    );
  }

  // Missing API URL
  try {
    new LinkedInApiStrategy({ apiBaseUrl: '', apiKey: 'some-key' });
    fail('Should throw ScrapingError on empty URL', 'no error thrown');
  } catch (err) {
    assert(
      'Throws ScrapingError for empty API URL',
      err instanceof ScrapingError,
      `got: ${String(err)}`,
    );
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' LinkedInApiStrategy — Smoke Tests');
  console.log('='.repeat(60));

  await testHappyPath();
  await testEmptyResults();
  await testHttp401();
  await testHttp429();
  await testNetworkError();
  await testMissingCredentials();

  console.log('\n' + '='.repeat(60));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Smoke Test] Unexpected top-level error:', err);
  process.exit(1);
});
