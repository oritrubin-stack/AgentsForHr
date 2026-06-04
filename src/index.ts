/**
 * @file src/index.ts
 * @description Application entry point.
 *
 * Responsibilities
 * ─────────────────
 * 1. Bootstrap the Express application with middleware (security, parsing,
 *    logging, CORS, etc.).
 * 2. Mount all API routers under a versioned base path.
 * 3. Register global error-handling middleware.
 * 4. Start the HTTP server and bind graceful-shutdown handlers so in-flight
 *    requests are always drained before the process exits.
 *
 * What does NOT belong here
 * ──────────────────────────
 * • Route handler logic     → src/api/<feature>.router.ts
 * • Business / domain logic → src/services/<feature>.service.ts
 * • AI agent orchestration  → src/agents/<name>.agent.ts
 * • Environment variables   → src/config/env.ts
 */

import express, {
  Application,
  Request,
  Response,
  NextFunction,
} from 'express';
import path from 'path';

import { env }       from './config/env';
import apiRouter     from './api/index';

// ─── App Factory ────────────────────────────────────────────────────────────

/**
 * Creates and configures an Express application instance.
 *
 * Keeping the factory function separate from `server.listen()` makes the app
 * trivially importable in integration tests without binding to a port.
 *
 * @returns A fully-configured Express {@link Application}.
 */
function createApp(): Application {
  const app: Application = express();

  // ── Global Middleware ──────────────────────────────────────────────────
  // Order matters: parse body before routes; error handler must come last.

  /**
   * Parse incoming JSON request bodies.
   * Limit prevents memory-exhaustion DoS attacks from large payloads.
   */
  app.use(express.json({ limit: '10mb' }));

  /**
   * Parse URL-encoded bodies (HTML form submissions).
   * `extended: true` allows nested objects via the `qs` library.
   */
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  /**
   * Disable the `X-Powered-By: Express` header.
   * Small security improvement — no need to advertise the framework to
   * potential attackers.
   */
  app.disable('x-powered-by');

  /**
   * Request logger — development only.
   * In production, use a structured logger (e.g. Winston / Pino) and ship
   * logs to a centralised aggregator (Datadog, CloudWatch, etc.).
   */
  if (env.NODE_ENV === 'development') {
    app.use((req: Request, _res: Response, next: NextFunction): void => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
      next();
    });
  }

  // ── Route Registration ─────────────────────────────────────────────────

  /**
   * Mount all API routes under `/api`.
   * The `apiRouter` in `src/api/index.ts` composes individual feature routers,
   * so adding new features never requires touching this file.
   *
   * Current routes:
   *   GET  /api/health  → liveness probe
   */
  app.use('/api', apiRouter);

  // ── Static Files & SPA Fallback (Production) / 404 (Development) ─────────

  /**
   * In production, Express serves the pre-built React bundle from `frontend/dist`.
   * `express.static` handles all asset requests (JS chunks, CSS, images, fonts).
   * The SPA catch-all below it ensures React Router controls client-side
   * navigation — every non-API path returns `index.html` so the browser can
   * bootstrap the SPA.
   *
   * In development, Vite's own dev-server runs the frontend on a separate port,
   * so we keep the JSON 404 handler to surface API misses clearly.
   *
   * Order is critical: this block must be BELOW `app.use('/api', apiRouter)` so
   * API routes are matched first, and ABOVE the global error handler.
   */
  if (env.NODE_ENV === 'production') {
    const frontendDistPath = path.resolve(process.cwd(), 'frontend', 'dist');

    app.use(express.static(frontendDistPath));

    app.get('*', (_req: Request, res: Response): void => {
      res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
  } else {
    app.use((req: Request, res: Response, _next: NextFunction): void => {
      res.status(404).json({
        error:   'Not Found',
        message: `Cannot ${req.method} ${req.originalUrl}`,
      });
    });
  }

  // ── Global Error Handler ──────────────────────────────────────────────

  /**
   * Express 4.x error-handling middleware requires exactly 4 parameters.
   * This is the last line of defence: catches any error passed via `next(err)`
   * or thrown inside an async route wrapped with a try/catch.
   *
   * @param err  - The error object (typed as `unknown` for safety).
   * @param _req - Incoming request (unused, but required by Express).
   * @param res  - Outgoing response.
   * @param _next- Next middleware (required by Express signature, unused here).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    // Normalise to a standard Error object so we can read `.message`.
    const error = err instanceof Error ? err : new Error(String(err));

    // Never leak stack traces or internal messages to external clients in prod.
    const isDev = env.NODE_ENV === 'development';

    console.error('[Global Error Handler]', error);

    res.status(500).json({
      error:   'Internal Server Error',
      message: isDev ? error.message : 'An unexpected error occurred.',
      ...(isDev && { stack: error.stack }),
    });
  });

  return app;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/**
 * Starts the HTTP server.
 *
 * Wrapped in an async IIFE so we can `await` any async bootstrap work
 * (e.g. database connection, cache warm-up, agent initialisation) before
 * accepting traffic.
 */
(async (): Promise<void> => {
  try {
    // ── Any async initialisation goes here ─────────────────────────────
    // Example: await connectToDatabase();
    // Example: await warmUpModels();

    const app    = createApp();
    const { PORT } = env;

    const server = app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════════╗
║           AgentsForHR — Server Ready         ║
╠══════════════════════════════════════════════╣
║  Environment : ${env.NODE_ENV.padEnd(29)}║
║  Port        : ${String(PORT).padEnd(29)}║
║  Health      : http://localhost:${String(PORT).padEnd(14)}/api/health ║
╚══════════════════════════════════════════════╝
      `.trim());
    });

    // ── Graceful Shutdown ────────────────────────────────────────────────
    /**
     * Handle OS termination signals so in-flight requests complete before the
     * process exits.  Critical in containerised (Docker/K8s) deployments where
     * a SIGTERM precedes a SIGKILL by a configurable grace period.
     *
     * Sequence:
     *  1. Stop accepting new connections.
     *  2. Wait for existing connections to close (up to a timeout).
     *  3. Exit cleanly with code 0 — or 1 if shutdown times out.
     */
    const SHUTDOWN_TIMEOUT_MS = 10_000; // 10 s — adjust per SLA

    const shutdown = (signal: string): void => {
      console.log(`\n[Server] Received ${signal}. Shutting down gracefully…`);

      // Set a hard deadline so a hung connection doesn't block the pod forever.
      const killTimer = setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out — forcing exit.');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      // Don't let this timer keep the event loop alive.
      killTimer.unref();

      server.close(() => {
        console.log('[Server] All connections closed.  Goodbye.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM')); // Container orchestrators
    process.on('SIGINT',  () => shutdown('SIGINT'));  // Ctrl+C in dev

    // ── Unhandled Rejection / Exception Guards ───────────────────────────
    /**
     * Catch unhandled promise rejections and uncaught exceptions.
     * Log them prominently and exit so the process manager (PM2, K8s, etc.)
     * can restart the service in a known-good state rather than limping along.
     */
    process.on('unhandledRejection', (reason: unknown) => {
      console.error('[Process] Unhandled Promise Rejection:', reason);
      process.exit(1);
    });

    process.on('uncaughtException', (error: Error) => {
      console.error('[Process] Uncaught Exception:', error);
      process.exit(1);
    });

  } catch (bootstrapError) {
    // An error here means we couldn't even start — log and exit immediately.
    console.error('[Bootstrap] Failed to start the server:', bootstrapError);
    process.exit(1);
  }
})();
