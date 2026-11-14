/**
 * Public surface of the platform extension points, exported from the package
 * as `@lumibase/cms/platform`. A deployment entry imports `registerPlatformSeams`
 * from here; code inside the CMS imports the request helpers.
 *
 * Contracts (the interfaces an implementation satisfies) live in
 * `@lumibase/contracts/platform`.
 */
export { isPlatformSeamRegistered, platform, registerPlatformSeams, resetPlatformSeamsForTests } from './registry';
export { defaultEntitlementResolver, unlimitedSnapshot } from './defaults';
export {
  authorizeEntitlement,
  backgroundSeamContext,
  entitlementsFor,
  seamContextFor,
  tenantRefFor,
} from './request';
export type { CmsSeamContext, PlatformSeamName, PlatformSeams } from './types';
