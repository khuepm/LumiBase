import type { EntitlementResolver, SeamContext } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

/** Seam context as the CMS passes it: the runtime handle is a `RuntimeContext`. */
export type CmsSeamContext = SeamContext<RuntimeContext>;

/**
 * Every extension point the CMS exposes. `platform()` always returns a complete
 * set: whatever the deployment entry did not register is the built-in default.
 */
export interface PlatformSeams {
  entitlements: EntitlementResolver<RuntimeContext>;
}

export type PlatformSeamName = keyof PlatformSeams;
