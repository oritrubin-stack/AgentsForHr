/**
 * @file src/agents/analyzer/analyzer.smoke.ts
 * @description Smoke tests for AnalyzerAgent — no real Anthropic API calls.
 *
 * Testing approach: manual mock injection (zero test-framework dependencies)
 * ────────────────────────────────────────────────────────────────────────────
 * `AnalyzerAgent` accepts an optional `Anthropic` client in its constructor.
 * We inject a lightweight duck-typed mock whose `messages.create()` method
 * returns pre-defined fixture responses.  This lets us validate all parsing,
 * validation, error-handling, and adapter logic without network access.
 *
 *   npx ts-node src/agents/analyzer/analyzer.smoke.ts
 *
 * Tests covered
 * ──────────────
 *  1. Happy path            — Valid LLM JSON is merged into AnalyzedCandidate correctly.
 *  2. Markdown fence strip  — LLM wraps JSON in ```json ... ``` fences → still parsed.
 *  3. Score boundary 0      — matchScore=0 is valid.
 *  4. Score boundary 100    — matchScore=100 is valid.
 *  5. Empty flags           — greenFlags/redFlags as empty arrays → valid.
 *  6. Invalid JSON          — LLM returns plain text → AnalysisError thrown.
 *  7. Missing field         — LLM omits matchScore → AnalysisError thrown.
 *  8. Score out of range    — matchScore=150 → AnalysisError thrown.
 *  9. No text block         — Response has only thinking blocks → AnalysisError thrown.
 * 10. rawHtml excluded      — rawHtml is NOT sent to the LLM (verified via prompt capture).
 * 11. Anthropic SDK errors  — AuthenticationError / RateLimitError propagate unchanged.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnalyzerAgent, AnalysisError } from './AnalyzerAgent';
import { RawCandidateProfile, JobSearchQuery, AnalyzedCandidate } from '../../types/candidate.types';

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

function assertThrowsAnalysisError(
  label: string,
  err: unknown,
  messageSnippet?: string,
): void {
  if (!(err instanceof AnalysisError)) {
    fail(label, `Expected AnalysisError but got: ${String(err)}`);
    return;
  }
  if (messageSnippet && !err.message.includes(messageSnippet)) {
    fail(label, `Expected message to contain "${messageSnippet}", got: "${err.message}"`);
    return;
  }
  pass(label);
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

/** A minimal realistic RawCandidateProfile used across most tests. */
const CANDIDATE: RawCandidateProfile = {
  profileUrl:  'https://www.linkedin.com/in/jane-doe-12345',
  platform:    'linkedin',
  source:      'LinkedIn',
  name:        'Jane Doe',
  email:       null,
  phone:       null,
  currentRole: 'Senior Backend Engineer at TechCorp',
  location:    'Tel Aviv, Israel',
  summary:     'Passionate engineer with 8 years of Node.js experience.',
  skills:      ['Node.js', 'TypeScript', 'AWS', 'Kubernetes'],
  experience: [
    {
      title:       'Senior Backend Engineer',
      company:     'TechCorp',
      duration:    '2021 – Present',
      description: 'Led design of microservices platform.',
    },
    {
      title:       'Backend Developer',
      company:     'StartupXYZ',
      duration:    '2018 – 2021',
      description: null,
    },
  ],
  education: [
    {
      degree:         'B.Sc., Computer Science',
      institution:    'Tel Aviv University',
      graduationYear: '2018',
    },
  ],
  scrapedAt: new Date('2024-01-15T00:00:00Z'),
  rawHtml:   '<html><!-- LARGE PAGE SOURCE — MUST NOT reach the LLM --></html>',
};

/** The job we're hiring for. */
const QUERY: JobSearchQuery = {
  jobTitle:   'Senior TypeScript Engineer',
  keywords:   ['Node.js', 'LangChain', 'REST API'],
  platform:   'linkedin',
  location:   'Israel',
  maxResults: 10,
};

/** A valid LLM JSON response with typical content. */
const VALID_LLM_JSON = JSON.stringify({
  matchScore: 78,
  aiSummary:
    'Jane Doe is a strong candidate for the Senior TypeScript Engineer role. ' +
    'She brings 8 years of Node.js experience and a solid background in distributed systems. ' +
    'Her lack of explicit LangChain exposure is a minor gap that should be explored during the interview.',
  greenFlags: [
    '8 years Node.js',
    'TypeScript listed in skills',
    'AWS + Kubernetes production experience',
    'Strong distributed-systems background',
  ],
  redFlags: [
    'LangChain not explicitly mentioned',
    'No front-end experience (role may require some)',
  ],
});

// ─── Mock Anthropic client factory ────────────────────────────────────────────

/**
 * Last user-message content captured by the mock — lets us assert on what
 * was sent to the LLM without a real API call.
 */
let capturedUserPrompt = '';

/**
 * Builds a mock `Anthropic` instance whose `messages.create()` method returns
 * the given text as a `text` block inside a well-formed `Message`.
 *
 * We use `as unknown as Anthropic` to satisfy TypeScript without implementing
 * every method of the SDK client — only the path our agent actually uses.
 */
function makeSuccessMock(responseText: string): Anthropic {
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        // Capture the user prompt for inspection in later assertions.
        const userMsg = params.messages.find((m) => m.role === 'user');
        if (typeof userMsg?.content === 'string') {
          capturedUserPrompt = userMsg.content;
        }

        return {
          id:           'msg_mock_001',
          type:         'message',
          role:         'assistant',
          model:        params.model,
          stop_reason:  'end_turn',
          stop_sequence: null,
          usage:        { input_tokens: 800, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [
            { type: 'text', text: responseText },
          ],
        } as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

/**
 * Builds a mock that simulates a response with ONLY thinking blocks and no
 * text block (edge case we must handle).
 */
function makeThinkingOnlyMock(): Anthropic {
  return {
    messages: {
      create: async () => ({
        id:           'msg_mock_thinking',
        type:         'message',
        role:         'assistant',
        model:        'claude-3-5-sonnet-20241022',
        stop_reason:  'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [
          // Only a thinking block — no text block.
          { type: 'thinking', thinking: 'I should respond with JSON...', signature: '' },
        ],
      } as Anthropic.Message),
    },
  } as unknown as Anthropic;
}

/**
 * Builds a mock that throws the given Anthropic SDK error class.
 * Used to verify that SDK errors propagate unmodified through the agent.
 */
function makeErrorMock(error: Error): Anthropic {
  return {
    messages: {
      create: async () => { throw error; },
    },
  } as unknown as Anthropic;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function testHappyPath(): Promise<void> {
  console.log('\n📋  Suite 1 — Happy path: valid LLM JSON → AnalyzedCandidate\n');

  const agent = new AnalyzerAgent(makeSuccessMock(VALID_LLM_JSON));
  const result: AnalyzedCandidate = await agent.analyze(CANDIDATE, QUERY);

  assert('Returns AnalyzedCandidate (not null)',
    result !== null && typeof result === 'object');

  // ── Original RawCandidateProfile fields are preserved ──────────────────
  assert('profileUrl preserved',
    result.profileUrl === CANDIDATE.profileUrl, `got "${result.profileUrl}"`);

  assert('name preserved',
    result.name === CANDIDATE.name, `got "${result.name}"`);

  assert('skills array preserved (same reference length)',
    result.skills.length === CANDIDATE.skills.length, `got ${result.skills.length}`);

  assert('scrapedAt preserved',
    result.scrapedAt.getTime() === CANDIDATE.scrapedAt.getTime());

  assert('rawHtml preserved on result object',
    result.rawHtml === CANDIDATE.rawHtml);

  // ── AI-generated fields ────────────────────────────────────────────────
  assert('matchScore is 78',
    result.matchScore === 78, `got ${result.matchScore}`);

  assert('aiSummary is non-empty string',
    typeof result.aiSummary === 'string' && result.aiSummary.length > 10,
    `got "${result.aiSummary}"`);

  assert('aiSummary mentions Jane Doe',
    result.aiSummary.includes('Jane Doe'), `got "${result.aiSummary}"`);

  assert('greenFlags has 4 entries',
    result.greenFlags.length === 4, `got ${result.greenFlags.length}`);

  assert('greenFlags[0] is the 8-years phrase',
    result.greenFlags[0] === '8 years Node.js', `got "${result.greenFlags[0]}"`);

  assert('redFlags has 2 entries',
    result.redFlags.length === 2, `got ${result.redFlags.length}`);

  assert('redFlags[0] mentions LangChain',
    result.redFlags[0]!.toLowerCase().includes('langchain'),
    `got "${result.redFlags[0]}"`);
}

async function testMarkdownFenceStrip(): Promise<void> {
  console.log('\n📋  Suite 2 — Markdown fence stripping\n');

  // LLM wraps the JSON in code fences despite instructions — should still parse.
  const fencedJson = `\`\`\`json\n${VALID_LLM_JSON}\n\`\`\``;
  const agent = new AnalyzerAgent(makeSuccessMock(fencedJson));
  const result = await agent.analyze(CANDIDATE, QUERY);

  assert('Parses JSON inside ```json fences',
    result.matchScore === 78, `got ${result.matchScore}`);

  // Plain ``` fences (no language tag)
  const plainFence = `\`\`\`\n${VALID_LLM_JSON}\n\`\`\``;
  const agent2 = new AnalyzerAgent(makeSuccessMock(plainFence));
  const result2 = await agent2.analyze(CANDIDATE, QUERY);

  assert('Parses JSON inside plain ``` fences',
    result2.matchScore === 78, `got ${result2.matchScore}`);
}

async function testScoreBoundaries(): Promise<void> {
  console.log('\n📋  Suite 3 — Score boundary values (0 and 100)\n');

  for (const score of [0, 100]) {
    const json = JSON.stringify({
      matchScore: score,
      aiSummary:  'Test summary.',
      greenFlags: [],
      redFlags:   [],
    });
    const agent = new AnalyzerAgent(makeSuccessMock(json));
    const result = await agent.analyze(CANDIDATE, QUERY);
    assert(`matchScore=${score} is accepted`, result.matchScore === score);
  }
}

async function testEmptyFlagsArrays(): Promise<void> {
  console.log('\n📋  Suite 4 — Empty greenFlags and redFlags arrays\n');

  const json = JSON.stringify({
    matchScore: 50,
    aiSummary:  'Average candidate.',
    greenFlags: [],
    redFlags:   [],
  });
  const agent = new AnalyzerAgent(makeSuccessMock(json));
  const result = await agent.analyze(CANDIDATE, QUERY);

  assert('Empty greenFlags accepted',   result.greenFlags.length === 0);
  assert('Empty redFlags accepted',     result.redFlags.length   === 0);
  assert('matchScore still parsed (50)', result.matchScore === 50);
}

async function testInvalidJson(): Promise<void> {
  console.log('\n📋  Suite 5 — Invalid JSON response\n');

  const agent = new AnalyzerAgent(makeSuccessMock('This is not JSON at all.'));
  try {
    await agent.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AnalysisError', 'no error thrown');
  } catch (err) {
    assertThrowsAnalysisError('Throws AnalysisError for non-JSON response', err, 'JSON');
    assert('rawOutput is preserved on error',
      err instanceof AnalysisError && err.rawOutput === 'This is not JSON at all.',
      `got "${(err as AnalysisError).rawOutput}"`);
  }
}

async function testMissingField(): Promise<void> {
  console.log('\n📋  Suite 6 — Missing required field (matchScore omitted)\n');

  const incompleteJson = JSON.stringify({
    // matchScore intentionally absent
    aiSummary:  'Strong candidate.',
    greenFlags: ['TypeScript'],
    redFlags:   [],
  });
  const agent = new AnalyzerAgent(makeSuccessMock(incompleteJson));
  try {
    await agent.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AnalysisError', 'no error thrown');
  } catch (err) {
    assertThrowsAnalysisError('Throws AnalysisError for missing matchScore', err, 'matchScore');
  }
}

async function testScoreOutOfRange(): Promise<void> {
  console.log('\n📋  Suite 7 — matchScore out of range (150)\n');

  const json = JSON.stringify({
    matchScore: 150,
    aiSummary:  'Perfect candidate.',
    greenFlags: ['Everything'],
    redFlags:   [],
  });
  const agent = new AnalyzerAgent(makeSuccessMock(json));
  try {
    await agent.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AnalysisError', 'no error thrown');
  } catch (err) {
    assertThrowsAnalysisError('Throws AnalysisError for matchScore=150', err, 'out of range');
  }
}

async function testNoTextBlock(): Promise<void> {
  console.log('\n📋  Suite 8 — Response with only thinking blocks (no text block)\n');

  const agent = new AnalyzerAgent(makeThinkingOnlyMock());
  try {
    await agent.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AnalysisError', 'no error thrown');
  } catch (err) {
    assertThrowsAnalysisError('Throws AnalysisError when no text block', err, 'no text block');
  }
}

async function testRawHtmlExcluded(): Promise<void> {
  console.log('\n📋  Suite 9 — rawHtml must NOT be sent to the LLM\n');

  capturedUserPrompt = '';
  const agent = new AnalyzerAgent(makeSuccessMock(VALID_LLM_JSON));
  await agent.analyze(CANDIDATE, QUERY);

  assert('rawHtml content not in prompt',
    !capturedUserPrompt.includes('LARGE PAGE SOURCE — MUST NOT reach the LLM'),
    'rawHtml content found in captured prompt!');

  assert('Candidate name IS in prompt (sanity check)',
    capturedUserPrompt.includes('Jane Doe'),
    'Candidate name missing from prompt');
}

async function testSdkErrorsPropagateUnchanged(): Promise<void> {
  console.log('\n📋  Suite 10 — Anthropic SDK errors propagate unchanged\n');

  // AuthenticationError — constructor: (status, error, message, headers)
  const authErr = new Anthropic.AuthenticationError(
    401,
    { type: 'authentication_error', message: 'Invalid API key.' },
    'Invalid API key.',
    new Headers(),
  );

  const agent1 = new AnalyzerAgent(makeErrorMock(authErr));
  try {
    await agent1.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AuthenticationError', 'no error thrown');
  } catch (err) {
    assert(
      'AuthenticationError propagates as-is (not wrapped in AnalysisError)',
      err instanceof Anthropic.AuthenticationError,
      `got: ${String(err)}`,
    );
  }

  // RateLimitError — constructor: (status, error, message, headers)
  const rateErr = new Anthropic.RateLimitError(
    429,
    { type: 'rate_limit_error', message: 'Rate limit exceeded.' },
    'Rate limit exceeded.',
    new Headers(),
  );

  const agent2 = new AnalyzerAgent(makeErrorMock(rateErr));
  try {
    await agent2.analyze(CANDIDATE, QUERY);
    fail('Should have thrown RateLimitError', 'no error thrown');
  } catch (err) {
    assert(
      'RateLimitError propagates as-is (not wrapped in AnalysisError)',
      err instanceof Anthropic.RateLimitError,
      `got: ${String(err)}`,
    );
  }
}

async function testAnalysisErrorName(): Promise<void> {
  console.log('\n📋  Suite 11 — AnalysisError name and rawOutput properties\n');

  const badJson = '{ not valid json }';
  const agent = new AnalyzerAgent(makeSuccessMock(badJson));
  try {
    await agent.analyze(CANDIDATE, QUERY);
    fail('Should have thrown AnalysisError', 'no error thrown');
  } catch (err) {
    assert('err.name is "AnalysisError"',
      err instanceof AnalysisError && err.name === 'AnalysisError',
      `got: ${String((err as AnalysisError).name)}`);

    assert('err.rawOutput contains the bad input',
      err instanceof AnalysisError && err.rawOutput === badJson,
      `got: "${(err as AnalysisError).rawOutput}"`);

    assert('err instanceof AnalysisError is true',
      err instanceof AnalysisError);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' AnalyzerAgent — Smoke Tests');
  console.log('='.repeat(60));

  await testHappyPath();
  await testMarkdownFenceStrip();
  await testScoreBoundaries();
  await testEmptyFlagsArrays();
  await testInvalidJson();
  await testMissingField();
  await testScoreOutOfRange();
  await testNoTextBlock();
  await testRawHtmlExcluded();
  await testSdkErrorsPropagateUnchanged();
  await testAnalysisErrorName();

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
