import type { EntitlementResolver, ExternalActionToolSource, SeamContext, UsageEmitter } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

/** Seam context as the CMS passes it: the runtime handle is a `RuntimeContext`. */
export type CmsSeamContext = SeamContext<RuntimeContext>;

/**
 * Every extension point the CMS exposes. `platform()` always returns a complete
 * set: whatever the deployment entry did not register is the built-in default.
 */
export interface PlatformSeams {
  entitlements: EntitlementResolver<RuntimeContext>;
  usage: UsageEmitter<RuntimeContext>;
  /**
   * External-action tools supplied from outside the CMS. Read once, inside
   * `registerPlatformSeams()`, and loaded into the process-wide registry.
   */
  externalActions: ExternalActionToolSource;
}

export type PlatformSeamName = keyof PlatformSeams;
