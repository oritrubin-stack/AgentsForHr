/**
 * @file src/hooks/useRecruitment.ts
 * @description React hook that encapsulates the entire recruitment API lifecycle.
 *
 * Keeps all async state (loading / error / data) out of components so
 * SearchForm and ResultsTable are purely presentational.
 */

import { useState, useCallback } from 'react';
import { runCampaign, ApiError } from '../api/recruitment';
import type {
  RecruitRequest,
  RecruitSuccessResponse,
} from '../types/candidate';

export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseRecruitmentState {
  status:    SearchStatus;
  result:    RecruitSuccessResponse | null;
  error:     ApiError | null;
  /** Fire a new campaign search. */
  search:    (payload: RecruitRequest) => Promise<void>;
  /** Reset back to idle (clear results). */
  reset:     () => void;
}

export function useRecruitment(): UseRecruitmentState {
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [result, setResult] = useState<RecruitSuccessResponse | null>(null);
  const [error,  setError]  = useState<ApiError | null>(null);

  const search = useCallback(async (payload: RecruitRequest): Promise<void> => {
    setStatus('loading');
    setError(null);
    setResult(null);

    try {
      const data = await runCampaign(payload);
      setResult(data);
      setStatus('success');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(
        'An unexpected error occurred.',
        0,
        'Unknown Error',
      ));
      setStatus('error');
    }
  }, []);

  const reset = useCallback((): void => {
    setStatus('idle');
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, search, reset };
}
