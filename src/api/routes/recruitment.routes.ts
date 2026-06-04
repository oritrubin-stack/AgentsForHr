/**
 * @file src/api/routes/recruitment.routes.ts
 * @description Express router for the recruitment pipeline endpoint.
 *
 * This file is the **composition root** for the recruitment feature:
 * it wires together the real production dependencies (PlaywrightService →
 * HunterAgent → AnalyzerAgent → OrchestratorAgent → RecruitmentController)
 * and registers them on an Express Router.
 *
 * Architecture note
 * ──────────────────
 * Dependency construction happens here (module scope — once at startup) so:
 *  • Agent instances are singletons per process (no per-request overhead).
 *  • PlaywrightService is shared across requests.
 *  • Tests bypass this file and inject mocks directly into the controller.
 *
 * Mounted in `src/api/index.ts` as:
 *   `apiRouter.use('/', recruitmentRouter)`
 *
 * Exposes:
 *   POST /api/recruit  →  RecruitmentController.postRecruit
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PlaywrightService }           from '../../services/scraper/PlaywrightService';
import { HunterAgent, StrategyRegistry } from '../../agents/hunter/HunterAgent';
import { LinkedInApiStrategy }         from '../../agents/hunter/strategies/LinkedInApiStrategy';
import { OutlookImapStrategy }         from '../../agents/hunter/strategies/OutlookImapStrategy';
import { AnalyzerAgent }               from '../../agents/analyzer/AnalyzerAgent';
import { OrchestratorAgent }           from '../../agents/OrchestratorAgent';
import { RecruitmentController }       from '../controllers/RecruitmentController';
import { env }                         from '../../config/env';

// ─── Dependency wiring (singleton per process) ───────────────────────────────

/**
 * Shared PlaywrightService instance.
 * Chromium is launched lazily on the first `withPage()` call, so importing
 * this router does not open a browser process immediately.
 */
const playwrightService = new PlaywrightService();

/**
 * Strategy registry for the HunterAgent.
 *
 * `LinkedInApiStrategy` is only registered when BOTH `LINKEDIN_API_URL` and
 * `LINKEDIN_API_KEY` are present in the environment.  This keeps the server
 * startable without Proxycurl credentials while giving full LinkedIn support
 * when the keys are configured.
 *
 * If the env vars are absent the HunterAgent falls back to its built-in mock
 * data path for the `'linkedin'` platform and emits a warning in the logs.
 */
const strategyRegistry: StrategyRegistry = {};

if (env.LINKEDIN_API_URL && env.LINKEDIN_API_KEY) {
  strategyRegistry.linkedin = new LinkedInApiStrategy();
  console.log('[Routes] LinkedInApiStrategy registered (Proxycurl credentials found).');
} else {
  console.warn(
    '[Routes] LINKEDIN_API_URL or LINKEDIN_API_KEY is not set — ' +
    'LinkedIn strategy not registered. Requests for platform="linkedin" ' +
    'will fall back to mock data.',
  );
}

if (env.IMAP_USER && env.IMAP_PASSWORD) {
  strategyRegistry.email = new OutlookImapStrategy();
  console.log(
    `[Routes] OutlookImapStrategy registered (IMAP inbox: ${env.IMAP_USER} @ ${env.IMAP_HOST}).`,
  );
} else {
  console.warn(
    '[Routes] IMAP_USER or IMAP_PASSWORD is not set — ' +
    'OutlookImapStrategy not registered. Requests for platform="email" ' +
    'will fall back to mock data.',
  );
}

const hunterAgent = new HunterAgent(playwrightService, strategyRegistry);

/**
 * AnalyzerAgent using `env.ANTHROPIC_API_KEY` (validated at startup).
 */
const analyzerAgent = new AnalyzerAgent();

/**
 * Top-level Orchestrator — composes Hunter + Analyzer.
 */
const orchestratorAgent = new OrchestratorAgent(hunterAgent, analyzerAgent);

/**
 * Controller with injected orchestrator.
 * Binding `this` explicitly so the method can be passed as a bare callback.
 */
const controller = new RecruitmentController(orchestratorAgent);
const postRecruit = controller.postRecruit.bind(controller);

// ─── Router ───────────────────────────────────────────────────────────────────

const recruitmentRouter: Router = Router();

/**
 * POST /api/recruit
 *
 * Runs a full candidate-discovery-and-evaluation campaign.
 *
 * @see RecruitmentController.postRecruit for the full HTTP contract.
 */
recruitmentRouter.post(
  '/recruit',
  (req: Request, res: Response, next: NextFunction): void => {
    postRecruit(req, res, next).catch(next);
  },
);

export default recruitmentRouter;
