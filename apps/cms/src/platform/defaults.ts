import type {
  AuthorizeDecision,
  EntitlementResolver,
  EntitlementSnapshot,
  LimitValue,
} from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';
import type { PlatformSeams } from './types';

/**
 * Built-in defaults: what every seam does when nothing is registered. They
 * perform no I/O and hold no state, so an instance that registers nothing pays
 * nothing for the extension points.
 */

/**
 * A limits table in which every key reads `'unlimited'`. A proxy rather than a
 * finite object because the dimension names are open: no list of keys could be
 * complete. It has no own keys, so it serialises as `{}`.
 */
const UNLIMITED_LIMITS: Readonly<Record<string, LimitValue>> = new Proxy(
  Object.freeze({}) as Record<string, LimitValue>,
  { get: (_target, key) => (typeof key === 'string' ? 'unlimited' : undefined) },
);

const ALLOWED: AuthorizeDecision = Object.freeze({ allowed: true });

/** A snapshot that limits nothing. Also what a failing resolver falls back to. */
export function unlimitedSnapshot(organizationId: string | null): EntitlementSnapshot {
  return { organizationId, limits: UNLIMITED_LIMITS, resolvedAt: Date.now() };
}

/** Decision used by the default resolver and when a resolver fails. */
export function allowedDecision(): AuthorizeDecision {
  return ALLOWED;
}

export const defaultEntitlementResolver: EntitlementResolver<RuntimeContext> = {
  resolve: (_ctx, organizationId) => Promise.resolve(unlimitedSnapshot(organizationId)),
  authorize: () => Promise.resolve(ALLOWED),
};

export const DEFAULT_PLATFORM_SEAMS: PlatformSeams = Object.freeze({
  entitlements: defaultEntitlementResolver,
});
