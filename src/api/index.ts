/**
 * @file src/api/index.ts
 * @description API layer entry point — aggregates all feature routers.
 *
 * `apiRouter` is the single object mounted onto the Express app in
 * `src/index.ts` under the `/api` prefix.  All version-specific or
 * feature-specific sub-routers are registered here.
 *
 * Adding a new feature
 * ─────────────────────
 * 1. Create `src/api/my-feature.router.ts` with a default-exported Router.
 * 2. Import it here and call `apiRouter.use('/', myFeatureRouter)`.
 * 3. The feature router itself declares the full path (e.g. `/candidates`).
 * 4. That's it — no changes needed in `src/index.ts`.
 *
 * Express 5 routing note
 * ──────────────────────
 * In Express 5, when a mounted Router exhausts all its routes it does NOT
 * automatically fall through to the parent app's subsequent `app.use()`
 * middleware.  Therefore:
 *  • Feature routers are mounted without a path prefix (pattern: `use('/', r)`).
 *  • A 404 catch-all is registered at the BOTTOM of this router so any
 *    unmatched `/api/*` path is handled here before Express 5's finalhandler
 *    takes over.
 */

import { Request, Response, Router } from 'express';
import healthRouter      from './health.router';
import recruitmentRouter from './routes/recruitment.routes';

/** Master API router.  Mounted at `/api` in the root Express application. */
const apiRouter: Router = Router();

// ─── Feature Sub-Routers ────────────────────────────────────────────────────
// Pattern: apiRouter.use('/', featureRouter)
// Each feature router declares its own full paths (e.g. '/health', '/agents').

/** Health/liveness probes → GET /api/health */
apiRouter.use('/', healthRouter);

/** Recruitment pipeline → POST /api/recruit */
apiRouter.use('/', recruitmentRouter);

// ─── API-Level 404 Handler ──────────────────────────────────────────────────
/**
 * Catch-all for any `/api/*` path that no feature router handled.
 * Must be the LAST middleware registered on apiRouter.
 *
 * Returns a structured JSON error — not Express 5's default empty-body 404 —
 * so API clients always receive a machine-readable response.
 */
apiRouter.use((req: Request, res: Response): void => {
  res.status(404).json({
    error:   'Not Found',
    message: `Cannot ${req.method} ${req.baseUrl}${req.path}`,
  });
});

export default apiRouter;
