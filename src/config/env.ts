/**
 * @file src/config/env.ts
 * @description Centralised, strictly-typed environment configuration.
 *
 * All environment variables consumed by this application are validated and
 * exported from this single module.  Nothing else in the codebase should call
 * `process.env` directly — import from here instead.
 *
 * Design decisions
 * ─────────────────
 * • Fail-fast: if a required variable is missing the process exits with a
 *   descriptive error so the problem is caught at startup, not deep in a
 *   request handler.
 * • Explicit defaults: optional variables have sensible defaults defined here,
 *   not scattered across business logic.
 * • Single source of truth: adding a new variable means editing only this file;
 *   callers just `import { env } from './config/env'`.
 */

import dotenv from 'dotenv';
import path from 'path';

// ─── Load .env before anything else reads process.env ──────────────────────
// `dotenv.config()` is a no-op when running in production with real env vars,
// so it is safe to call unconditionally.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Reads a required string variable from `process.env`.
 * Throws a descriptive error and exits if the variable is absent or empty.
 * Exported so callers can extend `env` with their own required variables.
 *
 * @param key - The environment variable name.
 * @returns The trimmed string value.
 */
export function requireString(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`[Config] FATAL — missing required environment variable: "${key}"`);
    process.exit(1);
  }
  return value;
}

/**
 * Reads an optional string variable from `process.env`.
 *
 * @param key          - The environment variable name.
 * @param defaultValue - Fallback value when the variable is absent.
 * @returns The trimmed string value or the default.
 */
function optionalString(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

/**
 * Reads a required integer variable from `process.env`.
 * Throws a descriptive error if the variable is absent, empty, or not parseable
 * as a valid integer.
 * Exported so callers can extend `env` with their own required integer variables.
 *
 * @param key - The environment variable name.
 * @returns The parsed integer value.
 */
export function requireInt(key: string): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    console.error(`[Config] FATAL — missing required environment variable: "${key}"`);
    process.exit(1);
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.error(`[Config] FATAL — environment variable "${key}" must be a valid integer, got: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Reads an optional integer variable from `process.env`.
 *
 * @param key          - The environment variable name.
 * @param defaultValue - Fallback value when the variable is absent or unparseable.
 * @returns The parsed integer or the default.
 */
function optionalInt(key: string, defaultValue: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ─── Application Environment Type ──────────────────────────────────────────

/**
 * Allowed deployment environments.
 * Using a union type means any code that branches on `env.NODE_ENV` benefits
 * from exhaustiveness checking.
 */
export type NodeEnv = 'development' | 'staging' | 'production' | 'test';

// ─── Parsed & Validated Environment Object ─────────────────────────────────

/**
 * The fully-typed, validated configuration derived from environment variables.
 * Import and use `env` everywhere instead of reading `process.env` ad-hoc.
 *
 * @example
 * ```ts
 * import { env } from './config/env';
 * app.listen(env.PORT, () => console.log(`Listening on ${env.PORT}`));
 * ```
 */
export const env = {
  // ── Server ────────────────────────────────────────────────────────
  /** HTTP port the Express server listens on. Defaults to 3000. */
  PORT: optionalInt('PORT', 3002),

  /** Deployment environment. Defaults to 'development'. */
  NODE_ENV: optionalString('NODE_ENV', 'development') as NodeEnv,

  // ── AI / LLM ─────────────────────────────────────────────────────
  /**
   * OpenAI API key — required for LangChain LLM integrations.
   * Uncomment and switch to `requireString` when LLM features are active.
   */
  // OPENAI_API_KEY: requireString('OPENAI_API_KEY'),

  // ── Anthropic / Claude ────────────────────────────────────────────
  /**
   * Anthropic API key — required for all Claude LLM calls.
   * Validated at startup: the server will not start without this value.
   */
  ANTHROPIC_API_KEY: requireString('ANTHROPIC_API_KEY'),

  // ── LinkedIn / Proxycurl ──────────────────────────────────────────
  /**
   * Base URL for the Proxycurl-compatible LinkedIn scraping API.
   *
   * Validated at `LinkedInApiStrategy` construction time, not here, so that
   * the server can start without these variables when LinkedIn scraping is
   * not in use.  An empty string is the sentinel for "not configured".
   *
   * @example 'https://nubela.co/proxycurl'
   */
  LINKEDIN_API_URL: optionalString('LINKEDIN_API_URL', ''),

  /**
   * Bearer token / API key for the Proxycurl API.
   *
   * Same deferred-validation strategy as `LINKEDIN_API_URL`.
   * Never log or expose this value — treat it as a password.
   */
  LINKEDIN_API_KEY: optionalString('LINKEDIN_API_KEY', ''),

  // ── IMAP / Outlook (optional — inbound email sourcing) ───────────
  /**
   * IMAP server hostname.
   *
   * Defaults to Microsoft 365 / Outlook's standard IMAP endpoint.
   * Override for Gmail (`imap.gmail.com`), Yahoo, or on-premises Exchange.
   */
  IMAP_HOST: optionalString('IMAP_HOST', 'imap.gmail.com'),

  /**
   * IMAP server port.  Defaults to 993 (IMAPS / TLS).
   */
  IMAP_PORT: optionalInt('IMAP_PORT', 993),

  /**
   * IMAP username — typically the full email address of the recruitment inbox.
   * Empty string when IMAP sourcing is not in use.
   * @example 'recruiter@company.com'
   */
  IMAP_USER: optionalString('IMAP_USER', 'mgl1send@gmail.com'),

  /**
   * IMAP password (or App Password when 2FA is enabled).
   * Never log or expose this value — treat it as a password.
   * Empty string when IMAP sourcing is not in use.
   */


  
  
  IMAP_PASSWORD: optionalString('IMAP_PASSWORD', 'indn iusf sfty fsas'),

  /**
   * Maximum number of emails to fetch per `execute()` call.
   * Prevents runaway fetches on inboxes with thousands of messages.
   * @default 20
   */
  IMAP_MAX_EMAILS: optionalInt('IMAP_MAX_EMAILS', 20),

  // ── Add further variables below following the same pattern ────────
  // DATABASE_URL: requireString('DATABASE_URL'),
  // REDIS_URL: optionalString('REDIS_URL', 'redis://localhost:6379'),
} as const;

// ─── Startup Log ───────────────────────────────────────────────────────────
// Only log in development to avoid leaking config details in production logs.
if (env.NODE_ENV === 'development') {
  console.log('[Config] Environment loaded:', {
    NODE_ENV:           env.NODE_ENV,
    PORT:               env.PORT,
    ANTHROPIC_API_KEY:  env.ANTHROPIC_API_KEY ? '(set ✓)' : '(not set)',
    LINKEDIN_API_URL:   env.LINKEDIN_API_URL  || '(not set)',
    LINKEDIN_API_KEY:   env.LINKEDIN_API_KEY  ? '(set ✓)'  : '(not set)',
    IMAP_HOST:          env.IMAP_HOST,
    IMAP_USER:          env.IMAP_USER          || '(not set)',
    IMAP_PASSWORD:      env.IMAP_PASSWORD      ? '(set ✓)'  : '(not set)',
  });
}
