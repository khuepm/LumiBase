import type { Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import {
  EffectiveCapabilityService,
  type AuthenticatedPrincipalRef,
} from './effective-capability-service';
import type { MagicContext } from './permission-dsl';

/**
 * Re-resolving the ORIGINAL requester's rights when a parked approval executes
 * (#472).
 *
 * ## What was wrong
 *
 * An approval checked the **decider's** capabilities and then ran the stored
 * skill through the decider's harness. The approval row held no reference to
 * whoever asked for the action, so there was nothing to re-check. A user who was
 * demoted, an API key that was revoked, a member removed from the site — none of
 * that took effect on work they had already parked. An admin approving in good
 * faith executed it under their own rights.
 *
 * That is the same defect `AuthenticatedPrincipalRef` was introduced to fix on
 * the queue path, where a job carries a *reference* and the worker re-reads the
 * grant at pickup. Approvals were documented as working that way and did not.
 *
 * ## The rule this module implements
 *
 * Effective capabilities at execution = **requester ∩ decider**.
 *
 * Both sides must still allow the action. Using the decider alone lets a revoked
 * requester act; using the requester alone lets an approval widen what the
 * decider themselves may do. The intersection is the only combination where
 * neither party can be used to launder the other's limits.
 *
 * Row and field scoping is not part of this set — it lives in `ItemService` via
 * the requester's `permissionContext`, which is returned here so the caller can
 * build a service bound to it rather than a system one.
 */

/**
 * Who asked for a parked action.
 *
 * Not every requester is a person: reconciler work is authorised by the intent
 * that declared the rule, and executes under an agent role. Both shapes have to
 * be re-resolvable, so both are represented rather than forcing agent work
 * through a fake user principal.
 */
export type ApprovalRequester =
  | { kind: 'principal'; ref: AuthenticatedPrincipalRef }
  | {
      kind: 'agentRole';
      role: string;
      intentId?: string | null;
      autonomyCap?: number | null;
    };

export type ApprovalRequesterDenialCode =
  | 'APPROVAL_PROVENANCE_MISSING'
  | 'APPROVAL_PROVENANCE_INVALID'
  | 'REQUESTER_REVOKED'
  | 'REQUESTER_ROLE_UNAVAILABLE'
  | 'REQUESTER_RESOLUTION_FAILED';

export type ApprovalRequesterResolution =
  | {
      allowed: true;
      /** The requester's current coarse capabilities. */
      capabilities: string[];
      /** Row/field enforcement context, when the requester is a principal. */
      permissionContext?: MagicContext;
    }
  | { allowed: false; code: ApprovalRequesterDenialCode; message: string };

/**
 * Parses the stored column into a requester, or null when it cannot be trusted.
 *
 * Null is returned for both "column is null" (a row created before provenance
 * existed) and "column holds something unexpected". The caller must refuse in
 * both cases: an approval whose requester cannot be identified is exactly the
 * situation this module exists to stop, so guessing would defeat it.
 */
export function parseApprovalRequester(raw: unknown): ApprovalRequester | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;

  if (value['kind'] === 'agentRole') {
    const role = value['role'];
    if (typeof role !== 'string' || role.length === 0) return null;
    return {
      kind: 'agentRole',
      role,
      intentId: typeof value['intentId'] === 'string' ? value['intentId'] : null,
      autonomyCap: typeof value['autonomyCap'] === 'number' ? value['autonomyCap'] : null,
    };
  }

  if (value['kind'] !== 'principal') return null;
  const ref = value['ref'];
  if (!ref || typeof ref !== 'object') return null;
  const candidate = ref as Record<string, unknown>;
  const siteId = candidate['siteId'];
  if (typeof siteId !== 'string' || siteId.length === 0) return null;

  switch (candidate['type']) {
    case 'user':
      return typeof candidate['userId'] === 'string' && candidate['userId'].length > 0
        ? { kind: 'principal', ref: { type: 'user', siteId, userId: candidate['userId'] } }
        : null;
    case 'api_key':
      return typeof candidate['apiKeyId'] === 'string' && candidate['apiKeyId'].length > 0
        ? { kind: 'principal', ref: { type: 'api_key', siteId, apiKeyId: candidate['apiKeyId'] } }
        : null;
    case 'dev':
      return Array.isArray(candidate['roles'])
        ? {
            kind: 'principal',
            ref: { type: 'dev', siteId, roles: candidate['roles'] as readonly string[] },
          }
        : null;
    default:
      return null;
  }
}

export interface ResolveApprovalRequesterDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider | undefined;
  environment?: string | undefined;
}

/**
 * Re-reads the requester's current rights from the database.
 *
 * Fail-closed at every branch: a principal the resolver denies, an agent role
 * that is unknown or disabled, and any thrown error all resolve to "not
 * allowed". A denial here means the approval does not execute, which is the
 * intended outcome when the person who asked for it no longer may.
 */
export async function resolveApprovalRequester(
  deps: ResolveApprovalRequesterDeps,
  requester: ApprovalRequester,
): Promise<ApprovalRequesterResolution> {
  try {
    if (requester.kind === 'agentRole') {
      const { AgentRoleService } = await import('./agent-role-service');
      const roles = new AgentRoleService({ db: deps.db, siteId: deps.siteId });
      // Seeded lazily; a background-origin approval must not depend on somebody
      // having opened the Studio roles page first.
      await roles.ensureSeeded();
      const capabilities = await roles.effectiveCapabilities(requester.role, ['*']);
      if (capabilities.length === 0) {
        return {
          allowed: false,
          code: 'REQUESTER_ROLE_UNAVAILABLE',
          message: `Agent role "${requester.role}" is unknown or disabled; the approved action was not executed.`,
        };
      }
      return { allowed: true, capabilities };
    }

    // A principal recorded for another tenant must never resolve here. The
    // resolver checks this too, but the approval row is tenant-scoped and a
    // mismatch means the stored provenance is wrong, not merely stale.
    if (requester.ref.siteId !== deps.siteId) {
      return {
        allowed: false,
        code: 'APPROVAL_PROVENANCE_INVALID',
        message: 'The recorded requester belongs to a different site.',
      };
    }

    const service = new EffectiveCapabilityService({
      db: deps.db,
      siteId: deps.siteId,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.environment ? { environment: deps.environment } : {}),
    });
    const resolution = await service.resolve(requester.ref);
    if (!resolution.allowed) {
      return {
        allowed: false,
        code: 'REQUESTER_REVOKED',
        message: `The requester can no longer act on this site (${resolution.code}); the approved action was not executed.`,
      };
    }
    return {
      allowed: true,
      capabilities: resolution.capabilities,
      permissionContext: resolution.permissionContext,
    };
  } catch (error) {
    // An authorization question must not surface as a 500, and must certainly
    // not fall through to a permissive default.
    console.warn('[approval-requester] resolution failed; denying', error);
    return {
      allowed: false,
      code: 'REQUESTER_RESOLUTION_FAILED',
      message: 'The requester’s current rights could not be resolved; the approved action was not executed.',
    };
  }
}

/** Capability tokens that mean "no enumerated limit". */
const WILDCARDS = new Set(['*', 'admin']);

const isUnlimited = (capabilities: readonly string[]): boolean =>
  capabilities.some((c) => WILDCARDS.has(c));

/**
 * Capabilities the approved action may use: requester ∩ decider.
 *
 * ## Why this is not `intersectCapabilities`
 *
 * That helper exists for `role ∩ grant`, where the role side is always an
 * enumerated list. It treats a wildcard **grant** as "everything the role
 * allows" and strips wildcards out of the role side — so
 * `intersectCapabilities(['admin'], ['*'])` returns `[]`. Correct there, wrong
 * here: an admin requester whose action an admin approves would end up with no
 * capabilities at all and every approval would be denied.
 *
 * The rule here is symmetric, because neither party is subordinate to the other:
 * an unlimited side imposes no limit, so the result is whatever the other side
 * allows. Both unlimited stays `['admin']`. Otherwise it is the plain set
 * intersection, which is what stops an approval from granting the requester
 * something the decider lacks, or vice versa.
 */
export function effectiveApprovalCapabilities(
  requesterCapabilities: readonly string[],
  deciderCapabilities: readonly string[],
): string[] {
  const requesterUnlimited = isUnlimited(requesterCapabilities);
  const deciderUnlimited = isUnlimited(deciderCapabilities);

  if (requesterUnlimited && deciderUnlimited) return ['admin'];
  if (requesterUnlimited) return [...new Set(deciderCapabilities)];
  if (deciderUnlimited) return [...new Set(requesterCapabilities)];

  const decider = new Set(deciderCapabilities);
  return [...new Set(requesterCapabilities.filter((c) => decider.has(c)))];
}
