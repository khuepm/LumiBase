import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { isSiteAdmin } from '../../middleware/site-admin';
import type { ApprovalRequester } from '../approval-requester';
import {
  approvalDeciderFromAuth,
  approvalRequesterFromAuth,
  effectiveCapabilityServiceForRequest,
  resolvePrincipalCapabilities,
  resolveRequestCapabilities,
  standardCallerCapabilities,
} from '../governed-capabilities';
import { isDeployCapability } from './environments';
import type { DeployCaller } from './release-service';

/**
 * Who is calling the deployments API, in deploy terms (#743).
 *
 * A site admin (exactly the `requireSiteAdmin` decision) holds the `admin`
 * marker, which satisfies every `deploy:*` grant. Anyone else gets the
 * `deploy:*` capabilities their live policies grant. Publishable API keys and
 * frontend sessions are browser-held and get nothing, whatever a policy says.
 * Resolution failures resolve to no capabilities (fail closed).
 */
export async function resolveDeployCaller(c: Context<AppEnv>): Promise<DeployCaller> {
  const auth = c.get('auth');
  const siteId = c.get('siteId');
  const base = {
    requester: approvalRequesterFromAuth(auth, siteId),
    decider: approvalDeciderFromAuth(auth),
    actorEmail: auth?.email ?? undefined,
    triggeredBy: auth?.userId ?? undefined,
  };
  if (await isSiteAdmin(c)) return { ...base, capabilities: ['admin'] };

  const granted = standardCallerCapabilities(await resolveRequestCapabilities(c));
  return { ...base, capabilities: (granted ?? []).filter(isDeployCapability) };
}

/**
 * Live deploy capabilities of a stored requester, for the approval-time
 * re-check. Null when the requester can no longer be resolved.
 */
export async function resolveRequesterDeployCapabilities(
  c: Context<AppEnv>,
  requester: ApprovalRequester,
): Promise<string[] | null> {
  if (requester.kind !== 'principal') return null;
  const granted = standardCallerCapabilities(
    await resolvePrincipalCapabilities(effectiveCapabilityServiceForRequest(c), requester.ref),
  );
  return granted ? granted.filter(isDeployCapability) : null;
}
