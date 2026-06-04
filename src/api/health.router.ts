/**
 * @file src/api/health.router.ts
 * @description Health-check router.
 *
 * Exposes `GET /api/health` — the canonical liveness probe for load-balancers,
 * Kubernetes, and monitoring services (e.g. Datadog, UptimeRobot).
 *
 * The response body follows a simple, consistent envelope:
 * ```json
 * {
 *   "status": "ok",
 *   "timestamp": "2024-01-15T12:00:00.000Z",
 *   "uptime": 42.3,
 *   "environment": "production"
 * }
 * ```
 *
 * Architecture note
 * ──────────────────
 * Each feature area owns its own Express Router file and is mounted in
 * `src/index.ts`.  This prevents index.ts from growing into a "God file" and
 * makes it trivial to add, remove, or version-prefix entire feature modules.
 */

import { Router, Request, Response } from 'express';
import { env } from '../config/env';

/**
 * A dedicated Router instance for health-check endpoints.
 *
 * Express 5 note: this router is mounted with `apiRouter.use('/', healthRouter)`
 * (no path prefix stripping). Each route here declares its full path relative
 * to `/api`, e.g. `/health` rather than `/`.  This avoids an Express 5
 * behaviour where prefix-stripping leaves an empty string instead of `/`,
 * causing `router.get('/')` to silently fail to match.
 */
const healthRouter: Router = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Shape of the health-check response body.
 * Defined as an interface so callers (tests, monitoring clients) can import it.
 */
export interface HealthResponse {
  /** Overall service status. "ok" means the process is alive and accepting traffic. */
  status: 'ok' | 'degraded' | 'down';
  /** ISO-8601 timestamp of when the response was generated. */
  timestamp: string;
  /** Seconds since the Node.js process started. */
  uptime: number;
  /** Current deployment environment. */
  environment: string;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 *
 * Liveness probe — confirms the HTTP server is running and can respond.
 * No external dependencies (DB, cache) are checked here; those belong in a
 * separate `/api/readiness` endpoint.
 *
 * @returns 200 with a {@link HealthResponse} body.
 */
healthRouter.get('/health', (_req: Request, res: Response): void => {
  const payload: HealthResponse = {
    status:      'ok',
    timestamp:   new Date().toISOString(),
    uptime:      Math.round(process.uptime() * 100) / 100, // rounded to 2 dp
    environment: env.NODE_ENV,
  };

  res.status(200).json(payload);
});

export default healthRouter;
