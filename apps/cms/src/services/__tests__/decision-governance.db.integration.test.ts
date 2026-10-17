import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  apiKeyPolicies,
  apiKeys,
  auditLog,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  settings,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AuthPrincipal } from '../../env';
import {
  authorizeDecision,
  decisionQuotaFromEnv,
  readDecisionSettings,
  runGovernedDecision,
  type GovernedDecisionOutcome,
} from '../decision-governance';
import { createDecisionProvider } from '../decision-provider';
import { EffectiveCapabilityService, principalRefFromAuth } from '../effective-capability-service';
import { resolvePrincipalCapabilities } from '../governed-capabilities';
import { PermissionService, __resetPermissionProcessCacheForTests } from '../permission-service';

/**
 * #511 (J04) against a real Postgres, through #529's public pieces exactly as
 * routes/ai.ts wires them: principalRefFromAuth → EffectiveCapabilityService
 * (real policy/permission rows) → authorizeDecision → readDecisionSettings
 * (real settings row) → runGovernedDecision (real AuditLogger, read back from
 * lumibase_audit_log). Only the upstream LLM `fetch` is stubbed.
 *
 * Two sites. The API key and the opt-in live on A; site B has its own key
 * with a grant but no opt-in. A user who is a member of A only, with a role
 * that lacks the grant, carries forged token roles (external-JWT shape) that
 * must not count. Skips without DATABASE_URL.
 */

const SITE_A = 'site_dec_gov_a';
const SITE_B = 'site_dec_gov_b';
const KEY_A = 'key_dec_gov_a';
const KEY_B = 'key_dec_gov_b';
const USER = 'usr_dec_gov_member';
const STATE_SENTINEL = 'state-sentinel-jane.doe@example.test';

const request = {
  state: { note: STATE_SENTINEL },
  questions: { spam: { type: 'noul' as const, instructions: 'Spam?', criteria: { true: 'spam', false: 'ok' } } },
};
const env = { DECISION_PROVIDER: 'llm', LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-it' };

const keyAuth = (id: string): AuthPrincipal => ({ type: 'api_key', apiKeyId: id, roles: [], raw: {} });
const userAuth: AuthPrincipal = { type: 'user', userId: USER, email: 'member@x.dev', roles: ['forged'], raw: {} };

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.skipIf(!hasDbIntegrationUrl)('decision governance — DB integration (two sites)', () => {
  let db: Database;
  let cache: MemoryCacheProvider;
  let fetchMock: ReturnType<typeof vi.fn>;
  let memberRoleId: string;

  async function decide(siteId: string, auth: AuthPrincipal): Promise<{ code: string; outcome?: GovernedDecisionOutcome }> {
    const principal = principalRefFromAuth(auth, siteId);
    if (!principal) return { code: 'FORBIDDEN' };
    const grant = await resolvePrincipalCapabilities(new EffectiveCapabilityService({ db, siteId, cache }), principal);
    try {
      authorizeDecision(grant);
    } catch (error) {
      return { code: (error as { code: string }).code };
    }
    const outcome = await runGovernedDecision(
      async () => ({
        configured: createDecisionProvider(env),
        settings: await readDecisionSettings(db, siteId),
        quota: decisionQuotaFromEnv({}),
        cache,
        siteId,
      }),
      request,
      { audit: { db, siteId, requestId: 'req-dec-gov-it', principal } },
    );
    const body = outcome.body as { errors?: Array<{ code: string }> };
    return { code: outcome.status === 200 ? 'OK' : body.errors?.[0]?.code ?? 'UNKNOWN', outcome };
  }

  async function grantPolicy(siteId: string, name: string): Promise<string> {
    const [policy] = await db
      .insert(policies)
      .values({ siteId, name, adminAccess: false, appAccess: false })
      .returning({ id: policies.id });
    await db.insert(permissionsTable).values({
      siteId, policyId: policy!.id, collection: 'lumibase_ai_decisions', action: 'create', fields: ['*'],
    });
    return policy!.id;
  }

  async function cleanup() {
    await db.delete(apiKeys).where(eq(apiKeys.id, KEY_A)).catch(() => undefined);
    await db.delete(apiKeys).where(eq(apiKeys.id, KEY_B)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE_A)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, USER)).catch(() => undefined);
  }

  beforeAll(async () => {
    db = await connectDbIntegration('decision-governance');
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
  });

  beforeEach(async () => {
    cache = new MemoryCacheProvider();
    __resetPermissionProcessCacheForTests();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answers: { spam: { noul: 0.3 } } }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await cleanup();
    await db.insert(sites).values([{ id: SITE_A, name: 'Dec Gov A' }, { id: SITE_B, name: 'Dec Gov B' }]);
    // Opt-in on A only.
    await db.insert(settings).values({ siteId: SITE_A, key: 'aiDecisions', value: { enabled: true } });

    const policyA = await grantPolicy(SITE_A, 'AI decisions A');
    const policyB = await grantPolicy(SITE_B, 'AI decisions B');
    await db.insert(apiKeys).values([
      { id: KEY_A, siteId: SITE_A, name: 'Dec Gov A', prefix: 'lbk_sec_a', tokenHash: 'not-a-real-hash-dec-gov-a' },
      { id: KEY_B, siteId: SITE_B, name: 'Dec Gov B', prefix: 'lbk_sec_b', tokenHash: 'not-a-real-hash-dec-gov-b' },
    ]);
    await db.insert(apiKeyPolicies).values([
      { siteId: SITE_A, apiKeyId: KEY_A, policyId: policyA, priority: 0 },
      { siteId: SITE_B, apiKeyId: KEY_B, policyId: policyB, priority: 0 },
    ]);

    await db.insert(users).values({ id: USER, email: 'member@x.dev', status: 'active' });
    const [member] = await db
      .insert(roles)
      .values({ siteId: SITE_A, name: 'Member', adminAccess: false, appAccess: true })
      .returning({ id: roles.id });
    memberRoleId = member!.id;
    await db.insert(userSites).values({ userId: USER, siteId: SITE_A, roleId: memberRoleId });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows the granted key on site A and writes a uuidv7 audit row without the state', async () => {
    await expect(decide(SITE_A, keyAuth(KEY_A))).resolves.toMatchObject({ code: 'OK' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE_A), eq(auditLog.event, 'ai_decision')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(UUIDV7);
    expect(rows[0]!.siteId).toBe(SITE_A);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(STATE_SENTINEL);
    expect(rows[0]!.metadata).toMatchObject({ outcome: 'OK', principal: { type: 'api_key', id: KEY_A } });
  });

  it("denies site A's key on site B before any upstream call", async () => {
    await expect(decide(SITE_B, keyAuth(KEY_A))).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies a member whose role lacks the grant, despite forged token roles; a grant + version bump allows', async () => {
    await expect(decide(SITE_A, userAuth)).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(fetchMock).not.toHaveBeenCalled();

    const policy = await grantPolicy(SITE_A, 'Member AI decisions');
    await db.insert(rolePolicies).values({ roleId: memberRoleId, policyId: policy, priority: 0 });
    await PermissionService.bumpVersion(cache, SITE_A);

    await expect(decide(SITE_A, userAuth)).resolves.toMatchObject({ code: 'OK' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Membership is on A only: the same user is not a principal on B.
    await expect(decide(SITE_B, userAuth)).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("site B's grant does not inherit site A's opt-in: DECISION_DISABLED, no upstream call", async () => {
    await expect(decide(SITE_B, keyAuth(KEY_B))).resolves.toMatchObject({ code: 'DECISION_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
