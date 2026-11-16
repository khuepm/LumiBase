import { getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';

/**
 * #580 review R2: the agent-runs worker must fail closed when a job carries a
 * user or API-key principal but the capability resolution comes back without a
 * `permissionContext`. Falling back to the system ItemService there would
 * reopen the row/field bypass that #580 removes.
 *
 * `resolvePrincipalCapabilities` is replaced so the test can produce the
 * (otherwise unreachable) "allowed, no context" resolution. Everything after it
 * is the real worker.
 */
const resolution = vi.hoisted(() => ({
  value: undefined as unknown,
}));

vi.mock('../governed-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../governed-capabilities')>();
  return {
    ...actual,
    resolvePrincipalCapabilities: vi.fn(async () => resolution.value),
  };
});

const factory = vi.hoisted(() => ({ system: 0, principal: 0 }));
vi.mock('../item-service-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../item-service-factory')>();
  return {
    ...actual,
    itemServiceForSystem: (...args: Parameters<typeof actual.itemServiceForSystem>) => {
      factory.system += 1;
      return actual.itemServiceForSystem(...args);
    },
    itemServiceForPrincipal: (...args: Parameters<typeof actual.itemServiceForPrincipal>) => {
      factory.principal += 1;
      return actual.itemServiceForPrincipal(...args);
    },
  };
});

const { processAgentRunJob } = await import('../agent-run-worker');
type Payload = Parameters<typeof processAgentRunJob>[1];

const RUN_ROW = {
  id: 'run_1',
  siteId: 'site_1',
  goalId: 'goal_1',
  agentName: 'lumibase-copilot',
  status: 'queued',
  metrics: {},
};

interface Recorded {
  inserted: string[];
  updated: { table: string; patch: Record<string, unknown> }[];
}

function fakeDb(recorded: Recorded): Database {
  const rowsFor = (table: string) => (table === 'lumibase_agent_runs' ? [RUN_ROW] : []);
  const selectResult = (table: string) => {
    const rows = rowsFor(table);
    return Object.assign(Promise.resolve(rows), {
      limit: async () => rows,
      orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
    });
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        return { where: () => selectResult(name), orderBy: () => selectResult(name) };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        recorded.inserted.push(getTableName(table as Parameters<typeof getTableName>[0]));
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [{ id: 'id_1', ...values }],
          onConflictDoNothing: () => Promise.resolve(undefined),
        });
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          recorded.updated.push({
            table: getTableName(table as Parameters<typeof getTableName>[0]),
            patch,
          });
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ ...RUN_ROW, ...patch }],
          });
        },
      }),
    }),
  } as unknown as Database;
}

const basePayload: Payload = {
  siteId: 'site_1',
  goalId: 'goal_1',
  runId: 'run_1',
  skillName: 'createItem',
  arguments: { collection: 'posts', data: { title: 'x' } },
  userId: null,
};

function lastRunWrite(recorded: Recorded) {
  return recorded.updated.filter((row) => row.table === 'lumibase_agent_runs').at(-1)?.patch;
}

/** `AgentRunService` merges metrics with `coalesce(metrics, '{}') || $json::jsonb`; read the `$json` param. */
function writtenMetrics(patch: Record<string, unknown> | undefined): Record<string, unknown> {
  const chunks = (patch?.['metrics'] as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return Object.assign({}, ...chunks.filter((chunk): chunk is string => typeof chunk === 'string').map((json) => JSON.parse(json) as Record<string, unknown>));
}

describe('agent-runs worker principal binding (#580 R2)', () => {
  beforeEach(() => {
    factory.system = 0;
    factory.principal = 0;
  });

  it.each([
    ['api_key', { type: 'api_key', siteId: 'site_1', apiKeyId: 'key_1' }],
    ['user', { type: 'user', siteId: 'site_1', userId: 'user_1' }],
  ])('fails a %s job whose resolution has no permission context, without a system ItemService', async (_label, principal) => {
    resolution.value = {
      allowed: true,
      capabilities: ['items:write'],
      controlPlaneAdmin: false,
      callerClass: 'standard',
    };
    const recorded: Recorded = { inserted: [], updated: [] };
    await processAgentRunJob(
      { db: fakeDb(recorded), env: {} },
      { ...basePayload, principal: principal as never },
    );

    expect(lastRunWrite(recorded)).toMatchObject({ status: 'failed' });
    expect(writtenMetrics(lastRunWrite(recorded))).toMatchObject({
      stopReason: 'capabilities_denied',
      code: 'PERMISSION_CONTEXT_MISSING',
    });
    expect(factory.system).toBe(0);
    expect(factory.principal).toBe(0);
    // Nothing executed: no tool call row, no item row.
    expect(recorded.inserted).not.toContain('lumibase_agent_tool_calls');
    expect(recorded.inserted).not.toContain('lumibase_items');
  });

  it('still uses the system posture for a job with no principal (legacy snapshot)', async () => {
    const recorded: Recorded = { inserted: [], updated: [] };
    await processAgentRunJob(
      { db: fakeDb(recorded), env: {} },
      { ...basePayload, skillName: 'listDeploymentTargets', arguments: {}, capabilities: ['deployments:read'] },
    );
    expect(factory.system).toBe(1);
    expect(factory.principal).toBe(0);
    expect(writtenMetrics(lastRunWrite(recorded))).not.toMatchObject({ code: 'PERMISSION_CONTEXT_MISSING' });
  });
});
