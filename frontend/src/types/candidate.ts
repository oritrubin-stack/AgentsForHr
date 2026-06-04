/**
 * @file src/types/candidate.ts
 * @description Frontend mirror of the backend domain types.
 *
 * These interfaces must stay in sync with:
 *   backend/src/types/candidate.types.ts
 *   backend/src/agents/OrchestratorAgent.ts (CampaignResult)
 *   backend/src/api/controllers/RecruitmentController.ts (RecruitRequestBody)
 */

// ─── Enumerations ────────────────────────────────────────────────────────────

export type SupportedPlatform =
  | 'linkedin'
  | 'github'
  | 'stackoverflow'
  | 'glassdoor'
  | 'indeed'
  | 'email'    // Inbound: candidates arrive via IMAP / Outlook inbox
  | 'mock';

// ─── Nested profile types ─────────────────────────────────────────────────────

export interface WorkExperience {
  title:       string;
  company:     string;
  duration:    string | null;
  description: string | null;
}

export interface Education {
  degree:         string | null;
  institution:    string;
  graduationYear: string | null;
}

// ─── Core profile types ───────────────────────────────────────────────────────

export interface RawCandidateProfile {
  profileUrl:  string;
  platform:    SupportedPlatform;
  /** Originating channel label, e.g. 'Drushim IL', 'LinkedIn', 'Direct Email'. */
  source:      string;
  /** Candidate's contact email (extracted by hunter or LLM). */
  email:       string | null;
  /** Candidate's contact phone number (extracted by hunter or LLM). */
  phone:       string | null;
  name:        string | null;
  currentRole: string | null;
  location:    string | null;
  summary:     string | null;
  skills:      string[];
  experience:  WorkExperience[];
  education:   Education[];
  scrapedAt:   string; // ISO string in JSON
  rawHtml:     string | null;
}

/** RawCandidateProfile enriched by the Analyzer Agent with Claude. */
export interface AnalyzedCandidate extends RawCandidateProfile {
  /** 0–100 fit score. ≥80 = excellent, ≥60 = good, <60 = weak. */
  matchScore: number;
  /** 2–4 sentence executive summary from the LLM. */
  aiSummary:  string;
  /** Positive evidence-based phrases. */
  greenFlags: string[];
  /** Concern or gap phrases. */
  redFlags:   string[];
}

// ─── API request / response ───────────────────────────────────────────────────

export interface RecruitRequest {
  jobTitle:  string;
  keywords?: string[];
  platform?: SupportedPlatform;
  location?: string;
  limit?:    number;
}

export interface RecruitSuccessResponse {
  success:         true;
  count:           number;
  query:           RecruitRequest;
  candidates:      AnalyzedCandidate[];
  totalDiscovered: number;
  totalAnalyzed:   number;
  failedAnalyses:  number;
  warnings:        string[];
  startedAt:       string;
  completedAt:     string;
}

export interface RecruitErrorResponse {
  success:    false;
  error:      string;
  message:    string;
  field?:     string;
  retryable?: boolean;
  platform?:  SupportedPlatform;
}

export type RecruitResponse = RecruitSuccessResponse | RecruitErrorResponse;
