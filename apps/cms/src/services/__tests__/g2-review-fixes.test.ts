import { getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { memberRbac, selectForRbac } from '../../test-utils/rbac-principal-db';

/**
 * Three defects found in review of the #454/#472 implementation. Each is pinned
 * here so the fix cannot regress quietly.
 *
 * All three share a shape worth naming: the coarse layer was correct and the
 * narrow layer was missing, so nothing looked wrong at the point of the change.
 */

// ── Shared fake db ─────────────────────────────────────────────────────────────

function recordingDb() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
  let seq = 0;

  const rowsFor = (table: string): Record<string, unknown>[] => {
    switch (table) {
      case 'lumibase_agent_freezes':
        return [];
      case 'lumibase_agent_tools':
        return [];
      case 'lumibase_agent_runs':
        return [{ id: 'run_1', goalId: 'goal_1', agentName: 'lumibase-copilot', status: 'running', metrics: {} }];
      default:
        return [];
    }
  };

  const chain = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as Parameters<typeof getTableName>[0]);
        return c;
      },
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(rowsFor(table)),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(resolve, reject),
    };
    return c;
  };

  const db = {
    select: () => chain(),
    insert: (t: unknown) => {
      const table = getTableName(t as Parameters<typeof getTableName>[0]);
      return {
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          seq += 1;
          const result = [{ id: `${table}_${seq}`, goalId: 'goal_1', agentName: 'a', status: 'running' }];
          return {
            returning: () => Promise.resolve(result),
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
          };
        },
      };
    },
    update: (t: unknown) => {
      const table = getTableName(t as Parameters<typeof getTableName>[0]);
      return {
        set: (set: Record<string, unknown>) => {
          updates.push({ table, set });
          const c: Record<string, unknown> = {
            where: () => c,
            returning: () => Promise.resolve(rowsFor(table)),
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
          };
          return c;
        },
      };
    },
  };

  return { db: db as unknown as Database, inserts, updates };
}

// ── P2 · a queued run must not be left in `running` ───────────────────────────

describe('review fix · invalid input settles an already-running run', () => {
  /**
   * The async path creates the run at enqueue and the worker moves it to
   * `running` **before** calling the harness. Input validation was placed before
   * `ensureRun` so that a synchronous call writes nothing — correct — but
   * "create no run" is not "leave an existing run alone": returning `denied`
   * without settling parked the run in `running` forever. A queued `createItem`
   * with `arguments: {}` reproduced it.
   *
   * The kill-switch branch a few lines above already handled the same situation
   * via `cancelRun`; this branch simply did not.
   */
  it('fails the run when the envelope carries one', async () => {
    const { AISecureHarness } = await import('../ai-harness');
    const { db, updates, inserts } = recordingDb();

    const result = await new AISecureHarness({ db, siteId: 'site_1', enableAgentHarnessAudit: true }).execute(
      'createItem',
      {},
      ['items:write'],
      'queued probe',
      { runId: 'run_1', goalId: 'goal_1' },
    );

    expect(result.status).toBe('denied');
    expect(result.code).toBe('VALIDATION');
    expect(result.runId).toBe('run_1');

    const failed = updates.filter(
      (u) => u.table === 'lumibase_agent_runs' && u.set['status'] === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.set['error']).toContain('collection');
    expect((failed[0]!.set['metrics'] as Record<string, unknown>)['stopReason']).toBe('invalid_input');

    // Still no run and no tool call CREATED — the property GP5 pins is intact.
    expect(inserts.filter((i) => i.table === 'lumibase_agent_runs')).toHaveLength(0);
    expect(inserts.filter((i) => i.table === 'lumibase_agent_tool_calls')).toHaveLength(0);
  });

  it('writes nothing at all when there is no run to settle', async () => {
    const { AISecureHarness } = await import('../ai-harness');
    const { db, updates, inserts } = recordingDb();

    const result = await new AISecureHarness({ db, siteId: 'site_1', enableAgentHarnessAudit: true }).execute(
      'createItem',
      {},
      ['items:write'],
    );

    expect(result.status).toBe('denied');
    expect(result.code).toBe('VALIDATION');
    expect(result.runId).toBeUndefined();
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

// ── P2 · delete_field must be able to force ───────────────────────────────────

describe('review fix · deleteField forwards force to the service', () => {
  /**
   * `delete_field` advertises `force`, `SchemaService.deleteField` accepts
   * `FieldDeleteOptions.force`, and the REST route passes `?force=true` through —
   * but the skill handler dropped it and the canonical contract did not declare
   * it. So the governed path was the one place the flag could not be expressed,
   * and `.strict()` turned that into a `VALIDATION` denial.
   */
  it('passes force through when asked, and omits the option when not', async () => {
    const { AISecureHarness } = await import('../ai-harness');
    const calls: Array<[string, string, unknown]> = [];
    const schemaService = {
      deleteField: vi.fn((collection: string, name: string, options: unknown) => {
        calls.push([collection, name, options]);
        return Promise.resolve({ ok: true });
      }),
    };
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      schemaService: schemaService as never,
      enableAgentHarnessAudit: false,
    });

    const forced = await harness.runSkill('deleteField', { collection: 'posts', name: 'title', force: true });
    expect(forced.success).toBe(true);
    expect(calls[0]).toEqual(['posts', 'title', { force: true }]);

    const plain = await harness.runSkill('deleteField', { collection: 'posts', name: 'body' });
    expect(plain.success).toBe(true);
    expect(calls[1]).toEqual(['posts', 'body', {}]);
  });

  it('accepts force in the canonical contract, in both truthy and falsy form', async () => {
    const { validateAgentToolInput } = await import('@lumibase/contracts');
    expect(validateAgentToolInput('deleteField', { collection: 'posts', name: 'title', force: true }).ok).toBe(true);
    expect(validateAgentToolInput('deleteField', { collection: 'posts', name: 'title', force: false }).ok).toBe(true);
    // Still strict about everything else.
    expect(validateAgentToolInput('deleteField', { collection: 'posts', name: 'title', nope: 1 }).ok).toBe(false);
  });
});

// ── P1 · async chat must enforce row/field RBAC ────────────────────────────────

const itemServiceDeps: Array<Record<string, unknown>> = [];
const systemContextReasons: string[] = [];

vi.mock('../item-service', () => ({
  ItemService: class {
    constructor(deps: Record<string, unknown>) {
      itemServiceDeps.push(deps);
    }
  },
}));
vi.mock('../item-service-factory', () => ({
  itemServiceForSystem: (deps: Record<string, unknown>, reason: string) => {
    systemContextReasons.push(reason);
    itemServiceDeps.push(deps);
    return {};
  },
  itemServiceForPrincipal: (deps: Record<string, unknown>, permissionCtx: unknown) => {
    itemServiceDeps.push({ ...deps, permissionCtx });
    return {};
  },
}));
vi.mock('../llm-provider', () => ({
  createConfiguredLLMProvider: () => null,
  createLLMProvider: () => ({
    chat: () =>
      Promise.resolve({
        content: null,
        toolCalls: [{ name: 'createItem', arguments: { collection: 'posts', data: { title: 'x' } } }],
      }),
  }),
}));
vi.mock('../flow-run-service', () => ({
  markRunRunning: () => Promise.resolve(undefined),
  persistAiChatOutcome: () => Promise.resolve(undefined),
}));

describe('review fix · async AI chat binds ItemService to the principal', () => {
  beforeEach(() => {
    itemServiceDeps.length = 0;
    systemContextReasons.length = 0;
  });

  /** Enough of a db for `EffectiveCapabilityService` to resolve a member. */
  function principalDb() {
    const rbac = memberRbac('u_member', [{ collection: 'articles', action: 'create' }]);
    return {
      select: selectForRbac(rbac),
      insert: () => ({ values: () => Promise.resolve(undefined) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    } as unknown as Database;
  }

  it('gives ItemService a permissionCtx so row/field rules still apply', async () => {
    const { executeAiChatRun } = await import('../ai-chat-run-worker');

    await executeAiChatRun(principalDb(), {
      kind: 'ai_chat',
      siteId: 'site_1',
      runId: 'run_1',
      conversationId: 'conv_1',
      message: 'create a post',
      principal: { type: 'user', siteId: 'site_1', userId: 'u_member' },
      userId: 'u_member',
    });

    // BEFORE: `new ItemService({ db, siteId, userId, keyProvider })` — no
    // `permissionCtx`, so a member granted `create` on `articles` alone resolved
    // to `items:write` (true — they may write *something*) and then wrote to any
    // collection, because nothing narrower was left to stop them.
    expect(itemServiceDeps).toHaveLength(1);
    expect(itemServiceDeps[0]!['permissionCtx']).toBeDefined();
    expect((itemServiceDeps[0]!['permissionCtx'] as { userId?: string }).userId).toBe('u_member');
    expect((itemServiceDeps[0]!['permissionCtx'] as { siteId?: string }).siteId).toBe('site_1');
    // Not the system escape hatch.
    expect(systemContextReasons).toEqual([]);
  });

  it('falls back to a NAMED system context only for legacy jobs with no principal', async () => {
    const { executeAiChatRun } = await import('../ai-chat-run-worker');

    await executeAiChatRun(principalDb(), {
      kind: 'ai_chat',
      siteId: 'site_1',
      runId: 'run_1',
      conversationId: 'conv_1',
      message: 'create a post',
      userCapabilities: ['items:write'],
      userId: 'u_member',
    });

    // A job enqueued before `principal` existed has no identity to bind, so there
    // is nothing to derive a context from. The point is that the fail-open is
    // declared through `itemServiceForSystem` instead of happening implicitly.
    expect(systemContextReasons).toEqual(['background-worker']);
  });
});
