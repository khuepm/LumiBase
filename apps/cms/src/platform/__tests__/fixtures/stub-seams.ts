import type { EntitlementResolver } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

/** Marker the composed-entry test looks for in the bundled output. */
export const STUB_MARKER = 'composed-entry-stub-resolver';

/** Smallest possible implementation: proves the registration type-checks. */
export const stubEntitlements: EntitlementResolver<RuntimeContext> = {
  resolve: async (_ctx, organizationId) => ({
    organizationId,
    limits: { [STUB_MARKER]: 1 },
    resolvedAt: Date.now(),
  }),
  authorize: async () => ({ allowed: true }),
};
