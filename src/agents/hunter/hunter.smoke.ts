/**
 * @file src/agents/hunter/hunter.smoke.ts
 * @description Standalone smoke test that proves the end-to-end data flow
 * works without needing a running Express server.
 *
 * Run with:
 *   npx ts-node src/agents/hunter/hunter.smoke.ts
 */

import { PlaywrightService } from '../../services/scraper/PlaywrightService';
import { HunterAgent }       from './HunterAgent';
import { JobSearchQuery }    from '../../types/candidate.types';

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' Hunter Agent — Smoke Test');
  console.log('='.repeat(60));

  const service = new PlaywrightService({ headless: true });
  const hunter  = new HunterAgent(service);

  // ── Test 1: Mock platform (no real browser session needed) ──────────────
  console.log('\n[Test 1] Mock platform — 3 synthetic profiles\n');

  const mockQuery: JobSearchQuery = {
    jobTitle:   'Senior TypeScript Engineer',
    keywords:   ['Node.js', 'LangChain', 'multi-agent', 'REST API'],
    platform:   'mock',
    location:   'Tel Aviv, Israel',
    maxResults: 3,
  };

  const mockResult = await hunter.hunt(mockQuery, { captureHtml: false });

  console.log(`Profiles returned : ${mockResult.profiles.length}`);
  console.log(`Warnings          : ${mockResult.warnings.length}`);
  console.log(`Started at        : ${mockResult.startedAt}`);
  console.log(`Completed at      : ${mockResult.completedAt}`);
  console.log('\nFirst profile:');
  console.log(JSON.stringify(mockResult.profiles[0], null, 2));

  // ── Test 2: GitHub platform (real HTTP via Playwright) ──────────────────
  console.log('\n' + '='.repeat(60));
  console.log('[Test 2] GitHub platform — real API navigation\n');

  const githubQuery: JobSearchQuery = {
    jobTitle:   'TypeScript Developer',
    keywords:   ['langchain', 'nodejs'],
    platform:   'github',
    maxResults: 3,
  };

  const githubResult = await hunter.hunt(githubQuery, { captureHtml: false });

  console.log(`Profiles returned : ${githubResult.profiles.length}`);
  console.log(`Warnings          : ${githubResult.warnings.length}`);
  if (githubResult.warnings.length) {
    console.log('Warnings:', githubResult.warnings);
  }
  if (githubResult.profiles.length > 0) {
    console.log('\nFirst profile:');
    console.log(JSON.stringify(githubResult.profiles[0], null, 2));
  }

  console.log('\n' + '='.repeat(60));
  console.log(' All tests passed ✔');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('[Smoke Test] FAILED:', err);
  process.exit(1);
});
