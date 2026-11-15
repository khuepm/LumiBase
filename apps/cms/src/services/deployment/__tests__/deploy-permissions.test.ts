import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { EnvKeyProvider } from '@lumibase/runtime';
import { DeploymentEnvironmentsSchema } from '@lumibase/contracts';
import { capabilitiesFromPermissionBundle } from '../../effective-capability-service';
import type { PermissionBundle } from '../../permission-service';
import { ConfigService } from '../../config-service';
import { DeploymentError, DeploymentService } from '../deployment-service';
import {
  canApproveEnvironment,
  canTriggerEnvironment,
  canTriggerTarget,
  DEFAULT_ENVIRONMENTS,
  DeploymentEnvironmentStore,
  gatingEnvironmentForTarget,
  hasDeployAccess,
} from '../environments';
import { parseDeployPlan } from '../deploy-approvals';
import { registerProvider, type DeploymentProvider } from '../providers';
import { encryptToken } from '../token-vault';

/** Deploy capabilities, environment helpers and promotion (#743). */

function bundleOf(rows: Array<[string, string]>, admin = false): PermissionBundle {
  const byKey: Record<string, unknown> = {};
  for (const [collection, action] of rows) {
    byKey[`${collection}::${action}`] = { collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] };
  }
  return { admin, appAccess: true, tfaRequired: false, byKey, roles: [], policies: [] } as unknown as PermissionBundle;
}

describe('capabilitiesFromPermissionBundle: lumibase_deploy:<scope>', () => {
  it('maps create → deploy:trigger and update → deploy:approve, never an item capability', () => {
    const caps = capabilitiesFromPermissionBundle(
      bundleOf([
        ['lumibase_deploy:staging', 'create'],
        ['lumibase_deploy:production', 'update'],
        ['lumibase_deploy:*', 'create'],
        ['lumibase_deploy:tgt_AbC-1', 'create'],
      ]),
    );
    expect(caps).toEqual([
      'deploy:approve:production',
      'deploy:trigger:*',
      'deploy:trigger:staging',
      'deploy:trigger:tgt_AbC-1',
    ]);
    expect(caps.some((c) => c.startsWith('items:'))).toBe(false);
  });

  it('ignores other actions and malformed scopes', () => {
    const caps = capabilitiesFromPermissionBundle(
      bundleOf([
        ['lumibase_deploy:staging', 'read'],
        ['lumibase_deploy:staging', 'delete'],
        ['lumibase_deploy:', 'create'],
        ['lumibase_deploy:a b', 'create'],
        ['lumibase_deploy:a:b', 'create'],
      ]),
    );
    expect(caps).toEqual([]);
  });

  it('an admin bundle stays the admin marker', () => {
    expect(capabilitiesFromPermissionBundle(bundleOf([], true))).toEqual(['admin']);
  });
});

describe('environment capability helpers', () => {
  const staging = { key: 'staging', targetIds: ['t1', 't2'] };

  it('canTriggerEnvironment: wildcard, env key, or every target', () => {
    expect(canTriggerEnvironment(['deploy:trigger:*'], staging)).toBe(true);
    expect(canTriggerEnvironment(['deploy:trigger:staging'], staging)).toBe(true);
    expect(canTriggerEnvironment(['deploy:trigger:t1', 'deploy:trigger:t2'], staging)).toBe(true);
    expect(canTriggerEnvironment(['deploy:trigger:t1'], staging)).toBe(false);
    expect(canTriggerEnvironment(['deploy:trigger:production'], staging)).toBe(false);
    expect(canTriggerEnvironment(['deploy:approve:staging'], staging)).toBe(false);
    expect(canTriggerEnvironment(['admin'], staging)).toBe(true);
    // An empty environment is not "every target" by vacuous truth.
    expect(canTriggerEnvironment(['deploy:trigger:x'], { key: 'staging', targetIds: [] })).toBe(false);
  });

  it('canTriggerTarget: wildcard, target id, or a governing environment key', () => {
    expect(canTriggerTarget(['deploy:trigger:t1'], 't1', [])).toBe(true);
    expect(canTriggerTarget(['deploy:trigger:staging'], 't1', [{ key: 'staging' }])).toBe(true);
    expect(canTriggerTarget(['deploy:trigger:staging'], 't1', [])).toBe(false);
    expect(canTriggerTarget(['items:write'], 't1', [])).toBe(false);
  });

  it('canApproveEnvironment and hasDeployAccess', () => {
    expect(canApproveEnvironment(['deploy:approve:production'], 'production')).toBe(true);
    expect(canApproveEnvironment(['deploy:approve:*'], 'production')).toBe(true);
    expect(canApproveEnvironment(['deploy:trigger:production'], 'production')).toBe(false);
    expect(hasDeployAccess(['items:write'])).toBe(false);
    expect(hasDeployAccess(['deploy:trigger:staging'])).toBe(true);
    expect(hasDeployAccess(['admin'])).toBe(true);
  });

  it('a target shared by staging and production is gated like production', () => {
    const envs = [
      { key: 'staging', name: 'S', targetIds: ['t'], requiresApproval: false, promotesTo: 'production' },
      { key: 'production', name: 'P', targetIds: ['t'], requiresApproval: true, promotesTo: null },
    ];
    expect(gatingEnvironmentForTarget(envs, 't')?.key).toBe('production');
    expect(gatingEnvironmentForTarget(envs, 'other')).toBeNull();
  });

  it('defaults: production requires approval, nothing is mapped, and they validate', () => {
    expect(DEFAULT_ENVIRONMENTS.find((e) => e.key === 'production')?.requiresApproval).toBe(true);
    expect(DEFAULT_ENVIRONMENTS.every((e) => e.targetIds.length === 0)).toBe(true);
    expect(DeploymentEnvironmentsSchema.safeParse(DEFAULT_ENVIRONMENTS).success).toBe(true);
  });
});

describe('DeploymentEnvironmentStore', () => {
  afterEach(() => vi.restoreAllMocks());
  const store = () => new DeploymentEnvironmentStore({ db: {} as Database, siteId: 's1' });

  it('absent setting → defaults', async () => {
    vi.spyOn(ConfigService.prototype, 'listSettings').mockResolvedValue([] as never);
    expect((await store().read()).map((e) => e.key)).toEqual(['preview', 'staging', 'production']);
  });

  it('malformed setting → refuses instead of falling back (fail closed)', async () => {
    vi.spyOn(ConfigService.prototype, 'listSettings').mockResolvedValue([
      { key: 'deployment.environments', value: { environments: [{ key: 'Prod!!' }] } },
    ] as never);
    await expect(store().read()).rejects.toMatchObject({ code: 'ENVIRONMENTS_INVALID' });
  });
});

describe('parseDeployPlan', () => {
  const good = {
    kind: 'trigger',
    scope: 'environment',
    environment: 'production',
    targetIds: ['t'],
    requestedBy: { kind: 'principal', ref: { type: 'user', siteId: 's1', userId: 'u1' } },
    expiresAt: new Date().toISOString(),
  };
  it('accepts a well-formed deploy plan', () => {
    expect(parseDeployPlan({ skillName: 'deploy:trigger', arguments: good })?.environment).toBe('production');
  });
  it('rejects AI skills, missing requester and bad shapes', () => {
    expect(parseDeployPlan({ skillName: 'triggerDeployment', arguments: good })).toBeNull();
    expect(parseDeployPlan({ skillName: 'deploy:trigger', arguments: { ...good, requestedBy: null } })).toBeNull();
    expect(parseDeployPlan({ skillName: 'deploy:trigger', arguments: { ...good, targetIds: [1] } })).toBeNull();
    expect(parseDeployPlan({ skillName: 'deploy:trigger', arguments: { ...good, kind: 'delete' } })).toBeNull();
  });
});

// ── DeploymentService.promote ─────────────────────────────────────────────────

const KEK = Buffer.alloc(32, 9).toString('base64');
const keys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');

const promoteCalls: string[] = [];
const triggerCalls: Array<{ branch?: string; commitSha?: string }> = [];
const fakeProvider: DeploymentProvider = {
  key: 'fakeprov',
  verifyToken: async () => ({ ok: true }),
  trigger: async (_t, _target, opts) => {
    triggerCalls.push({ branch: opts.branch, commitSha: opts.commitSha });
    return { providerDeploymentId: 'new_build', status: 'queued' };
  },
  getStatus: async (_t, _target, id) => ({ providerDeploymentId: id, status: 'ready' }),
  getLogs: async () => '',
  verifyWebhook: async () => false,
  parseWebhook: () => null,
  promote: async (_t, _target, id) => {
    promoteCalls.push(id);
    return { providerDeploymentId: id, status: 'ready', url: 'https://prod.example' };
  },
};
registerProvider(fakeProvider);

async function target(id: string, projectId: string) {
  const enc = await encryptToken(keys, 'tok', 's1');
  return {
    id, siteId: 's1', provider: 'fakeprov', name: id, projectId,
    tokenCiphertext: enc.ciphertext, tokenKeyId: enc.keyId, defaultBranch: 'main',
    productionUrl: null, status: 'active', createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeDb(selects: unknown[][]) {
  let call = 0;
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select() {
      const rows = selects[call] ?? [];
      call += 1;
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        orderBy: () => b,
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
      };
      return b;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: 'dep_new', ...v }]) };
        },
      };
    },
  };
  return { db: db as unknown as Database, inserted };
}

const SOURCE = {
  id: 'dep_src', siteId: 's1', targetId: 'tgt_stg', provider: 'fakeprov', providerDeploymentId: 'build_42',
  status: 'ready', branch: 'release', commitSha: 'c0ffee', commitMessage: 'ship', url: 'https://stg.example',
};

describe('DeploymentService.promote', () => {
  afterEach(() => {
    promoteCalls.length = 0;
    triggerCalls.length = 0;
  });

  it('same provider project → native promote of the same build, no rebuild', async () => {
    const { db, inserted } = makeDb([[SOURCE], [await target('tgt_prod', 'prj_same')], [await target('tgt_stg', 'prj_same')]]);
    const out = await new DeploymentService({ db, siteId: 's1', keys }).promote('dep_src', 'tgt_prod');
    expect(out.mode).toBe('native');
    expect(promoteCalls).toEqual(['build_42']);
    expect(triggerCalls).toEqual([]);
    expect(inserted[0]).toMatchObject({ targetId: 'tgt_prod', triggerSource: 'promote', commitSha: 'c0ffee', status: 'ready' });
  });

  it('different project → re-trigger pinned to the same commit and branch', async () => {
    const prod = await target('tgt_prod', 'prj_prod');
    const { db, inserted } = makeDb([[SOURCE], [prod], [await target('tgt_stg', 'prj_stg')], [prod]]);
    const out = await new DeploymentService({ db, siteId: 's1', keys }).promote('dep_src', 'tgt_prod');
    expect(out.mode).toBe('retrigger');
    expect(promoteCalls).toEqual([]);
    expect(triggerCalls).toEqual([{ branch: 'release', commitSha: 'c0ffee' }]);
    expect(inserted[0]).toMatchObject({ triggerSource: 'promote', commitSha: 'c0ffee' });
  });

  it('refuses a source build that is not ready', async () => {
    const { db } = makeDb([[{ ...SOURCE, status: 'building' }]]);
    await expect(new DeploymentService({ db, siteId: 's1', keys }).promote('dep_src', 'tgt_prod')).rejects.toBeInstanceOf(DeploymentError);
  });
});

describe('deploy approvals never surface as AI approvals', () => {
  it('the AI harness does not know deploy:trigger / deploy:promote, so /ai/approvals neither lists nor decides them', async () => {
    const { AISecureHarness } = await import('../../ai-harness');
    const harness = new AISecureHarness({ db: {} as Database, siteId: 's1' });
    expect(harness.validateSkill('deploy:trigger')).toBeUndefined();
    expect(harness.validateSkill('deploy:promote')).toBeUndefined();
  });
});
