/**
 * @file src/services/index.ts
 * @description Service layer barrel — re-exports all service classes.
 *
 * Import services via this barrel:
 * ```ts
 * import { PlaywrightService } from './services';
 * ```
 */

export { PlaywrightService } from './scraper/PlaywrightService';
export type {
  PlaywrightServiceOptions,
  BrowserSession,
} from './scraper/PlaywrightService';
