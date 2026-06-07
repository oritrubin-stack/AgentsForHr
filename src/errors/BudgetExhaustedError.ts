/**
 * @file src/errors/BudgetExhaustedError.ts
 * @description Domain error thrown when the Anthropic API returns HTTP 402
 * (Insufficient Credits), signalling that the account has run out of billing
 * credits and no further LLM calls will succeed until the account is topped up.
 *
 * Why a dedicated class?
 * ───────────────────────
 * `Anthropic.APIError` with `status === 402` is the SDK representation.
 * Wrapping it in a domain error decouples the controller's error-handling
 * from SDK internals and makes the intent explicit at every layer.
 *
 * Flow
 * ─────
 * AnalyzerAgent.analyze()       — throws Anthropic.APIError (status 402)
 *   └─ OrchestratorAgent._analyzeAll()  — detects 402 in settled results,
 *                                          re-throws BudgetExhaustedError
 *        └─ RecruitmentController._handleError()  — returns HTTP 402 to client
 */

// ─── BudgetExhaustedError ─────────────────────────────────────────────────────

/**
 * Thrown by the Orchestrator when any analysis call is rejected with
 * Anthropic HTTP 402 (Insufficient Credits).
 *
 * A 402 is a hard stop — no further analysis calls would succeed, so the
 * entire campaign is aborted and this error propagates to the HTTP layer.
 */
export class BudgetExhaustedError extends Error {
  readonly name = 'BudgetExhaustedError' as const;

  constructor() {
    super('Budget Exhausted: Please check your Anthropic billing account');
    Object.setPrototypeOf(this, BudgetExhaustedError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BudgetExhaustedError);
    }
  }
}
