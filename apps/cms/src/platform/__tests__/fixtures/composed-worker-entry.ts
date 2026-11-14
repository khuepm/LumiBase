/**
 * A deployment entry that wraps the Workers entry. Not shipped: it exists so
 * the composition is type-checked with the rest of the app and bundled by
 * `composed-entries.test.ts`. A real one lives outside this repository and
 * imports the same modules through the package (`@lumibase/cms/cloudflare`,
 * `@lumibase/cms/platform`).
 */
import handler, { PageviewCounter, SiteRoom } from '../../../cloudflare';
import { registerPlatformSeams } from '../../index';
import { stubEntitlements } from './stub-seams';

// Module scope: runs once per isolate, before the first request.
registerPlatformSeams({ entitlements: stubEntitlements });

export default handler;
export { PageviewCounter, SiteRoom };
