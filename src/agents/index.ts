/**
 * @file src/agents/index.ts
 * @description Agent layer barrel — re-exports all agent classes.
 *
 * Import agents via this barrel for stable import paths:
 * ```ts
 * import { HunterAgent } from './agents';
 * ```
 * instead of deep paths that may change as the directory grows.
 */

export { HunterAgent }              from './hunter/HunterAgent';
export type { HuntOptions }         from './hunter/HunterAgent';

export { AnalyzerAgent, AnalysisError } from './analyzer/AnalyzerAgent';

export { OrchestratorAgent }        from './OrchestratorAgent';
export type { CampaignResult }      from './OrchestratorAgent';
