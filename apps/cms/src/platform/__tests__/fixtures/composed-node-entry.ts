/**
 * A deployment entry that wraps the Node entry. Not shipped — see
 * `composed-worker-entry.ts`. A real one imports `@lumibase/cms/node` and
 * `@lumibase/cms/platform`.
 */
import { startNodeServer } from '../../../node';
import { registerPlatformSeams } from '../../index';
import { stubEntitlements } from './stub-seams';

registerPlatformSeams({ entitlements: stubEntitlements });

void startNodeServer();
