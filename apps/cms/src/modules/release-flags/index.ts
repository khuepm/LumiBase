/**
 * Release flags (#869): ship features dark to `main`, enable them per
 * deployment by a signed manifest, per site by admin choice.
 */
export { RELEASE_FLAGS, type ReleaseFlagKey, type ReleaseFlagDefinition, type ReleaseStage } from './registry';
export type { ReleaseFlagState } from './resolver';
export { isReleaseFlagEnabled, releaseFlagStates, requireReleaseFlag } from './middleware';
export { releaseFlagsRouter } from './routes';
