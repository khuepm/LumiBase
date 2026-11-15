import { Hono } from 'hono';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import type { PermissionBundle } from '../../services/permission-service';
import { capabilitiesFromPermissionBundle } from '../../services/effective-capability-service';

/**
 * Role-based deployment permissions, environments, promotion and the approval
 * gate (#743), through the real router.
 *
 * What is real: the router, `DeploymentReleaseService`, the capability
 * derivation (`capabilitiesFromPermissionBundle` over a policy bundle per
 * role), the environment / approval logic. What is faked: the policy lookup
 * (each role's bundle is handed to the resolver), the stores (in memory) and
 * the provider dispatch (`DeploymentService.trigger/promote`).
 */

// ── Roles as policy bundles ───────────────────────────────────────────────────

function perm(collection: string, action: string) {
  return {
    [`${collection}::${action}`]: {
      collection,
      action,
      rule: null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [],
    },
  };
}

function bundle(admin: boolean, ...rows: Array<[string, string]>): PermissionBundle {
  return {
    admin,
    appAccess: true,
    tfaRequired: false,
    byKey: Object.assign({}, ...rows.map(([c, a]) => perm(c, a))),
    roles: [],
    policies: [],
  } as unknown as PermissionBundle;
}

const ROLE_BUNDLES = {
  admin: bundle(true),
  // Editor: content + deploy:trigger on staging AND production. Production is
  // approval-gated, so the production grant only lets them ASK.
  editor: bundle(
    false,
    ['articles', 'create'],
    ['articles', 'update'],
    ['lumibase_deploy:staging', 'create'],
    ['lumibase_deploy:production', 'create'],
  ),
  // Editor without any production grant at all.
  stagingEditor: bundle(false, ['articles', 'update'], ['lumibase_deploy:staging', 'create']),
  // Release manager: may approve production.
  releaseManager: bundle(false, ['lumibase_deploy:production', 'update'], ['lumibase_deploy:production', 'create']),
  viewer: bundle(false, ['articles', 'read']),
} as const;
type Role = keyof typeof ROLE_BUNDLES;

const USER_IDS: Record<Role, string> = {
  admin: 'usr_admin',
  editor: 'usr_editor',
  stagingEditor: 'usr_stg',
  releaseManager: 'usr_rm',
  viewer: 'usr_viewer',
};
const roleOfUser = (userId: string): Role | undefined =>
  (Object.keys(USER_IDS) as Role[]).find((r) => USER_IDS[r] === userId);

type AuthLike = { userId?: string; apiKeyId?: string };
/** Whose grants apply: the user, or for an API key `key_<role>` that role's user. */
function subjectOf(auth: AuthLike | undefined): string | undefined {
  if (auth?.userId) return auth.userId;
  const role = auth?.apiKeyId?.slice(4) as Role | undefined;
  return role ? USER_IDS[role] : undefined;
}

/** Per-user override of the live grant (to simulate a demotion). */
const liveRole = new Map<string, Role>();

vi.mock('../../middleware/site-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/site-admin')>();
  return {
    ...actual,
    isSiteAdmin: vi.fn(async (c: { get: (k: string) => AuthLike | undefined }) => {
      const userId = subjectOf(c.get('auth'));
      return userId ? (liveRole.get(userId) ?? roleOfUser(userId)) === 'admin' : false;
    }),
    requireSiteAdmin: () => async (
      c: { get: (k: string) => AuthLike | undefined; json: (b: unknown, s: number) => Response },
      next: () => Promise<void>,
    ) => {
      const userId = subjectOf(c.get('auth'));
      if (userId && (liveRole.get(userId) ?? roleOfUser(userId)) === 'admin') return next();
      return c.json({ errors: [{ code: 'FORBIDDEN' }] }, 403);
    },
  };
});

function capsForUser(userId: string | undefined): string[] {
  if (!userId) return [];
  const role = liveRole.get(userId) ?? roleOfUser(userId);
  return role ? capabilitiesFromPermissionBundle(ROLE_BUNDLES[role]) : [];
}

vi.mock('../../services/governed-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/governed-capabilities')>();
  return {
    ...actual,
    resolveRequestCapabilities: vi.fn(async (c: { get: (k: string) => AuthLike | undefined }) => ({
      allowed: true,
      capabilities: capsForUser(subjectOf(c.get('auth'))),
      controlPlaneAdmin: false,
      callerClass: 'standard',
    })),
    effectiveCapabilityServiceForRequest: vi.fn(() => ({})),
    resolvePrincipalCapabilities: vi.fn(async (_svc: unknown, ref: { type: string; userId?: string }) => ({
      allowed: true,
      capabilities: ref.type === 'user' ? capsForUser(ref.userId) : [],
      controlPlaneAdmin: false,
      callerClass: 'standard',
    })),
  };
});

const { deploymentsRouter } = await import('../deployments');
const { DeploymentService } = await import('../../services/deployment/deployment-service');
const { DeploymentEnvironmentStore } = await import('../../services/deployment/environments');
const { DeployApprovalStore } = await import('../../services/deployment/deploy-approvals');
const { AuditLogger } = await import('../../modules/audit/logger');

// ── In-memory world ───────────────────────────────────────────────────────────

type Env = {
  key: string;
  name: string;
  targetIds: string[];
  requiresApproval: boolean;
  promotesTo: string | null;
};
let environments: Env[];
let approvals: Map<string, Record<string, unknown>>;
let triggered: Array<{ targetId: string; opts: Record<string, unknown> }>;
let promoted: Array<{ source: string; targetId: string }>;
let audits: Array<{ event: string; metadata: Record<string, unknown> }>;
let seq = 0;

function defaultEnvs(): Env[] {
  return [
    { key: 'preview', name: 'Preview', targetIds: ['tgt_preview'], requiresApproval: false, promotesTo: null },
    { key: 'staging', name: 'Staging', targetIds: ['tgt_staging'], requiresApproval: false, promotesTo: 'production' },
    { key: 'production', name: 'Production', targetIds: ['tgt_prod'], requiresApproval: true, promotesTo: null },
  ];
}

function deploymentRow(targetId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `dep_${++seq}`,
    siteId: 'site-a',
    targetId,
    provider: 'vercel',
    providerDeploymentId: `vc_${seq}`,
    status: 'queued',
    branch: 'main',
    commitSha: 'abc123',
    createdAt: new Date(2026, 0, 1, 0, seq),
    ...extra,
  };
}

beforeEach(() => {
  liveRole.clear();
  environments = defaultEnvs();
  approvals = new Map();
  triggered = [];
  promoted = [];
  audits = [];

  vi.spyOn(DeploymentEnvironmentStore.prototype, 'read').mockImplementation(async () =>
    structuredClone(environments) as never,
  );
  vi.spyOn(DeploymentEnvironmentStore.prototype, 'write').mockImplementation(async (envs) => {
    environments = structuredClone(envs) as Env[];
    return envs;
  });
  vi.spyOn(DeployApprovalStore.prototype, 'create').mockImplementation(async (plan) => {
    const row = {
      id: `apr_${++seq}`,
      siteId: 'site-a',
      agentName: 'lumibase-deployments',
      skillName: plan.kind === 'promote' ? 'deploy:promote' : 'deploy:trigger',
      arguments: structuredClone(plan),
      status: 'pending',
      context: null,
      result: null,
      createdAt: new Date(),
      decidedAt: null,
      decidedBy: null,
    };
    approvals.set(row.id, row);
    return row as never;
  });
  vi.spyOn(DeployApprovalStore.prototype, 'get').mockImplementation(async (id) => approvals.get(id) as never);
  vi.spyOn(DeployApprovalStore.prototype, 'list').mockImplementation(async (status) =>
    [...approvals.values()].filter((r) => !status || r['status'] === status) as never,
  );
  vi.spyOn(DeployApprovalStore.prototype, 'transition').mockImplementation(async (id, from, to, extra = {}) => {
    const row = approvals.get(id);
    if (!row || row['status'] !== from) return undefined;
    row['status'] = to;
    if (extra.decidedBy !== undefined) row['decidedBy'] = extra.decidedBy;
    if (extra.result !== undefined) row['result'] = extra.result;
    return row as never;
  });

  vi.spyOn(DeploymentService.prototype, 'listTargets').mockImplementation(async () =>
    ['tgt_preview', 'tgt_staging', 'tgt_prod', 'tgt_loose'].map((id) => ({ id })) as never,
  );
  vi.spyOn(DeploymentService.prototype, 'trigger').mockImplementation(async (targetId, opts) => {
    triggered.push({ targetId, opts: opts as Record<string, unknown> });
    return deploymentRow(targetId) as never;
  });
  vi.spyOn(DeploymentService.prototype, 'promote').mockImplementation(async (source, targetId) => {
    promoted.push({ source, targetId });
    return { deployment: deploymentRow(targetId, { status: 'ready' }), mode: 'native' } as never;
  });
  vi.spyOn(DeploymentService.prototype, 'getDeployment').mockImplementation(async (id) =>
    (id === 'dep_staging_ready' ? deploymentRow('tgt_staging', { id, status: 'ready' }) : undefined) as never,
  );
  vi.spyOn(DeploymentService.prototype, 'listDeployments').mockImplementation(async (filter = {}) =>
    (filter.targetId === 'tgt_staging' && filter.status === 'ready'
      ? [deploymentRow('tgt_staging', { id: 'dep_staging_ready', status: 'ready' })]
      : []) as never,
  );
  vi.spyOn(AuditLogger.prototype, 'write').mockImplementation(async (entry) => {
    audits.push({ event: entry.event, metadata: (entry.metadata ?? {}) as Record<string, unknown> });
  });
});

afterEach(() => vi.restoreAllMocks());

function app(role: Role | null, opts: { apiKey?: boolean } = {}) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    const userId = role ? USER_IDS[role] : undefined;
    c.set(
      'auth',
      (opts.apiKey
        ? { type: 'api_key', apiKeyId: `key_${role}`, roles: [] }
        : { type: 'user', userId, email: `${role}@example.test`, roles: [] }) as never,
    );
    c.set('db', {} as never);
    c.set('runtime', { keys: {} } as never);
    await next();
  });
  a.route('/deployments', deploymentsRouter);
  return a;
}

async function call(role: Role | null, method: string, path: string, body?: unknown, opts: { apiKey?: boolean } = {}) {
  const res = await app(role, opts).request(`/deployments${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ code: string }> } };
}

const pendingId = (r: { body: { data?: Record<string, unknown> } }) =>
  (r.body.data!['approval'] as { id: string }).id;

// ── Acceptance: an Editor can trigger staging but not production without approval ──

describe('acceptance (#743): Editor × staging / production', () => {
  it('Editor triggers staging: dispatched immediately', async () => {
    const r = await call('editor', 'POST', '/environments/staging/deploy', { reason: 'copy fix' });
    expect(r.status).toBe(201);
    expect(r.body.data!['status']).toBe('dispatched');
    expect(triggered.map((t) => t.targetId)).toEqual(['tgt_staging']);
  });

  it('Editor triggers production: nothing dispatched, a pending approval is created', async () => {
    const r = await call('editor', 'POST', '/environments/production/deploy', { reason: 'launch' });
    expect(r.status).toBe(202);
    expect(r.body.data!['status']).toBe('pending_approval');
    expect(triggered).toEqual([]);
    expect(approvals.size).toBe(1);
    expect(audits.map((a) => a.event)).toContain('deployment.approval.requested');
  });

  it('the direct target route cannot bypass the gate', async () => {
    const r = await call('editor', 'POST', '/targets/tgt_prod/deploy', {});
    expect(r.status).toBe(202);
    expect(triggered).toEqual([]);
  });

  it('Editor cannot approve their own production request', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const r = await call('editor', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(403);
    expect(triggered).toEqual([]);
  });

  it('even an admin cannot approve their own request', async () => {
    const req = await call('admin', 'POST', '/environments/production/deploy', {});
    expect(req.status).toBe(202);
    const r = await call('admin', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(403);
    expect(r.body.errors![0]!.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(triggered).toEqual([]);
    expect(audits.some((a) => a.event === 'deployment.approval.refused' && a.metadata['code'] === 'SELF_APPROVAL_FORBIDDEN')).toBe(true);
  });

  it('a release manager approves: dispatched exactly once, audited', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', { branch: 'release' });
    const id = pendingId(req);
    const r = await call('releaseManager', 'POST', `/approvals/${id}/decide`, { decision: 'approved' });
    expect(r.status).toBe(200);
    expect(r.body.data!['status']).toBe('approved');
    expect(triggered).toEqual([{ targetId: 'tgt_prod', opts: expect.objectContaining({ branch: 'release' }) }]);
    expect(audits.map((a) => a.event)).toContain('deployment.approval.approved');

    const again = await call('admin', 'POST', `/approvals/${id}/decide`, { decision: 'approved' });
    expect(again.status).toBe(409);
    expect(triggered).toHaveLength(1);
  });

  it('a holder without deploy:approve:production cannot approve', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const r = await call('stagingEditor', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(403);
    expect(triggered).toEqual([]);
  });

  it('an API key cannot decide even with the grant (human approver required)', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const r = await call('admin', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' }, { apiKey: true });
    expect(r.status).toBe(403);
    expect(r.body.errors![0]!.code).toBe('HUMAN_APPROVER_REQUIRED');
  });

  it('rejection dispatches nothing and is audited', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const r = await call('releaseManager', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'rejected', reason: 'freeze' });
    expect(r.status).toBe(200);
    expect(r.body.data!['status']).toBe('rejected');
    expect(triggered).toEqual([]);
    expect(audits.map((a) => a.event)).toContain('deployment.approval.rejected');
  });

  it('the requester may withdraw (reject) their own request', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const r = await call('editor', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'rejected' });
    expect(r.status).toBe(200);
    expect(r.body.data!['status']).toBe('rejected');
  });

  it('a requester demoted after parking: approval refused (REQUESTER_REVOKED)', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    liveRole.set(USER_IDS.editor, 'viewer');
    const r = await call('releaseManager', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(409);
    expect(r.body.errors![0]!.code).toBe('REQUESTER_REVOKED');
    expect(triggered).toEqual([]);
  });

  it('a target removed from the environment since the request is not deployed (PLAN_STALE)', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    environments = environments.map((e) => (e.key === 'production' ? { ...e, targetIds: [] } : e));
    const r = await call('releaseManager', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(409);
    expect(r.body.errors![0]!.code).toBe('PLAN_STALE');
    expect(triggered).toEqual([]);
  });

  it('an expired approval cannot be approved', async () => {
    const req = await call('editor', 'POST', '/environments/production/deploy', {});
    const row = approvals.get(pendingId(req))!;
    (row['arguments'] as Record<string, unknown>)['expiresAt'] = new Date(Date.now() - 1000).toISOString();
    const r = await call('releaseManager', 'POST', `/approvals/${pendingId(req)}/decide`, { decision: 'approved' });
    expect(r.status).toBe(409);
    expect(r.body.errors![0]!.code).toBe('APPROVAL_EXPIRED');
  });

  it('a staging-only editor is refused production outright (403, audited, nothing parked)', async () => {
    const r = await call('stagingEditor', 'POST', '/environments/production/deploy', {});
    expect(r.status).toBe(403);
    expect(approvals.size).toBe(0);
    expect(audits.map((a) => a.event)).toContain('deployment.trigger.denied');
  });

  it('a viewer has no access to the deployments API at all', async () => {
    expect((await call('viewer', 'GET', '/targets')).status).toBe(403);
    expect((await call('viewer', 'POST', '/environments/staging/deploy', {})).status).toBe(403);
  });
});

// ── Promotion ─────────────────────────────────────────────────────────────────

describe('promotion staging → production', () => {
  it('Editor promotes staging: parked for approval, then the SAME build is promoted', async () => {
    const req = await call('editor', 'POST', '/environments/staging/promote', {});
    expect(req.status).toBe(202);
    const approval = req.body.data!['approval'] as Record<string, unknown>;
    expect(approval['sourceDeploymentId']).toBe('dep_staging_ready');
    expect(approval['environment']).toBe('production');
    expect(promoted).toEqual([]);

    const r = await call('releaseManager', 'POST', `/approvals/${approval['id'] as string}/decide`, { decision: 'approved' });
    expect(r.status).toBe(200);
    expect(promoted).toEqual([{ source: 'dep_staging_ready', targetId: 'tgt_prod' }]);
    expect(triggered).toEqual([]);
  });

  it('promotion without an approval gate dispatches at once', async () => {
    environments = environments.map((e) => (e.key === 'production' ? { ...e, requiresApproval: false } : e));
    const r = await call('editor', 'POST', '/environments/staging/promote', { deploymentId: 'dep_staging_ready' });
    expect(r.status).toBe(201);
    expect(promoted).toEqual([{ source: 'dep_staging_ready', targetId: 'tgt_prod' }]);
  });

  it('refuses a deployment that is not in the source environment', async () => {
    const r = await call('admin', 'POST', '/environments/staging/promote', { deploymentId: 'dep_other' });
    expect(r.status).toBe(404);
  });

  it('refuses an environment that promotes nowhere', async () => {
    const r = await call('admin', 'POST', '/environments/production/promote', {});
    expect(r.status).toBe(409);
    expect(r.body.errors![0]!.code).toBe('NO_PROMOTION_TARGET');
  });
});

// ── Environment configuration ─────────────────────────────────────────────────

describe('environment configuration', () => {
  it('only a site admin may change the map; unknown targets are refused', async () => {
    const body = { environments: defaultEnvs().map((e) => ({ ...e, requiresApproval: false })) };
    expect((await call('editor', 'PUT', '/environments', body)).status).toBe(403);
    const bad = await call('admin', 'PUT', '/environments', {
      environments: [{ key: 'staging', name: 'S', targetIds: ['tgt_ghost'], requiresApproval: false, promotesTo: null }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors![0]!.code).toBe('UNKNOWN_TARGET');
    const ok = await call('admin', 'PUT', '/environments', body);
    expect(ok.status).toBe(200);
    expect(audits.map((a) => a.event)).toContain('deployment.environments.updated');
  });

  it('rejects a duplicate key and a dangling promotesTo', async () => {
    const dup = await call('admin', 'PUT', '/environments', {
      environments: [
        { key: 'staging', name: 'A', targetIds: [], requiresApproval: false, promotesTo: null },
        { key: 'staging', name: 'B', targetIds: [], requiresApproval: false, promotesTo: null },
      ],
    });
    expect(dup.status).toBe(400);
    const dangling = await call('admin', 'PUT', '/environments', {
      environments: [{ key: 'staging', name: 'A', targetIds: [], requiresApproval: false, promotesTo: 'prod' }],
    });
    expect(dangling.status).toBe(400);
  });

  it('GET /access reports per-environment rights for the caller', async () => {
    const r = await call('editor', 'GET', '/access');
    expect(r.status).toBe(200);
    const envs = r.body.data!['environments'] as Array<{ key: string; canTrigger: boolean; canApprove: boolean }>;
    expect(envs.find((e) => e.key === 'staging')).toMatchObject({ canTrigger: true, canApprove: false });
    expect(envs.find((e) => e.key === 'preview')).toMatchObject({ canTrigger: false });
  });

  it('GET /approvals marks canDecide: false for the requester, true for an approver', async () => {
    await call('editor', 'POST', '/environments/production/deploy', {});
    const mine = await call('editor', 'GET', '/approvals');
    expect((mine.body.data as unknown as Array<{ canDecide: boolean }>)[0]!.canDecide).toBe(false);
    const theirs = await call('releaseManager', 'GET', '/approvals');
    expect((theirs.body.data as unknown as Array<{ canDecide: boolean }>)[0]!.canDecide).toBe(true);
  });

  it('build logs and target CRUD stay admin-only', async () => {
    expect((await call('editor', 'GET', '/dep_1/logs')).status).toBe(403);
    expect((await call('editor', 'DELETE', '/targets/tgt_prod')).status).toBe(403);
  });
});

// ── Property / oracle: role × environment × capability ────────────────────────

/**
 * For any set of deploy grants on any environment shape, the HTTP outcome of
 * `POST /environments/:key/deploy` matches a three-line oracle:
 *   no trigger grant for the env   → 403, nothing parked, nothing dispatched
 *   grant + requiresApproval        → 202, one pending approval, nothing dispatched
 *   grant + no approval needed      → 201, every mapped target dispatched once
 */
describe('property: role × environment × capability', () => {
  const ENV_KEYS = ['preview', 'staging', 'production'] as const;
  const SCOPES = ['preview', 'staging', 'production', '*', 'tgt_preview', 'tgt_staging', 'tgt_prod'] as const;

  it('matches the oracle for random grants and environment maps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...SCOPES]),
        fc.constantFrom(...ENV_KEYS),
        fc.record({ preview: fc.boolean(), staging: fc.boolean(), production: fc.boolean() }),
        async (grantScopes, envKey, approvalMap) => {
          // Fresh world per run.
          approvals.clear();
          triggered.length = 0;
          environments = defaultEnvs().map((e) => ({ ...e, requiresApproval: approvalMap[e.key as keyof typeof approvalMap] }));
          const custom = bundle(false, ['articles', 'read'], ...grantScopes.map((s) => [`lumibase_deploy:${s}`, 'create'] as [string, string]));
          const caps = capabilitiesFromPermissionBundle(custom);
          liveRole.clear();
          // Reuse the viewer's identity, but with this run's grants.
          (ROLE_BUNDLES as Record<string, PermissionBundle>)['viewer'] = custom;

          const env = environments.find((e) => e.key === envKey)!;
          const granted =
            caps.includes('deploy:trigger:*') ||
            caps.includes(`deploy:trigger:${envKey}`) ||
            env.targetIds.every((t) => caps.includes(`deploy:trigger:${t}`));
          const r = await call('viewer', 'POST', `/environments/${envKey}/deploy`, {});

          if (grantScopes.length === 0) {
            expect(r.status).toBe(403); // no deploy grant at all: router gate
          } else if (!granted) {
            expect(r.status).toBe(403);
          } else if (env.requiresApproval) {
            expect(r.status).toBe(202);
            expect(approvals.size).toBe(1);
          } else {
            expect(r.status).toBe(201);
            expect(triggered.map((t) => t.targetId)).toEqual(env.targetIds);
          }
          if (r.status !== 201) expect(triggered).toEqual([]);
          if (r.status !== 202) expect(approvals.size).toBe(0);
        },
      ),
      { numRuns: 120 },
    );
    (ROLE_BUNDLES as Record<string, PermissionBundle>)['viewer'] = bundle(false, ['articles', 'read']);
  });

  it.each([
    // role,           env,          expected
    ['admin', 'staging', 201],
    ['admin', 'production', 202],
    ['editor', 'staging', 201],
    ['editor', 'production', 202],
    ['editor', 'preview', 403],
    ['stagingEditor', 'staging', 201],
    ['stagingEditor', 'production', 403],
    ['releaseManager', 'production', 202],
    ['releaseManager', 'staging', 403],
    ['viewer', 'staging', 403],
    ['viewer', 'production', 403],
  ] as const)('table: %s → %s = %i', async (role, env, expected) => {
    const r = await call(role, 'POST', `/environments/${env}/deploy`, {});
    expect(r.status).toBe(expected);
  });
});

describe('browser-held credentials', () => {
  it('a publishable API key gets no deploy grant whatever its policies say', async () => {
    const governed = await import('../../services/governed-capabilities');
    vi.mocked(governed.resolveRequestCapabilities).mockResolvedValueOnce({
      allowed: true,
      capabilities: ['deploy:trigger:*'],
      controlPlaneAdmin: false,
      callerClass: 'publishable_api_key',
    });
    const r = await call('editor', 'POST', '/environments/staging/deploy', {}, { apiKey: true });
    expect(r.status).toBe(403);
    expect(triggered).toEqual([]);
  });
});
