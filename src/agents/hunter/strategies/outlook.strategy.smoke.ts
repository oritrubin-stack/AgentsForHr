/**
 * @file src/agents/hunter/strategies/outlook.strategy.smoke.ts
 * @description Smoke tests for OutlookImapStrategy's static parsing logic.
 *
 * Testing approach — zero IMAP / network dependencies
 * ──────────────────────────────────────────────────────
 * `detectSource()` and `parseEmailToProfile()` are `public static` methods on
 * `OutlookImapStrategy`.  We call them directly with handcrafted `ParsedMail`
 * fixture objects so there is no IMAP connection, no mailparser dependency on
 * network, and no env-var credentials required.
 *
 * The full IMAP `execute()` lifecycle is integration-tested separately against
 * a real (or Dockerised) IMAP server.
 *
 * Run with:
 *   npx ts-node src/agents/hunter/strategies/outlook.strategy.smoke.ts
 *
 * Tests covered
 * ──────────────
 *  Suite A — detectSource()
 *    1.  Drushim IL sender domain
 *    2.  Drushim IL subject keyword
 *    3.  AllJobs sender domain
 *    4.  Facebook Jobs (facebookmail.com domain)
 *    5.  LinkedIn / X-Ray sender domain
 *    6.  Indeed sender domain
 *    7.  Direct Email (unknown sender / generic subject)
 *    8.  Case-insensitive matching
 *    9.  JobMaster sender domain
 *   10.  Runner sender domain
 *   11.  LinkedIn / X-Ray via x-ray subject keyword
 *   12.  Tech Community — 'משרות Embedded' subject keyword
 *   13.  Tech Community — 'RT Embedded Israel' subject keyword
 *   14.  Tech Community — 'מהנדסי Firmware בישראל' subject keyword
 *   15.  Tech Community — 'Linux/Kernel' subject keyword
 *
 *  Suite B — parseEmailToProfile()
 *    9.  Typical CV email — all fields populated
 *   10.  Israeli phone number extracted from body
 *   11.  E164 international phone extracted
 *   12.  Email with no text body and no name → returns null
 *   13.  profileUrl uses Message-ID when available
 *   14.  profileUrl fallback when no Message-ID
 *   15.  currentRole extracted from "Application for …" subject
 *   16.  currentRole extracted from "CV for …" subject
 *   17.  currentRole is null when subject has no pattern match
 *   18.  rawHtml preserved when present
 *   19.  rawHtml is null when mail.html is false/undefined
 *   20.  source field is derived from sender domain
 *   21.  Markdown-fenced body still returns non-null profile
 */

import { ParsedMail, AddressObject } from 'mailparser';
import { OutlookImapStrategy }       from './OutlookImapStrategy';

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

// ─── ParsedMail fixture factory ───────────────────────────────────────────────

/**
 * Builds a minimal ParsedMail-shaped object for testing.
 * Only the fields our strategy actually reads are required.
 */
function makeMail(overrides: Partial<ParsedMail>): ParsedMail {
  const defaults: Partial<ParsedMail> = {
    from: {
      value: [{ name: 'John Doe', address: 'john.doe@gmail.com' }],
      html:  '<address>John Doe &lt;john.doe@gmail.com&gt;</address>',
      text:  'John Doe <john.doe@gmail.com>',
    } as AddressObject,
    subject:   'Application for Senior TypeScript Engineer',
    messageId: '<abc123@mail.gmail.com>',
    text:
      'Hi,\n\nI am applying for the Senior TypeScript Engineer position.\n\n' +
      'Phone: +972-54-123-4567\nEmail: john.doe@gmail.com\n\n' +
      'Skills: TypeScript, Node.js, AWS\n\nBest regards,\nJohn Doe',
    html:  '<p>Hi,</p><p>I am applying...</p>',
    date:  new Date('2024-03-15T10:30:00Z'),
  };

  return { ...defaults, ...overrides } as ParsedMail;
}

// ─── Suite A — detectSource() ────────────────────────────────────────────────

function testDetectSource(): void {
  console.log('\n📋  Suite A — detectSource()\n');

  const ds = OutlookImapStrategy.detectSource.bind(OutlookImapStrategy);

  assert(
    '1. Drushim IL sender domain',
    ds('jobs@drushim.co.il', 'New Application') === 'Drushim IL',
    `got "${ds('jobs@drushim.co.il', 'New Application')}"`,
  );

  assert(
    '2. Drushim IL subject keyword',
    ds('noreply@example.com', 'CV via Drushim portal') === 'Drushim IL',
    `got "${ds('noreply@example.com', 'CV via Drushim portal')}"`,
  );

  assert(
    '3. AllJobs sender domain',
    ds('alerts@alljobs.co.il', 'New candidate') === 'AllJobs',
    `got "${ds('alerts@alljobs.co.il', 'New candidate')}"`,
  );

  assert(
    '4. Facebook Jobs (facebookmail.com domain)',
    ds('noreply@facebookmail.com', 'Job Application') === 'Facebook Jobs',
    `got "${ds('noreply@facebookmail.com', 'Job Application')}"`,
  );

  assert(
    '5. LinkedIn / X-Ray sender domain',
    ds('jobs-noreply@linkedin.com', 'Application received') === 'LinkedIn / X-Ray',
    `got "${ds('jobs-noreply@linkedin.com', 'Application received')}"`,
  );

  assert(
    '6. Indeed sender domain',
    ds('apply@indeed.com', 'Your application') === 'Indeed',
    `got "${ds('apply@indeed.com', 'Your application')}"`,
  );

  assert(
    '7. Direct Email (unknown sender)',
    ds('jane.smith@hotmail.com', 'My CV for your review') === 'Direct Email',
    `got "${ds('jane.smith@hotmail.com', 'My CV for your review')}"`,
  );

  assert(
    '8. Case-insensitive matching (uppercase domain)',
    ds('JOBS@DRUSHIM.CO.IL', 'NEW CV') === 'Drushim IL',
    `got "${ds('JOBS@DRUSHIM.CO.IL', 'NEW CV')}"`,
  );

  assert(
    '9. JobMaster sender domain',
    ds('alerts@jobmaster.co.il', 'New applicant') === 'JobMaster',
    `got "${ds('alerts@jobmaster.co.il', 'New applicant')}"`,
  );

  assert(
    '10. Runner sender domain',
    ds('noreply@runner.co.il', 'CV submitted') === 'Runner',
    `got "${ds('noreply@runner.co.il', 'CV submitted')}"`,
  );

  assert(
    '11. LinkedIn / X-Ray via x-ray subject keyword',
    ds('john.doe@gmail.com', 'X-Ray search results: Senior Node.js Engineers') === 'LinkedIn / X-Ray',
    `got "${ds('john.doe@gmail.com', 'X-Ray search results: Senior Node.js Engineers')}"`,
  );

  assert(
    "12. Tech Community — 'משרות Embedded' subject keyword",
    ds('someone@gmail.com', '[משרות Embedded] Looking for Embedded Linux 5y exp') === 'Tech Community',
    `got "${ds('someone@gmail.com', '[משרות Embedded] Looking for Embedded Linux 5y exp')}"`,
  );

  assert(
    "13. Tech Community — 'RT Embedded Israel' subject keyword",
    ds('candidate@outlook.com', '[RT Embedded Israel] Senior RTOS Developer available') === 'Tech Community',
    `got "${ds('candidate@outlook.com', '[RT Embedded Israel] Senior RTOS Developer available')}"`,
  );

  assert(
    "14. Tech Community — 'מהנדסי Firmware בישראל' subject keyword",
    ds('dev@gmail.com', '[מהנדסי Firmware בישראל] Firmware Engineer 6YoE') === 'Tech Community',
    `got "${ds('dev@gmail.com', '[מהנדסי Firmware בישראל] Firmware Engineer 6YoE')}"`,
  );

  assert(
    "15. Tech Community — 'Linux/Kernel' subject keyword",
    ds('hacker@proton.me', '[Linux/Kernel] Kernel developer, 10 years experience') === 'Tech Community',
    `got "${ds('hacker@proton.me', '[Linux/Kernel] Kernel developer, 10 years experience')}"`,
  );
}

// ─── Suite B — parseEmailToProfile() ─────────────────────────────────────────

function testParseEmailToProfile(): void {
  console.log('\n📋  Suite B — parseEmailToProfile()\n');

  const parse = OutlookImapStrategy.parseEmailToProfile.bind(OutlookImapStrategy);

  // ── Test 9: Typical CV email — all fields populated ────────────────────────
  const typical = parse(makeMail({}));
  assert('9.  Returns a non-null profile for typical CV email',  typical !== null);

  if (typical) {
    assert('9a. platform is "email"',
      typical.platform === 'email', `got "${typical.platform}"`);

    assert('9b. name is extracted from sender display name',
      typical.name === 'John Doe', `got "${typical.name}"`);

    assert('9c. email is extracted from sender address',
      typical.email === 'john.doe@gmail.com', `got "${typical.email}"`);

    assert('9d. summary contains the body text',
      (typical.summary ?? '').includes('applying for the Senior TypeScript Engineer'),
      `got "${typical.summary?.slice(0, 60)}..."`);

    assert('9e. skills array is empty (extracted by LLM later)',
      typical.skills.length === 0, `got ${typical.skills.length}`);

    assert('9f. experience is empty array',
      typical.experience.length === 0);

    assert('9g. education is empty array',
      typical.education.length === 0);

    assert('9h. scrapedAt is a Date',
      typical.scrapedAt instanceof Date);
  }

  // ── Test 10: Israeli phone extracted from body ─────────────────────────────
  const withIsraeliPhone = parse(makeMail({
    text: 'Hi,\nPhone: 054-987-6543\nBest, Tal',
  }));
  assert('10. Israeli phone (054-...) extracted',
    withIsraeliPhone?.phone === '054-987-6543',
    `got "${withIsraeliPhone?.phone}"`);

  // ── Test 11: E164 international phone extracted ────────────────────────────
  const withE164 = parse(makeMail({
    text: 'Contact me at +1 (415) 555-0199 or via email.',
  }));
  assert('11. E164 international phone extracted',
    withE164?.phone?.replace(/\s/g, '') === '+1(415)555-0199' ||
    (withE164?.phone ?? '').includes('415'),
    `got "${withE164?.phone}"`);

  // ── Test 12: No body + no sender name → null ───────────────────────────────
  const empty = parse(makeMail({
    from: {
      value:  [],
      html:   '',
      text:   '',
    } as AddressObject,
    text: '',
    html: false as unknown as string,
  }));
  assert('12. Email with no body and no sender name returns null',
    empty === null, `got a non-null profile`);

  // ── Test 13: profileUrl uses Message-ID ───────────────────────────────────
  const withMsgId = parse(makeMail({ messageId: '<unique-id-42@server.com>' }));
  assert('13. profileUrl is derived from Message-ID',
    withMsgId?.profileUrl === 'email://unique-id-42@server.com',
    `got "${withMsgId?.profileUrl}"`);

  // ── Test 14: profileUrl fallback when no Message-ID ───────────────────────
  const noMsgId = parse(makeMail({ messageId: undefined }));
  assert('14. profileUrl fallback starts with "email://"',
    (noMsgId?.profileUrl ?? '').startsWith('email://'),
    `got "${noMsgId?.profileUrl}"`);

  // ── Test 15: currentRole from "Application for …" subject ─────────────────
  const appSubject = parse(makeMail({ subject: 'Application for Senior Node.js Developer' }));
  assert('15. currentRole extracted from "Application for …" subject',
    appSubject?.currentRole === 'Senior Node.js Developer',
    `got "${appSubject?.currentRole}"`);

  // ── Test 16: currentRole from "CV for …" subject ──────────────────────────
  const cvSubject = parse(makeMail({ subject: 'CV for Backend Engineer position' }));
  assert('16. currentRole extracted from "CV for …" subject',
    cvSubject?.currentRole === 'Backend Engineer position',
    `got "${cvSubject?.currentRole}"`);

  // ── Test 17: currentRole null when no pattern matches ─────────────────────
  const noPattern = parse(makeMail({ subject: 'Hello, I would like to connect' }));
  assert('17. currentRole is null when subject has no pattern',
    noPattern?.currentRole === null, `got "${noPattern?.currentRole}"`);

  // ── Test 18: rawHtml preserved ────────────────────────────────────────────
  const withHtml = parse(makeMail({ html: '<p>My <strong>CV</strong></p>' }));
  assert('18. rawHtml is preserved from mail.html',
    withHtml?.rawHtml === '<p>My <strong>CV</strong></p>',
    `got "${withHtml?.rawHtml}"`);

  // ── Test 19: rawHtml null when mail.html is falsy ─────────────────────────
  const noHtml = parse(makeMail({ html: false as unknown as string }));
  assert('19. rawHtml is null when mail.html is false',
    noHtml?.rawHtml === null, `got "${noHtml?.rawHtml}"`);

  // ── Test 20: source derived from sender domain ─────────────────────────────
  const drushimMail = parse(makeMail({
    from: {
      value: [{ name: 'Drushim Bot', address: 'cv@drushim.co.il' }],
      html:  '',
      text:  'Drushim Bot <cv@drushim.co.il>',
    } as AddressObject,
  }));
  assert('20. source is "Drushim IL" for drushim.co.il sender',
    drushimMail?.source === 'Drushim IL',
    `got "${drushimMail?.source}"`);

  // ── Test 21: Non-null profile even when body is empty but sender exists ────
  const senderOnly = parse(makeMail({
    text: '',        // empty body
    html: false as unknown as string,
    from: {
      value: [{ name: 'Alice Applicant', address: 'alice@example.com' }],
      html:  '',
      text:  'Alice Applicant <alice@example.com>',
    } as AddressObject,
  }));
  // Has a sender name → should return a profile (phone/summary will be null/empty)
  assert('21. Non-null profile when body is empty but sender name is present',
    senderOnly !== null, 'expected non-null profile');
  if (senderOnly) {
    assert('21a. name is "Alice Applicant"',
      senderOnly.name === 'Alice Applicant', `got "${senderOnly.name}"`);
    assert('21b. phone is null (no body to search)',
      senderOnly.phone === null, `got "${senderOnly.phone}"`);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('='.repeat(60));
  console.log(' OutlookImapStrategy — Smoke Tests');
  console.log('='.repeat(60));

  testDetectSource();
  testParseEmailToProfile();

  console.log('\n' + '='.repeat(60));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main();
