/**
 * @file src/api/recruitment.ts
 * @description Axios API client for the recruitment backend.
 *
 * All HTTP logic lives here — components never import axios directly.
 * The base URL is empty ("") so every request goes to the same origin,
 * and Vite's dev-server proxy forwards /api/* to localhost:3002.
 */

import axios, { AxiosError } from 'axios';
import type {
  RecruitRequest,
  RecruitSuccessResponse,
  RecruitErrorResponse,
} from '../types/candidate';

// ─── Axios instance ────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: '/',
  timeout: 120_000, // 2 min — LLM calls can take time on large batches
  headers: { 'Content-Type': 'application/json' },
});

// ─── Typed error ───────────────────────────────────────────────────────────

/** Structured error thrown by `runCampaign` so callers get a human message. */
export class ApiError extends Error {
  /** HTTP status code, or 0 for network errors. */
  readonly status: number;
  /** Backend `error` field, e.g. "Validation Error". */
  readonly errorType: string;
  /** Whether the caller should offer a retry. */
  readonly retryable: boolean;
  /** Field that failed validation, if applicable. */
  readonly field?: string;

  constructor(
    message:   string,
    status:    number,
    errorType: string,
    retryable  = false,
    field?:    string,
  ) {
    super(message);
    this.name      = 'ApiError';
    this.status    = status;
    this.errorType = errorType;
    this.retryable = retryable;
    this.field     = field;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ─── API call ──────────────────────────────────────────────────────────────

/**
 * POSTs to `/api/recruit` and returns the parsed success response.
 *
 * Maps all server-side error shapes (400 / 502 / 503 / 500) into a typed
 * `ApiError` so UI components only need a single catch branch.
 *
 * @param payload - Search parameters from the form.
 * @returns The full `RecruitSuccessResponse` (candidates + telemetry).
 * @throws {ApiError} for any non-2xx response or network failure.
 */
export async function runCampaign(
  payload: RecruitRequest,
): Promise<RecruitSuccessResponse> {
  try {
    const { data } = await api.post<RecruitSuccessResponse>('/api/recruit', payload);
    return data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<RecruitErrorResponse>;
      const status   = axiosErr.response?.status ?? 0;
      const body     = axiosErr.response?.data;

      if (body && body.success === false) {
        throw new ApiError(
          body.message,
          status,
          body.error ?? 'Unknown Error',
          body.retryable ?? false,
          body.field,
        );
      }

      // Network error or non-JSON response
      throw new ApiError(
        axiosErr.message || 'Network error — could not reach the server.',
        status,
        'Network Error',
        true,
      );
    }

    // Re-throw completely unexpected errors
    throw err;
  }
}
