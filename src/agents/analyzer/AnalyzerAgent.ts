/**
 * @file src/agents/analyzer/AnalyzerAgent.ts
 * @description The Analyzer Agent — evaluates a raw candidate profile against a
 * job search query using Claude and returns a scored, annotated result.
 *
 * Architecture position
 * ──────────────────────
 * ```
 *   HunterAgent  →  RawCandidateProfile[]
 *                         │
 *               ► AnalyzerAgent  ◄── you are here
 *                         │
 *                   AnalyzedCandidate[]
 *                         │
 *                  [Ranker / Screener…]
 * ```
 *
 * LLM strategy
 * ─────────────
 * • **Model**: `claude-haiku-4-5-20251001` — Claude 4.5 Haiku; fast, cost-effective,
 *   and excellent at structured JSON extraction for batch HR analysis.
 * • **Thinking**: disabled — not required for structured JSON extraction tasks.
 * • **Prompt caching**: The static system prompt is marked `cache_control:
 *   {type: "ephemeral"}` so repeated calls within the 5-minute cache window
 *   reuse the KV cache and avoid re-tokenising ~600 tokens each time.
 * • **Streaming**: Disabled here — the response is small and structured JSON;
 *   streaming would complicate JSON parsing without meaningfully reducing
 *   perceived latency in a batch pipeline context.
 *
 * JSON contract
 * ──────────────
 * The LLM is instructed to respond with ONLY a JSON object matching:
 * ```json
 * {
 *   "matchScore":  <integer 0–100>,
 *   "aiSummary":   "<2–4 sentence executive summary>",
 *   "greenFlags":  ["<short phrase>", …],
 *   "redFlags":    ["<short phrase>", …],
 *   "email":       "<extracted email address or null>",
 *   "phone":       "<extracted phone number or null>"
 * }
 * ```
 * `email` and `phone` are optional in the response — the agent falls back to
 * the values already on the `RawCandidateProfile` (set by the Hunter) when the
 * LLM omits them or returns `null`.
 *
 * The agent parses this, validates required fields, and merges it with the
 * original `RawCandidateProfile` to produce an `AnalyzedCandidate`.
 *
 * Error handling
 * ───────────────
 * • `Anthropic.AuthenticationError` (401) → hard fail; bad API key.
 * • `Anthropic.RateLimitError`      (429) → hard fail; caller should back off.
 * • `Anthropic.APIError`            (5xx) → hard fail; upstream is down.
 * • JSON parse failure              → `AnalysisError` with the raw LLM output.
 * • Schema validation failure       → `AnalysisError` listing the missing fields.
 *
 * Dependency injection
 * ─────────────────────
 * The constructor accepts an optional `Anthropic` client instance.  Pass a mock
 * in tests to avoid real API calls.  In production, omit it — the agent creates
 * a real client from `env.ANTHROPIC_API_KEY`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import {
  JobSearchQuery,
  RawCandidateProfile,
  AnalyzedCandidate,
} from '../../types/candidate.types';

// ─── Domain error ─────────────────────────────────────────────────────────────

/**
 * Thrown when the LLM's response cannot be parsed into a valid `AnalyzedCandidate`.
 *
 * This is distinct from Anthropic SDK errors (auth, rate-limit, network) which
 * propagate as-is to the caller.  `AnalysisError` is a contract-level failure:
 * the API call succeeded but the response shape was unusable.
 */
export class AnalysisError extends Error {
  readonly name = 'AnalysisError' as const;

  /** The raw text the LLM returned, preserved for debugging. */
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    this.rawOutput = rawOutput;
    Object.setPrototypeOf(this, AnalysisError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AnalysisError);
    }
  }
}

// ─── LLM response shape (internal) ───────────────────────────────────────────

/**
 * The exact JSON structure the LLM must return.
 * Validated at runtime before merging into `AnalyzedCandidate`.
 *
 * `email` and `phone` are optional — the LLM may not find them in all profiles.
 * The `analyze()` method falls back to the Hunter-extracted values when these
 * are absent or null.
 */
interface LlmAnalysisResult {
  matchScore: number;
  aiSummary:  string;
  greenFlags: string[];
  redFlags:   string[];
  /** Contact email extracted from the profile text.  `null` if not found. */
  email?:     string | null;
  /** Contact phone extracted from the profile text.  `null` if not found. */
  phone?:     string | null;
}

// ─── AnalyzerAgent ────────────────────────────────────────────────────────────

/**
 * The Analyzer Agent.
 *
 * Takes a `RawCandidateProfile` produced by the Hunter Agent and evaluates
 * it against a `JobSearchQuery` using Claude, returning an `AnalyzedCandidate`
 * with a match score, AI summary, and lists of green/red flags.
 *
 * @example Production usage (env var ANTHROPIC_API_KEY is set)
 * ```ts
 * const analyzer = new AnalyzerAgent();
 * const result = await analyzer.analyze(rawProfile, query);
 * console.log(result.matchScore, result.aiSummary);
 * ```
 *
 * @example Test usage with a mocked client
 * ```ts
 * const analyzer = new AnalyzerAgent(mockAnthropicClient);
 * const result = await analyzer.analyze(rawProfile, query);
 * ```
 */
export class AnalyzerAgent {
  private readonly client: Anthropic;

  /**
   * Claude model to use for all analysis calls.
   *
   * `claude-haiku-4-5-20251001` is chosen for its speed and cost efficiency —
   * ideal for batch candidate analysis where many API calls are made per
   * campaign.  Upgrade to `claude-sonnet-4-6` for higher reasoning quality at
   * ~5× the cost.
   */
  private static readonly MODEL = 'claude-haiku-4-5-20251001' as const;

  /**
   * Maximum tokens allowed in the LLM response.
   * 2 048 gives comfortable headroom for the JSON payload plus any internal
   * chain-of-thought the model may emit before the final object.
   */
  private static readonly MAX_TOKENS = 2_048;

  /**
   * @param client - Optional pre-configured `Anthropic` instance.
   *   Omit in production — the agent creates its own client from env vars.
   *   Inject a mock in tests to avoid real API calls.
   */
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Evaluates a candidate profile against a job search query using Claude.
   *
   * Sends the profile JSON to the LLM with a strict recruiter system prompt
   * and parses the structured JSON response into an `AnalyzedCandidate`.
   *
   * @param candidate - Raw profile from the Hunter Agent.
   * @param query     - The job the candidate is being evaluated against.
   * @returns The original profile extended with AI-generated evaluation fields.
   *
   * @throws {AnalysisError}             If the LLM response is not parseable JSON
   *                                     or fails schema validation.
   * @throws {Anthropic.AuthenticationError} If the API key is invalid.
   * @throws {Anthropic.RateLimitError}      If the API rate limit is exceeded.
   * @throws {Anthropic.APIError}            On any other Anthropic API failure.
   */
  async analyze(
    candidate: RawCandidateProfile,
    query: JobSearchQuery,
  ): Promise<AnalyzedCandidate> {
    console.log(
      `[AnalyzerAgent] Analyzing candidate "${candidate.name ?? candidate.profileUrl}" ` +
      `for role "${query.jobTitle}" on platform "${query.platform}".`,
    );

    const userPrompt = this._buildUserPrompt(candidate, query);

    const message = await this.client.messages.create({
      model:      AnalyzerAgent.MODEL,
      max_tokens: AnalyzerAgent.MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: this._systemPrompt(),
          // Stable system prompt — cache it so repeated calls within the
          // 5-minute window reuse the Anthropic KV cache.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role:    'user',
          content: userPrompt,
        },
      ],
    });

    // Extract the text block from the response (ignore thinking blocks).
    const rawOutput = this._extractTextContent(message);

    console.log(
      `[AnalyzerAgent] Received response (${rawOutput.length} chars). ` +
      `Input tokens: ${message.usage.input_tokens}, ` +
      `Output tokens: ${message.usage.output_tokens}.`,
    );

    const llmResult = this._parseAndValidate(rawOutput);

    return {
      ...candidate,
      matchScore: llmResult.matchScore,
      aiSummary:  llmResult.aiSummary,
      greenFlags: llmResult.greenFlags,
      redFlags:   llmResult.redFlags,
      // Prefer LLM-extracted contact info; fall back to Hunter-scraped values.
      // This is the key merge point: the LLM may find better contact details
      // in the raw CV text than the Hunter could extract structurally.
      email: llmResult.email  ?? candidate.email,
      phone: llmResult.phone  ?? candidate.phone,
    };
  }

  // ── Prompt construction ────────────────────────────────────────────────────

  /**
   * The static system prompt that defines the LLM's role and output contract.
   *
   * Marked with `cache_control: {type: "ephemeral"}` in the API call so this
   * ~600-token block is cached across calls within a 5-minute window.
   *
   * Design choices:
   *  • Role + persona first — "Senior HR Recruiter" primes the model for
   *    calibrated, evidence-based judgement rather than surface-level keyword
   *    matching.
   *  • Explicit JSON-only instruction with a concrete schema — reduces the
   *    risk of the model wrapping the JSON in markdown fences or prose.
   *  • Scoring rubric included — anchors the model's score distribution so
   *    scores are consistent across different candidates and queries.
   *  • "ONLY the JSON object" repeated twice — reinforces the output format.
   */
  private _systemPrompt(): string {
    return `You are a Senior HR Recruiter and Technical Talent Evaluator with 15+ years of experience hiring software engineers, data scientists, and product managers at top-tier technology companies.

Your task is to evaluate a candidate's profile or CV text against a specific open job requisition and produce a structured, objective assessment.

## Output format

Respond with ONLY a valid JSON object — no markdown fences, no prose, no preamble, no explanation. Your entire response must be parseable by JSON.parse().

The JSON object must contain exactly these six keys:

{
  "matchScore":  <integer between 0 and 100 inclusive>,
  "aiSummary":   "<2–4 sentence executive summary for a hiring manager>",
  "greenFlags":  ["<short evidence-based phrase>", ...],
  "redFlags":    ["<short actionable phrase>", ...],
  "email":       "<candidate's contact email address, or null if not found>",
  "phone":       "<candidate's contact phone number, or null if not found>"
}

## Contact extraction rules (email and phone)

- Search the ENTIRE profile text / CV body for the candidate's personal contact details.
- email: extract the candidate's own email address. Look for patterns like "name@domain.com" anywhere in the text. Return null if not found.
- phone: extract the candidate's phone number in whatever format it appears (e.g. "+972-54-1234567", "054-123-4567", "+1 (415) 555-0123"). Return null if not found.
- IMPORTANT: these must be the CANDIDATE's contact details, not the recruiter's or job board's.

## Scoring rubric

- 80–100: Excellent match. Candidate meets or exceeds all key requirements. Recommend for interview immediately.
- 60–79:  Good match. Meets most requirements; minor skill or experience gaps that can be addressed on the job.
- 40–59:  Partial match. Relevant background but notable gaps in required skills, seniority, or domain.
- 0–39:   Weak match. Fundamentally misaligned with the role in terms of skills, experience level, or domain.

## Evaluation guidelines

- Base your assessment ONLY on evidence in the profile. Do not infer skills not mentioned.
- greenFlags: list 2–5 specific, concrete positive signals (e.g. "8 years Node.js", "Led team of 12", "Open-source contributor to React").
- redFlags: list 0–4 specific concerns (e.g. "No TypeScript mentioned", "Frequent short tenures <1 year", "No leadership experience for senior role").
- If there is no evidence for a concern, do NOT invent redFlags.
- aiSummary: write in third person as a briefing a VP of Engineering would read before a 30-minute intro call.

Respond with ONLY the JSON object.`;
  }

  /**
   * Builds the per-request user prompt that injects the candidate profile and
   * job requirements into the conversation.
   *
   * The candidate JSON is serialized with 2-space indentation so the model can
   * easily identify individual fields in its reasoning phase.
   *
   * @param candidate - Profile to evaluate.
   * @param query     - The open role.
   */
  private _buildUserPrompt(
    candidate: RawCandidateProfile,
    query: JobSearchQuery,
  ): string {
    // Omit rawHtml from the LLM payload — it's large, noisy, and irrelevant
    // to the evaluation; including it would waste tokens and degrade quality.
    const { rawHtml: _rawHtml, ...profileForLlm } = candidate;

    return `## Open Role

- **Job Title**: ${query.jobTitle}
- **Required Keywords / Skills**: ${query.keywords.join(', ')}
${query.location ? `- **Location**: ${query.location}` : ''}

## Candidate Profile

\`\`\`json
${JSON.stringify(profileForLlm, null, 2)}
\`\`\`

Evaluate this candidate for the open role described above and respond with ONLY the JSON object.`;
  }

  // ── Response processing ────────────────────────────────────────────────────

  /**
   * Extracts the plain-text content from the Anthropic message response.
   * Ignores `thinking` blocks (which are present when adaptive thinking is on)
   * and returns only the text of the first `text` block.
   *
   * @param message - The full response from `client.messages.create()`.
   * @throws {AnalysisError} If no text block is found in the response.
   */
  private _extractTextContent(message: Anthropic.Message): string {
    for (const block of message.content) {
      if (block.type === 'text') {
        return block.text.trim();
      }
    }
    throw new AnalysisError(
      '[AnalyzerAgent] LLM response contained no text block.',
      JSON.stringify(message.content),
    );
  }

  /**
   * Parses the raw LLM output as JSON and validates it against the expected
   * `LlmAnalysisResult` schema.
   *
   * Strips leading/trailing markdown code fences if the model added them
   * despite instructions, then calls `JSON.parse()`.  Validates that all
   * required fields are present and of the correct types.
   *
   * @param raw - The raw text returned by the LLM.
   * @throws {AnalysisError} On JSON parse failure or schema validation failure.
   */
  private _parseAndValidate(raw: string): LlmAnalysisResult {
    // Strip markdown code fences the model occasionally adds despite instructions.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new AnalysisError(
        `[AnalyzerAgent] Failed to parse LLM response as JSON: ${(e as Error).message}`,
        raw,
      );
    }

    // Runtime type guard — validate required fields.
    const errors = this._validateSchema(parsed);
    if (errors.length > 0) {
      throw new AnalysisError(
        `[AnalyzerAgent] LLM response failed schema validation: ${errors.join('; ')}`,
        raw,
      );
    }

    return parsed as LlmAnalysisResult;
  }

  /**
   * Validates that `value` has the correct shape for `LlmAnalysisResult`.
   *
   * Returns an array of human-readable error strings (empty = valid).
   * Using this approach (vs. a library) keeps the agent dependency-free and
   * easy to read.
   *
   * @param value - The parsed JSON value to validate.
   */
  private _validateSchema(value: unknown): string[] {
    const errors: string[] = [];

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return ['root value must be a JSON object'];
    }

    const obj = value as Record<string, unknown>;

    // matchScore: integer 0–100
    if (typeof obj['matchScore'] !== 'number' || !Number.isFinite(obj['matchScore'])) {
      errors.push('matchScore must be a number');
    } else if (obj['matchScore'] < 0 || obj['matchScore'] > 100) {
      errors.push(`matchScore ${obj['matchScore']} is out of range [0, 100]`);
    }

    // aiSummary: non-empty string
    if (typeof obj['aiSummary'] !== 'string' || obj['aiSummary'].trim() === '') {
      errors.push('aiSummary must be a non-empty string');
    }

    // greenFlags: array of strings
    if (!Array.isArray(obj['greenFlags'])) {
      errors.push('greenFlags must be an array');
    } else if (obj['greenFlags'].some((f) => typeof f !== 'string')) {
      errors.push('greenFlags must contain only strings');
    }

    // redFlags: array of strings
    if (!Array.isArray(obj['redFlags'])) {
      errors.push('redFlags must be an array');
    } else if (obj['redFlags'].some((f) => typeof f !== 'string')) {
      errors.push('redFlags must contain only strings');
    }

    // email: optional — but when present must be a string or null
    const emailVal = obj['email'];
    if (emailVal !== undefined && emailVal !== null && typeof emailVal !== 'string') {
      errors.push('email must be a string, null, or omitted');
    }

    // phone: optional — but when present must be a string or null
    const phoneVal = obj['phone'];
    if (phoneVal !== undefined && phoneVal !== null && typeof phoneVal !== 'string') {
      errors.push('phone must be a string, null, or omitted');
    }

    return errors;
  }
}
