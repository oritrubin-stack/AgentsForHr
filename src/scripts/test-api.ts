/**
 * @file src/scripts/test-api.ts
 * @description End-to-end API smoke test for the /api/recruit endpoint.
 *
 * Run with:
 *   npx ts-node src/scripts/test-api.ts
 *
 * What this tests
 * ────────────────
 * This script spins up an in-process Express server (on an OS-assigned port),
 * fires real HTTP requests via axios, and asserts on the HTTP-layer behaviour.
 * No real Anthropic or Proxycurl API calls are made — the OrchestratorAgent is
 * replaced with a lightweight mock that returns deterministic data.
 *
 * This validates:
 *  ✓ The entire Express pipeline: routing → controller → serialisation
 *  ✓ Input validation (missing / invalid fields → 400)
 *  ✓ Success response shape (all required fields present and typed correctly)
 *  ✓ ScrapingError → 503 Service Unavailable mapping
 *  ✓ Unknown error → 500 Internal Server Error forwarding
 *  ✓ Unknown route → 404 Not Found
 *  ✓ Method not allowed → 404 Not Found (router doesn't define a GET /recruit)
 *
 * Why in-process and not against a running dev server?
 * ─────────────────────────────────────────────────────
 * • No external process management needed — just `ts-node test-api.ts`.
 * • Predictable port (no clashes with a running dev server).
 * • Mock injection at the agent level avoids LLM/scraper charges.
 * • Runs in CI with no extra setup.
 */

import http     from 'http';
import express, { Application, Request, Response, NextFunction } from 'express';
import axios, { AxiosError }   from 'axios';
import { ScrapingError }       from '../errors/ScrapingError';
import { OrchestratorAgent }   from '../agents/OrchestratorAgent';
import { RecruitmentController } from '../api/controllers/RecruitmentController';
import {
  AnalyzedCandidate,
  JobSearchQuery,
  RawCandidateProfile,
} from '../types/candidate.types';

// ─── Assertion helpers ────────────────────────────────────────────────────────

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

function assert(label: string, condition: boolean, detail = ''): void {
  condition ? pass(label) : fail(label, detail || 'assertion failed');
}

// ─── Mock data ────────────────────────────────────────────────────────────────

/** A deterministic RawCandidateProfile used as the base for mock results. */
const BASE_PROFILE: RawCandidateProfile = {
  profileUrl:  'https://www.linkedin.com/in/mock-candidate-1',
  platform:    'mock',
  source:      'Mock',
  name:        'Mock Candidate',
  email:       null,
  phone:       null,
  currentRole: 'Senior TypeScript Engineer at MockCorp',
  location:    'Tel Aviv, Israel',
  summary:     'Experienced engineer with 6 years of Node.js.',
  skills:      ['TypeScript', 'Node.js', 'AWS'],
  experience: [
    { title: 'Senior Engineer', company: 'MockCorp', duration: '2020 – Present', description: null },
  ],
  education: [
    { degree: 'B.Sc. Computer Science', institution: 'Mock University', graduationYear: '2018' },
  ],
  scrapedAt: new Date('2024-01-15'),
  rawHtml:   null,
};

/** Pre-built AnalyzedCandidate fixtures returned by the happy-path mock. */
const MOCK_CANDIDATES: AnalyzedCandidate[] = [
  {
    ...BASE_PROFILE,
    profileUrl:  'https://www.linkedin.com/in/mock-candidate-1',
    name:        'Alice Mock',
    matchScore:  88,
    aiSummary:   'Alice is an excellent match for the TypeScript role. Strong Node.js background.',
    greenFlags:  ['6 years Node.js', 'TypeScript expert', 'AWS certified'],
    redFlags:    [],
  },
  {
    ...BASE_PROFILE,
    profileUrl:  'https://www.linkedin.com/in/mock-candidate-2',
    name:        'Bob Mock',
    matchScore:  71,
    aiSummary:   'Bob is a solid candidate with some gaps in LangChain experience.',
    greenFlags:  ['Strong TypeScript', 'Clean architecture background'],
    redFlags:    ['LangChain not listed'],
  },
];

// ─── Mock OrchestratorAgent variants ─────────────────────────────────────────

/**
 * Creates a mock OrchestratorAgent that returns deterministic results.
 * The real agent's methods are replaced via prototype cast so TypeScript
 * is satisfied without implementing the full class contract.
 */
function makeHappyOrchestrator(): OrchestratorAgent {
  return {
    runCampaign: async (_query: JobSearchQuery, _limit: number) => ({
      candidates:      MOCK_CANDIDATES,
      query:           _query,
      totalDiscovered: 3,
      totalAnalyzed:   2,
      failedAnalyses:  1,
      warnings:        [],
      startedAt:       '2024-01-15T10:00:00.000Z',
      completedAt:     '2024-01-15T10:00:05.000Z',
    }),
  } as unknown as OrchestratorAgent;
}

/**
 * Mock that simulates a retryable upstream failure (e.g. Proxycurl 429).
 */
function makeRateLimitOrchestrator(): OrchestratorAgent {
  return {
    runCampaign: async () => {
      throw ScrapingError.rateLimited('linkedin', 60);
    },
  } as unknown as OrchestratorAgent;
}

/**
 * Mock that simulates an unexpected internal crash.
 */
function makeCrashOrchestrator(): OrchestratorAgent {
  return {
    runCampaign: async () => {
      throw new Error('Simulated unexpected internal crash.');
    },
  } as unknown as OrchestratorAgent;
}

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express application with just the recruitment endpoint.
 * The controller is wired with the provided orchestrator, enabling mock injection.
 *
 * The global error handler mirrors the one in `src/index.ts` so error-mapping
 * is tested end-to-end.
 */
function buildTestApp(orchestrator: OrchestratorAgent): Application {
  const app = express();
  app.use(express.json());

  const controller  = new RecruitmentController(orchestrator);
  const postRecruit = controller.postRecruit.bind(controller);

  // Mount the recruit endpoint
  app.post('/api/recruit', (req: Request, res: Response, next: NextFunction): void => {
    postRecruit(req, res, next).catch(next);
  });

  // API-level 404
  app.use('/api', (req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.path}` });
  });

  // Global error handler (4-param signature)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  });

  return app;
}

// ─── Server lifecycle helpers ────────────────────────────────────────────────

/**
 * Starts an HTTP server on an OS-assigned port and returns the server instance
 * plus the base URL for requests.
 */
function startServer(app: Application): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected server address format'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

/** Closes the HTTP server and resolves when all connections are drained. */
function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function testHappyPath(baseUrl: string): Promise<void> {
  console.log('\n📋  Suite 1 — POST /api/recruit — happy path\n');

  const res = await axios.post(`${baseUrl}/api/recruit`, {
    jobTitle:  'Senior TypeScript Engineer',
    keywords:  ['Node.js', 'LangChain'],
    platform:  'mock',
    location:  'Israel',
    limit:     5,
  });

  assert('Status 200',             res.status === 200, `got ${res.status}`);
  assert('success is true',        res.data.success === true);
  assert('count is 2',             res.data.count === 2, `got ${res.data.count}`);
  assert('candidates is an array', Array.isArray(res.data.candidates));
  assert('totalDiscovered is 3',   res.data.totalDiscovered === 3, `got ${res.data.totalDiscovered}`);
  assert('totalAnalyzed is 2',     res.data.totalAnalyzed === 2, `got ${res.data.totalAnalyzed}`);
  assert('failedAnalyses is 1',    res.data.failedAnalyses === 1, `got ${res.data.failedAnalyses}`);
  assert('warnings is an array',   Array.isArray(res.data.warnings));
  assert('startedAt present',      typeof res.data.startedAt === 'string');
  assert('completedAt present',    typeof res.data.completedAt === 'string');

  const first: AnalyzedCandidate = res.data.candidates[0];
  assert('candidates[0].matchScore = 88',  first.matchScore === 88,   `got ${first.matchScore}`);
  assert('candidates[0].name = Alice Mock', first.name === 'Alice Mock', `got "${first.name}"`);
  assert('greenFlags is an array',         Array.isArray(first.greenFlags));
  assert('redFlags is an array',           Array.isArray(first.redFlags));
  assert('aiSummary non-empty',            typeof first.aiSummary === 'string' && first.aiSummary.length > 5);
  assert('platform is "mock"',             first.platform === 'mock', `got "${first.platform}"`);
}

async function testValidation(baseUrl: string): Promise<void> {
  console.log('\n📋  Suite 2 — Input validation → 400\n');

  // Missing jobTitle
  try {
    await axios.post(`${baseUrl}/api/recruit`, { keywords: ['Node.js'] });
    fail('Should have returned 400 for missing jobTitle', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('Missing jobTitle → 400',    e.response?.status === 400, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('success is false',          body.success === false);
    assert('field is "jobTitle"',       body.field === 'jobTitle', `got "${body.field}"`);
  }

  // Empty string jobTitle
  try {
    await axios.post(`${baseUrl}/api/recruit`, { jobTitle: '   ' });
    fail('Should have returned 400 for empty jobTitle', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('Empty jobTitle → 400',      e.response?.status === 400, `got ${e.response?.status}`);
  }

  // Invalid platform
  try {
    await axios.post(`${baseUrl}/api/recruit`, { jobTitle: 'SWE', platform: 'myspace' });
    fail('Should have returned 400 for invalid platform', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('Invalid platform → 400',    e.response?.status === 400, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('field is "platform"',       body.field === 'platform', `got "${body.field}"`);
  }

  // limit = 0
  try {
    await axios.post(`${baseUrl}/api/recruit`, { jobTitle: 'SWE', limit: 0 });
    fail('Should have returned 400 for limit=0', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('limit=0 → 400',             e.response?.status === 400, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('field is "limit"',          body.field === 'limit', `got "${body.field}"`);
  }

  // limit > 50
  try {
    await axios.post(`${baseUrl}/api/recruit`, { jobTitle: 'SWE', limit: 51 });
    fail('Should have returned 400 for limit=51', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('limit=51 → 400',            e.response?.status === 400, `got ${e.response?.status}`);
  }

  // keywords not an array
  try {
    await axios.post(`${baseUrl}/api/recruit`, { jobTitle: 'SWE', keywords: 'node' });
    fail('Should have returned 400 for keywords string', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('keywords as string → 400',  e.response?.status === 400, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('field is "keywords"',       body.field === 'keywords', `got "${body.field}"`);
  }
}

async function testRateLimit(): Promise<void> {
  console.log('\n📋  Suite 3 — ScrapingError (retryable) → 503\n');

  // Use a server wired to the rate-limit orchestrator
  const app = buildTestApp(makeRateLimitOrchestrator());
  const { server, baseUrl: rlBase } = await startServer(app);

  try {
    await axios.post(`${rlBase}/api/recruit`, { jobTitle: 'SWE', platform: 'linkedin' });
    fail('Should have returned 503', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('Rate-limit ScrapingError → 503', e.response?.status === 503, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('success is false',              body.success === false);
    assert('retryable is true',             body.retryable === true, `got ${String(body.retryable)}`);
    assert('message mentions rate limit',   (body.message as string)?.toLowerCase().includes('rate limit'));
  } finally {
    await stopServer(server);
  }
}

async function testInternalError(): Promise<void> {
  console.log('\n📋  Suite 4 — Unexpected error → 500 (via global error handler)\n');

  const app = buildTestApp(makeCrashOrchestrator());
  const { server, baseUrl: crashBase } = await startServer(app);

  try {
    await axios.post(`${crashBase}/api/recruit`, { jobTitle: 'SWE' });
    fail('Should have returned 500', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('Crash → 500',              e.response?.status === 500, `got ${e.response?.status}`);
    const body = e.response?.data as Record<string, unknown>;
    assert('"Internal Server Error"',  body.error === 'Internal Server Error', `got "${body.error}"`);
    assert('message present',          typeof body.message === 'string');
  } finally {
    await stopServer(server);
  }
}

async function testNotFound(baseUrl: string): Promise<void> {
  console.log('\n📋  Suite 5 — Unknown routes → 404\n');

  try {
    await axios.get(`${baseUrl}/api/recruit`);
    fail('GET /api/recruit should 404', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('GET /api/recruit → 404',   e.response?.status === 404, `got ${e.response?.status}`);
  }

  try {
    await axios.post(`${baseUrl}/api/nonexistent`, { jobTitle: 'SWE' });
    fail('POST /api/nonexistent should 404', 'no error thrown');
  } catch (err) {
    const e = err as AxiosError;
    assert('POST /api/nonexistent → 404', e.response?.status === 404, `got ${e.response?.status}`);
  }
}

async function testDefaultsApplied(baseUrl: string): Promise<void> {
  console.log('\n📋  Suite 6 — Optional field defaults applied\n');

  // Only jobTitle provided — defaults for keywords, platform, limit should be applied.
  const res = await axios.post(`${baseUrl}/api/recruit`, { jobTitle: 'SWE' });

  assert('Status 200 with only jobTitle',  res.status === 200, `got ${res.status}`);
  assert('query.platform defaults to mock',
    res.data.query.platform === 'mock',    `got "${res.data.query.platform}"`);
  assert('query.keywords defaults to []',
    Array.isArray(res.data.query.keywords) && res.data.query.keywords.length === 0,
    `got ${JSON.stringify(res.data.query.keywords)}`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' AgentsForHR — API Smoke Test (POST /api/recruit)');
  console.log('='.repeat(60));

  // Start the primary test server with the happy-path mock orchestrator
  const app = buildTestApp(makeHappyOrchestrator());
  const { server, baseUrl } = await startServer(app);

  console.log(`\n  Server started at ${baseUrl}\n`);

  try {
    await testHappyPath(baseUrl);
    await testValidation(baseUrl);
    await testRateLimit();     // starts its own server internally
    await testInternalError(); // starts its own server internally
    await testNotFound(baseUrl);
    await testDefaultsApplied(baseUrl);
  } finally {
    await stopServer(server);
  }

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
