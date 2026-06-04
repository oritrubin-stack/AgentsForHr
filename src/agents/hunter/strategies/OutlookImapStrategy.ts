/**
 * @file src/agents/hunter/strategies/OutlookImapStrategy.ts
 * @description Inbound-sourcing strategy that reads candidate CVs / applications
 * from an IMAP mailbox (Microsoft 365 / Outlook by default, but compatible with
 * any IMAP server).
 *
 * Architecture position
 * ──────────────────────
 * ```
 *   IMAP Inbox (Outlook / Gmail / …)
 *        │  raw email messages
 *        ▼
 *   OutlookImapStrategy.execute()   ◄── you are here
 *        │  imapflow + mailparser
 *        ▼
 *   RawCandidateProfile[]
 *        │
 *   AnalyzerAgent (LLM evaluation)
 * ```
 *
 * IMAP connection strategy
 * ─────────────────────────
 * `imapflow` is used as the IMAP client.  It handles STARTTLS negotiation,
 * IDLE, and connection pooling.  Connections are opened per `execute()` call
 * and closed with `logout()` when done — keeping state simple and safe for
 * concurrent requests.
 *
 * Email parsing
 * ──────────────
 * `mailparser`'s `simpleParser` turns raw MIME messages into a structured
 * `ParsedMail` object.  The strategy extracts:
 *  • Sender name → `name`
 *  • Sender address → `email`
 *  • Body plain text → `summary` (full CV / application text for the LLM)
 *  • Phone numbers → `phone` (extracted via regex from body text)
 *  • Subject → used to infer `currentRole` and `source`
 *  • HTML body → `rawHtml` (preserved for debugging)
 *
 * Source detection
 * ─────────────────
 * The `detectSource()` method classifies incoming emails by the sender's domain
 * and subject keywords to produce a human-readable source label.  This is used
 * by HR dashboards to see which job boards are sending candidates.
 *
 * Testability
 * ────────────
 * `detectSource()` and `parseEmailToProfile()` are `public static` methods so
 * the smoke test can exercise the parsing logic without a real IMAP connection.
 * The constructor validates credentials eagerly so mis-configuration is caught
 * at startup rather than during the first `execute()` call.
 *
 * Error handling
 * ───────────────
 * IMAP connection failures are wrapped in `ScrapingError`.  Individual message
 * parse failures are logged as warnings and skipped so one bad email does not
 * abort the whole fetch.
 */

import { ImapFlow, ImapFlowOptions, FetchMessageObject, Logger as ImapLogger } from 'imapflow';
import { simpleParser, ParsedMail, EmailAddress, Attachment } from 'mailparser';
import pdfParse                                                 from 'pdf-parse';
import mammoth                                                 from 'mammoth';
import { env }                                                 from '../../../config/env';
import {
  JobSearchQuery,
  RawCandidateProfile,
  SupportedPlatform,
} from '../../../types/candidate.types';
import { IScraperStrategy, ScrapingError } from './IScraperStrategy';

// ─── Constructor options ──────────────────────────────────────────────────────

/**
 * Optional overrides for the `OutlookImapStrategy` constructor.
 * All fields fall back to the corresponding `env.*` variables when omitted.
 */
export interface OutlookImapStrategyOptions {
  /**
   * IMAP server hostname.
   * @default env.IMAP_HOST ('outlook.office365.com')
   */
  host?: string;

  /**
   * IMAP server port.
   * @default env.IMAP_PORT (993)
   */
  port?: number;

  /**
   * IMAP username (typically the full email address of the recruitment inbox).
   * @default env.IMAP_USER
   */
  user?: string;

  /**
   * IMAP password or App Password.
   * @default env.IMAP_PASSWORD
   */
  password?: string;

  /**
   * Maximum emails to fetch per `execute()` call.
   * @default env.IMAP_MAX_EMAILS (20)
   */
  maxEmails?: number;
}

// ─── Strategy implementation ──────────────────────────────────────────────────

/**
 * Inbound-sourcing strategy for the `'email'` platform.
 *
 * Connects to an IMAP mailbox, fetches recent messages, parses each one with
 * `mailparser`, and maps the extracted text into a `RawCandidateProfile` ready
 * for the Analyzer Agent.
 *
 * @implements {IScraperStrategy}
 *
 * @example Production usage
 * ```ts
 * // Credentials come from env vars (IMAP_HOST, IMAP_USER, IMAP_PASSWORD)
 * const strategy = new OutlookImapStrategy();
 * const profiles = await strategy.execute(query);
 * ```
 *
 * @example Test usage — static methods only (no IMAP connection)
 * ```ts
 * const source  = OutlookImapStrategy.detectSource('jobs@drushim.co.il', 'New CV');
 * // → 'Drushim IL'
 *
 * const profile = OutlookImapStrategy.parseEmailToProfile(mockParsedMail);
 * // → RawCandidateProfile | null
 * ```
 */
export class OutlookImapStrategy implements IScraperStrategy {
  /** This strategy handles the 'email' platform exclusively. */
  readonly platform: SupportedPlatform = 'email';

  private readonly imapHost:     string;
  private readonly imapPort:     number;
  private readonly imapUser:     string;
  private readonly imapPassword: string;
  private readonly maxEmails:    number;

  /**
   * @param options - Optional overrides for IMAP connection settings.
   * @throws {ScrapingError} If `IMAP_USER` or `IMAP_PASSWORD` are not set
   *   and no overrides are provided — fail fast rather than getting an
   *   authentication error on the first request.
   */
  constructor(options: OutlookImapStrategyOptions = {}) {
    this.imapHost     = options.host      ?? env.IMAP_HOST;
    this.imapPort     = options.port      ?? env.IMAP_PORT;
    this.imapUser     = options.user      ?? env.IMAP_USER;
    this.imapPassword = options.password  ?? env.IMAP_PASSWORD;
    this.maxEmails    = options.maxEmails ?? env.IMAP_MAX_EMAILS;

    if (!this.imapUser.trim()) {
      throw new ScrapingError({
        message:  'IMAP_USER is not configured. Set it in your .env file.',
        platform: 'email',
        retryable: false,
      });
    }
    if (!this.imapPassword.trim()) {
      throw new ScrapingError({
        message:  'IMAP_PASSWORD is not configured. Set it in your .env file.',
        platform: 'email',
        retryable: false,
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Connects to the IMAP inbox, fetches up to `maxEmails` recent messages
   * (most recent first), parses each as a `RawCandidateProfile`, and returns
   * the successfully parsed profiles.
   *
   * One message parse failure does NOT abort the batch — it is logged and
   * skipped.  Only hard IMAP connection failures throw a `ScrapingError`.
   *
   * @param query - `query.maxResults` overrides `maxEmails` if supplied and
   *   is lower — this lets the Orchestrator cap the batch size from above.
   * @returns Array of raw profiles; empty when the inbox has no messages.
   * @throws {ScrapingError} On IMAP authentication or connection failure.
   */
  async execute(query: JobSearchQuery): Promise<RawCandidateProfile[]> {
    const limit  = Math.min(query.maxResults ?? this.maxEmails, this.maxEmails);
    const profiles: RawCandidateProfile[] = [];

    console.log(
      `[OutlookImapStrategy] Connecting to ${this.imapHost}:${this.imapPort} ` +
      `as "${this.imapUser}" — fetching up to ${limit} messages.`,
    );

    // ── Protocol-level debug logger ───────────────────────────────────────────
    // TEMPORARY: enabled to diagnose IMAP handshake / auth failures.
    // The imapflow Logger interface requires exactly: debug, info, warn, error.
    // We silence the noisy debug/info tiers and only surface warn + error so
    // the IMAP server's exact response code (e.g. AUTHENTICATIONFAILED) is
    // visible in the process logs without flooding the console.
    // ↳ Revert to `logger: false` once the root cause is identified.
    const imapLogger: ImapLogger = {
      debug: (_obj: unknown): void => { /* intentionally silent */ },
      info:  (_obj: unknown): void => { /* intentionally silent */ },
      warn:  (obj: unknown):  void => console.warn( '[IMAP Warn] ',  JSON.stringify(obj)),
      error: (obj: unknown):  void => console.error('[IMAP Error]',  JSON.stringify(obj)),
    };

    const clientOptions: ImapFlowOptions = {
      host:   this.imapHost,
      port:   this.imapPort,
      secure: true,                              // implicit TLS — always on port 993
      tls:    { rejectUnauthorized: true },      // reject self-signed / expired certs
      auth:   { user: this.imapUser, pass: this.imapPassword },
      logger: imapLogger,
    };

    const client = new ImapFlow(clientOptions);

    // ── Connection attempt (detailed error logging) ───────────────────────────
    try {
      await client.connect();
    } catch (err) {
      // Log the raw imapflow error object first — this is where the server's
      // exact IMAP response appears (e.g. "AUTHENTICATIONFAILED", a TLS alert
      // string, ECONNREFUSED, ENOTFOUND …).
      console.error('[IMAP Connection Error]:', err);

      const rawMessage = err instanceof Error ? err.message : String(err);
      const hint       = OutlookImapStrategy._imapErrorHint(rawMessage);

      throw new ScrapingError({
        message:   `IMAP connection to "${this.imapHost}" failed: ${rawMessage}${hint}`,
        platform:  'email',
        retryable: true,
        cause:     err instanceof Error ? err : undefined,
      });
    }

    const lock = await client.getMailboxLock('INBOX');

    try {
      // `fetchAll` returns all messages in one shot; we slice to `limit`.
      // For large inboxes, a cursor-based approach (SEARCH + partial FETCH)
      // would be more efficient — this implementation keeps the code simple
      // while the feature is proven in production.
      const allMessages: FetchMessageObject[] = await client.fetchAll(
        '1:*',
        { source: true, envelope: true },
      );

      // Most-recent first
      const slice = allMessages.reverse().slice(0, limit);

      for (const msg of slice) {
        if (!msg.source) continue;

        let parsed: ParsedMail;
        try {
          parsed = await simpleParser(msg.source);
        } catch (parseErr) {
          console.warn(
            `[OutlookImapStrategy] Failed to parse message seq=${msg.seq}: ` +
            `${(parseErr as Error).message}`,
          );
          continue;
        }

        const profile = OutlookImapStrategy.parseEmailToProfile(parsed);
        if (profile) {
          // Enrich the candidate summary with text extracted from any
          // attached CV files (PDF / DOCX).  This is the critical path for
          // getting a good AI match score — without attachment text the LLM
          // only sees the email body, which is usually just a cover note.
          if (parsed.attachments && parsed.attachments.length > 0) {
            const attachmentText = await OutlookImapStrategy._extractAttachmentText(
              parsed.attachments,
            );
            if (attachmentText) {
              profile.summary = profile.summary
                ? `${profile.summary}\n\n--- Attached CV ---\n\n${attachmentText}`
                : attachmentText;
            }
          }
          profiles.push(profile);
        }
      }

    } finally {
      lock.release();
      await client.logout();
    }

    console.log(
      `[OutlookImapStrategy] Fetched ${profiles.length} profile(s) from inbox.`,
    );

    return profiles;
  }

  // ── Static parsing helpers (public for testability) ────────────────────────

  /**
   * Classifies an incoming email into a named sourcing channel based on the
   * sender's domain and the email subject line.
   *
   * This is the single place where job-board domain knowledge is concentrated.
   * Add new patterns here as new sourcing channels are discovered.
   *
   * @param fromAddress - Full sender email address (e.g. `jobs@drushim.co.il`).
   * @param subject     - Email subject line.
   * @returns A human-readable source label for the HR dashboard.
   *
   * @example
   * ```ts
   * OutlookImapStrategy.detectSource('jobs@drushim.co.il', 'New CV');
   * // → 'Drushim IL'
   *
   * OutlookImapStrategy.detectSource('noreply@facebookmail.com', 'Job Application');
   * // → 'Facebook Jobs'
   *
   * OutlookImapStrategy.detectSource('john.doe@gmail.com', 'My CV for SWE role');
   * // → 'Direct Email'
   * ```
   */
  static detectSource(fromAddress: string, subject: string): string {
    const from = fromAddress.toLowerCase();
    const subj = subject.toLowerCase();

    // ── Israeli job boards ────────────────────────────────────────────────────
    if (from.includes('drushim.co.il') || subj.includes('drushim')) {
      return 'Drushim IL';
    }
    if (from.includes('alljobs.co.il') || subj.includes('alljobs')) {
      return 'AllJobs';
    }
    if (from.includes('jobmaster.co.il') || subj.includes('jobmaster')) {
      return 'JobMaster';
    }
    // 'runner' by itself is too generic as an English word; domain check is
    // primary.  Subject keyword is included for forwarded runner.co.il alerts.
    if (from.includes('runner.co.il') || from.includes('runner-jobs.co.il') || subj.includes('runner')) {
      return 'Runner';
    }
    if (from.includes('jobnet.co.il') || subj.includes('jobnet')) {
      return 'Jobnet IL';
    }
    if (from.includes('gotfriends.co.il') || subj.includes('gotfriends')) {
      return 'GotFriends IL';
    }

    // ── Tech community channels (Facebook groups / Telegram / WhatsApp) ───────
    // Emails forwarded from known Israeli tech job-hunting communities carry
    // the group name in the subject line.  All of these resolve to 'Tech Community'.
    if (
      subj.includes('משרות embedded')      ||  // "Embedded Jobs" FB group
      subj.includes('rt embedded israel')  ||  // RT Embedded Israel Telegram
      subj.includes('מהנדסי firmware')     ||  // Firmware Engineers IL group
      subj.includes('firmware בישראל')     ||  // variant: "firmware in Israel"
      subj.includes('linux/kernel')        ||  // Linux/Kernel community
      subj.includes('linux kernel')            // alternate spacing
    ) {
      return 'Tech Community';
    }

    // ── International platforms ────────────────────────────────────────────────
    if (
      from.includes('facebookmail.com') ||
      from.includes('@facebook.com')    ||
      subj.includes('facebook jobs')
    ) {
      return 'Facebook Jobs';
    }

    // LinkedIn direct notifications AND LinkedIn X-Ray sourcing
    // (X-Ray = Google "site:linkedin.com" searches forwarded to this inbox).
    if (
      from.includes('linkedin.com') ||
      subj.includes('linkedin')     ||
      subj.includes('x-ray')        ||
      subj.includes('xray')
    ) {
      return 'LinkedIn / X-Ray';
    }

    if (from.includes('indeed.com') || subj.includes('indeed')) {
      return 'Indeed';
    }
    if (from.includes('glassdoor.com') || subj.includes('glassdoor')) {
      return 'Glassdoor';
    }
    if (from.includes('stackoverflow.com') || subj.includes('stack overflow')) {
      return 'Stack Overflow';
    }

    // ── Catch-all ─────────────────────────────────────────────────────────────
    // Every unrecognised email (direct CV, referral, etc.) is still a valid
    // inbound lead and must be processed by the Analyzer Agent.
    return 'Direct Email';
  }

  /**
   * Converts a `mailparser` `ParsedMail` object into a `RawCandidateProfile`.
   *
   * Returns `null` if the email cannot be mapped to a meaningful profile (e.g.
   * it has no text body and no sender name — likely a system notification).
   *
   * @param mail - The parsed email from `mailparser.simpleParser()`.
   * @returns A `RawCandidateProfile`, or `null` if the email should be skipped.
   */
  static parseEmailToProfile(mail: ParsedMail): RawCandidateProfile | null {
    // ── Sender details ────────────────────────────────────────────────────────
    const senderAddr: EmailAddress | undefined =
      (mail.from?.value ?? [])[0];

    const senderEmail  = senderAddr?.address?.trim() ?? null;
    const senderName   = senderAddr?.name?.trim()    || null;

    // If there is no body and no sender name, skip — it's not a CV email.
    const bodyText = mail.text?.trim() ?? '';
    if (!bodyText && !senderName) return null;

    // ── Source detection ──────────────────────────────────────────────────────
    const subject = mail.subject?.trim() ?? '';
    const source  = OutlookImapStrategy.detectSource(senderEmail ?? '', subject);

    // ── Profile URL — use Message-ID as a stable unique key ──────────────────
    const messageId  = mail.messageId?.trim() ?? '';
    const profileUrl = messageId
      ? `email://${messageId.replace(/[<>]/g, '')}`
      : `email://${senderEmail ?? 'unknown'}@${(mail.date ?? new Date()).getTime()}`;

    // ── Contact extraction ────────────────────────────────────────────────────
    const phone = OutlookImapStrategy._extractPhone(bodyText);

    // ── Role extraction from subject ──────────────────────────────────────────
    const currentRole = OutlookImapStrategy._extractRoleFromSubject(subject);

    return {
      profileUrl,
      platform:    'email',
      source,
      name:        senderName,
      email:       senderEmail,
      phone,
      currentRole,
      location:    null,
      // Full email body is the "summary" — the AnalyzerAgent reads this as the CV text.
      summary:     bodyText || null,
      skills:      [], // Extracted by AnalyzerAgent from the summary text
      experience:  [],
      education:   [],
      scrapedAt:   mail.date ?? new Date(),
      rawHtml:     typeof mail.html === 'string' ? mail.html : null,
    };
  }

  // ── Private static helpers ─────────────────────────────────────────────────

  /**
   * Extracts plain text from all CV attachment files in a parsed email.
   *
   * Supported formats
   * ──────────────────
   * • `application/pdf` / `.pdf`  — uses `pdf-parse` (PDFParse class API)
   * • `.docx` / `application/vnd.openxmlformats-officedocument.…` — uses `mammoth`
   * • `.doc` / `application/msword` (legacy Word) — attempted via `mammoth`;
   *   succeeds for simple files, silently skipped when mammoth cannot parse them
   *
   * Each attachment is processed independently; a failure on one file is logged
   * as a warning and does not affect the others.
   *
   * @param attachments - The `attachments` array from a `mailparser` `ParsedMail`.
   * @returns Concatenated plain text from all successfully parsed attachments,
   *   separated by double newlines.  Empty string when nothing could be extracted.
   */
  private static async _extractAttachmentText(
    attachments: Attachment[],
  ): Promise<string> {
    const parts: string[] = [];

    for (const att of attachments) {
      if (!att.content) continue;

      const ct       = (att.contentType ?? '').toLowerCase();
      const filename = (att.filename    ?? '').toLowerCase();

      try {
        if (ct.includes('pdf') || filename.endsWith('.pdf')) {
          // pdf-parse v1 API: plain async function, returns { text, numpages, … }
          const result = await pdfParse(att.content);
          const text   = result.text?.trim();
          if (text) parts.push(text);

        } else if (
          ct.includes('openxmlformats')  ||   // .docx MIME type
          ct.includes('msword')          ||   // .doc legacy MIME type
          filename.endsWith('.docx')     ||
          filename.endsWith('.doc')
        ) {
          const result = await mammoth.extractRawText({ buffer: att.content });
          const text   = result.value?.trim();
          if (text) parts.push(text);
        }
      } catch (attachErr) {
        console.warn(
          `[OutlookImapStrategy] Could not extract text from attachment ` +
          `"${att.filename ?? 'unnamed'}" (${att.contentType ?? 'unknown type'}): ` +
          `${(attachErr as Error).message}`,
        );
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Returns a short, actionable hint for well-known IMAP error strings.
   * The hint is appended to the `ScrapingError` message so the log entry
   * is immediately useful without having to look up IMAP RFCs.
   *
   * Covered cases
   * ─────────────
   * • `AUTHENTICATIONFAILED` / `invalid credentials` — wrong password or
   *   Basic Auth disabled in Microsoft 365 (common after the M365 auth
   *   policy change — an App Password is required).
   * • `AUTHENTICATE` / `auth failed` — server rejected the AUTH mechanism;
   *   may need OAuth2 / modern auth instead of plain Basic.
   * • `certificate` / `self signed` / `ssl` — TLS handshake failure; check
   *   that `IMAP_HOST` is correct and the cert is valid.
   * • `ECONNREFUSED` — nothing is listening on that port.
   * • `ENOTFOUND` / `getaddrinfo` — hostname cannot be resolved.
   * • `greeting` / `banner` — server closed the connection before sending
   *   the IMAP greeting; IMAP may be disabled for the account/tenant.
   *
   * @param rawMessage - The `.message` string from the caught error.
   * @returns A hint string (with leading ' — ') or an empty string.
   */
  private static _imapErrorHint(rawMessage: string): string {
    const m = rawMessage.toLowerCase();

    if (m.includes('authenticationfailed') || m.includes('invalid credentials')) {
      return ' — Check IMAP_USER / IMAP_PASSWORD. For Microsoft 365, Basic'
           + ' Authentication may be disabled; create an App Password in your'
           + ' Microsoft account security settings.';
    }
    if (m.includes('authenticate') || m.includes('auth failed')) {
      return ' — The server rejected the AUTH mechanism. Consider enabling an'
           + ' App Password or switching to OAuth2 in your M365 tenant policy.';
    }
    if (m.includes('certificate') || m.includes('self signed') || m.includes('ssl')) {
      return ' — TLS/certificate error. Verify that IMAP_HOST is correct and'
           + ' the server certificate is valid (not self-signed or expired).';
    }
    if (m.includes('econnrefused')) {
      return ' — Connection refused. Verify IMAP_HOST and IMAP_PORT (993 for'
           + ' implicit TLS, 143 for STARTTLS).';
    }
    if (m.includes('enotfound') || m.includes('getaddrinfo')) {
      return ' — Hostname not found. Double-check the value of IMAP_HOST.';
    }
    if (m.includes('greeting') || m.includes('banner')) {
      return ' — Server closed the connection before sending its IMAP greeting.'
           + ' IMAP access may be disabled for this account or tenant.';
    }

    return ''; // No specific hint available — the raw message is the best clue
  }

  /**
   * Extracts the first phone number found in `text` using a regex that matches
   * common international and Israeli phone formats.
   *
   * Returns the first match as a trimmed string, or `null` if none is found.
   *
   * @param text - Plain-text email body.
   */
  private static _extractPhone(text: string): string | null {
    if (!text) return null;

    // Matches patterns like:
    //   +972-54-123-4567  (international with hyphens — 12 digits)
    //   054-987-6543       (local Israeli — 10 digits)
    //   +1 (415) 555-0199 (US with country code + parens — 11 digits)
    //   07911 123456       (UK mobile — 11 digits)
    //
    // Pattern anatomy:
    //   (?:\+?\d{1,3}[\s\-.]?)?           — optional country code (+1, +972, …)
    //   (?:\(\d{1,4}\)[\s\-.]?)?           — optional area code in parens ((415) …)
    //   \d{2,4}                            — first local digit group
    //   (?:[\s\-.]?\d{2,4}){1,3}           — 1–3 additional digit groups
    //
    // Minimum 9 digits enforced below to exclude date strings like "2024-03-15".
    const phonePattern =
      /(?:\+?\d{1,3}[\s\-.]?)?(?:\(\d{1,4}\)[\s\-.]?)?\d{2,4}(?:[\s\-.]?\d{2,4}){1,3}/g;

    const matches = text.match(phonePattern);
    if (!matches || matches.length === 0) return null;

    // Return the first match with at least 9 digits — rejects dates (8 digits).
    for (const m of matches) {
      const digitsOnly = m.replace(/\D/g, '');
      if (digitsOnly.length >= 9) {
        return m.trim();
      }
    }

    return null;
  }

  /**
   * Tries to extract the applied-for role from the email subject line.
   *
   * Recognises common application subject patterns and returns the role name,
   * or `null` if the subject does not match a known pattern.
   *
   * @param subject - Email subject line.
   *
   * @example
   * ```ts
   * _extractRoleFromSubject('Application for Senior TypeScript Engineer');
   * // → 'Senior TypeScript Engineer'
   *
   * _extractRoleFromSubject('Hello, I would like to apply');
   * // → null
   * ```
   */
  private static _extractRoleFromSubject(subject: string): string | null {
    if (!subject) return null;

    const patterns = [
      /(?:application|applying)\s+for[:\s]+(.+)/i,
      /cv\s+for[:\s]+(.+)/i,
      /resume\s*[-–:]\s*(.+)/i,
      /(?:candidate|candidacy)\s+for[:\s]+(.+)/i,
      /position[:\s]+(.+)/i,
      /role[:\s]+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(subject);
      const role  = match?.[1]?.trim();
      if (role) return role;
    }

    return null;
  }
}
