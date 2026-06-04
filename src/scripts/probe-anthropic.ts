/**
 * @file src/scripts/probe-anthropic.ts
 * @description End-to-end live test of the AnalyzerAgent against the real
 * Anthropic API using credentials from .env.
 *
 * Run with:
 *   npx ts-node src/scripts/probe-anthropic.ts
 *
 * What this tests
 * ────────────────
 * • The AnalyzerAgent can be instantiated with a real Anthropic client.
 * • `analyze()` returns a valid AnalyzedCandidate (matchScore + aiSummary).
 * • The model, max_tokens, and system prompt shape all work end-to-end.
 *
 * This makes real API calls — it will consume a small number of Anthropic credits.
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { AnalyzerAgent }         from '../agents/analyzer/AnalyzerAgent';
import { RawCandidateProfile, JobSearchQuery } from '../types/candidate.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_CANDIDATE: RawCandidateProfile = {
  profileUrl:  'https://www.linkedin.com/in/live-test-candidate',
  platform:    'mock',
  source:      'Mock',
  name:        'Alon Ben-David',
  email:       null,
  phone:       null,
  currentRole: 'Senior Full-Stack Engineer at TechCorp IL',
  location:    'Tel Aviv, Israel',
  summary:     'Full-Stack engineer with 7 years of experience building Node.js microservices and React frontends. Expert in TypeScript and cloud infrastructure (AWS, GCP).',
  skills:      ['TypeScript', 'Node.js', 'React', 'AWS', 'PostgreSQL', 'Docker'],
  experience: [
    {
      title:       'Senior Full-Stack Engineer',
      company:     'TechCorp IL',
      duration:    '2020 – Present',
      description: 'Led team of 5 engineers. Designed event-driven microservice architecture. Reduced API latency by 40%.',
    },
    {
      title:       'Full-Stack Engineer',
      company:     'StartupXYZ',
      duration:    '2017 – 2020',
      description: 'Built core product from scratch in Node.js + React. 0 to 50k users in 18 months.',
    },
  ],
  education: [
    { degree: 'B.Sc. Computer Science', institution: 'Technion – Israel Institute of Technology', graduationYear: '2017' },
  ],
  scrapedAt: new Date(),
  rawHtml:   null,
};

const MOCK_QUERY: JobSearchQuery = {
  jobTitle:   'Senior TypeScript Backend Engineer',
  keywords:   ['Node.js', 'TypeScript', 'microservices', 'AWS'],
  platform:   'mock',
  location:   'Tel Aviv, Israel',
  maxResults: 1,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' AnalyzerAgent — Live API Test');
  console.log('='.repeat(60));
  console.log('');

  const analyzer = new AnalyzerAgent();

  console.log('[probe] Calling AnalyzerAgent.analyze() with live Anthropic API...\n');

  const start = Date.now();
  const result = await analyzer.analyze(MOCK_CANDIDATE, MOCK_QUERY);
  const elapsed = Date.now() - start;

  console.log('');
  console.log('─── Result ─────────────────────────────────────────────');
  console.log(`  matchScore : ${result.matchScore}`);
  console.log(`  aiSummary  : ${result.aiSummary}`);
  console.log(`  greenFlags : ${JSON.stringify(result.greenFlags)}`);
  console.log(`  redFlags   : ${JSON.stringify(result.redFlags)}`);
  console.log(`  elapsed    : ${elapsed}ms`);
  console.log('');

  // Basic assertions
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean, detail = ''): void {
    if (condition) {
      console.log(`  ✅  ${label}`);
      passed++;
    } else {
      console.error(`  ❌  ${label}${detail ? ` — ${detail}` : ''}`);
      failed++;
    }
  }

  assert('matchScore is a number',        typeof result.matchScore === 'number',     `got ${typeof result.matchScore}`);
  assert('matchScore in range [0, 100]',  result.matchScore >= 0 && result.matchScore <= 100, `got ${result.matchScore}`);
  assert('aiSummary is non-empty string', typeof result.aiSummary === 'string' && result.aiSummary.length > 10, `got "${result.aiSummary}"`);
  assert('greenFlags is an array',        Array.isArray(result.greenFlags),          `got ${typeof result.greenFlags}`);
  assert('redFlags is an array',          Array.isArray(result.redFlags),            `got ${typeof result.redFlags}`);
  assert('name is preserved',             result.name === MOCK_CANDIDATE.name,       `got "${result.name}"`);
  assert('profileUrl is preserved',       result.profileUrl === MOCK_CANDIDATE.profileUrl);

  console.log('');
  console.log('='.repeat(60));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n[probe] FAILED with error:');
  // Print the full Anthropic error structure so the model/param issue is visible.
  try {
    console.error(JSON.stringify(err, (_key, value: unknown) => {
      if (value instanceof Error) {
        const obj: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
        for (const k of Object.keys(value)) obj[k] = (value as unknown as Record<string, unknown>)[k];
        return obj;
      }
      return value;
    }, 2));
  } catch {
    console.error(String(err));
  }
  process.exit(1);
});
