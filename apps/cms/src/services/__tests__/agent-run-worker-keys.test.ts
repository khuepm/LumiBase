import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentRuns, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { processAgentRunJob, type AgentRunJobPayload } from '../agent-run-worker';

/**
 * Regression guard: a queued agent run must be able to execute exactly the
 * skills the synchronous request path can.
 *
 * The deployment skills build a `DeploymentService` from `db + siteId + keys`;
 * without a `KeyProvider` the harness fails them with
 * `DEPLOYMENTS_NOT_CONFIGURED` (`ai-harness.ts`, `deploymentService()`).
 * `AgentRunWorkerDeps` did not carry `keys`, so `triggerDeployment` /
 * `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` failed
 * whenever the same skill was dispatched through the `agent-runs` queue
 * (`execution: 'async'`) instead of executed inline.
 *
 * `listDeploymentTargets` is the probe: it is `safe` (`deployments:read`), so
 * it runs the handler directly instead of parking on a HITL approval, which is
 * what makes the missing provider observable.
 *
 * The source-scan companion that locks this class for *future* call sites is
 * `apps/cms/src/__tests__/ai-harness-keys-context.test.ts`.
 */

interface Recorded {
  /** Tables read, in order — proves the deployment path was reached. */
  selected: string[];
  inserted: { table: string; values: Record<string, unknown> }[];
  updated: { table: string; patch: Record<string, unknown> }[];
}

const RUN_ROW = {
  id: 'run_1',
  siteId: 'site_1',
  goalId: 'goal_1',
  agentName: 'lumibase-copilot',
  status: 'queued',
  metrics: {},
};

/**
 * Table-aware drizzle stand-in. `agent_runs` reads return the single run row
 * (so `markRunning` transitions it); every other table reads empty — no
 * freeze, no tool override, no deployment targets configured. Writes are
 * recorded so the test can assert on the tool-call outcome the harness wrote.
 */
function fakeDb(recorded: Recorded): Database {
  let idCounter = 0;
  const nextId = () => `id_${++idCounter}`;

  const rowsFor = (table: string) =>
    table === getTableName(agentRuns) ? [{ ...RUN_ROW }] : [];

  const selectResult = (table: string) => {
    const rows = rowsFor(table);
    const thenable = Promise.resolve(rows);
    return Object.assign(thenable, {
      limit: async () => rows,
      orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
    });
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        recorded.selected.push(name);
        return {
          where: () => selectResult(name),
          // Every read on this path is site-scoped (`.where()`); the unfiltered
          // shape exists only so a stray query fails on its assertion rather
          // than on a missing method.
          orderBy: () => selectResult(name),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const row = { id: nextId(), ...values };
        recorded.inserted.push({
          table: getTableName(table as Parameters<typeof getTableName>[0]),
          values: row,
        });
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [row],
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

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v0', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
  getKey: async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  listKeys: async () => [{ keyId: 'v0', status: 'active', algo: 'AES-GCM' }],
};

const payload: AgentRunJobPayload = {
  siteId: 'site_1',
  goalId: 'goal_1',
  runId: 'run_1',
  skillName: 'listDeploymentTargets',
  arguments: {},
  capabilities: ['deployments:read'],
};

function toolCallOutcome(recorded: Recorded) {
  return recorded.updated.find((row) => row.table === 'lumibase_agent_tool_calls')?.patch;
}

function runOutcome(recorded: Recorded) {
  // The last agent_runs write is the terminal transition (markRunning first).
  return recorded.updated.filter((row) => row.table === 'lumibase_agent_runs').at(-1)?.patch;
}

describe('queued agent runs: deployment skills need the runtime KeyProvider', () => {
  it('executes a deployment skill when the worker is given a KeyProvider', async () => {
    const recorded: Recorded = { selected: [], inserted: [], updated: [] };

    await processAgentRunJob({ db: fakeDb(recorded), env: {}, keys }, payload);

    const toolCall = toolCallOutcome(recorded);
    expect(toolCall?.['error']).toBeNull();
    expect(toolCall?.['status']).toBe('executed');
    expect(toolCall?.['output']).toEqual({ targets: [] });
    expect(runOutcome(recorded)?.['status']).toBe('succeeded');

    // The handler really reached DeploymentService.listTargets() — the guard
    // that used to short-circuit on the missing provider is behind this read.
    expect(recorded.selected).toContain('lumibase_deployment_targets');
  });

  it('fails the skill without a KeyProvider (the bug this guards against)', async () => {
    const recorded: Recorded = { selected: [], inserted: [], updated: [] };

    await processAgentRunJob({ db: fakeDb(recorded), env: {} }, payload);

    expect(toolCallOutcome(recorded)?.['status']).toBe('failed');
    expect(String(toolCallOutcome(recorded)?.['error'])).toContain('DEPLOYMENTS_NOT_CONFIGURED');
    expect(runOutcome(recorded)?.['status']).toBe('failed');
    expect(recorded.selected).not.toContain('lumibase_deployment_targets');
  });

  it('scopes the queued run to the payload site, not a request context', async () => {
    const recorded: Recorded = { selected: [], inserted: [], updated: [] };

    await processAgentRunJob({ db: fakeDb(recorded), env: {}, keys }, payload);

    const toolCallInsert = recorded.inserted.find(
      (row) => row.table === 'lumibase_agent_tool_calls',
    );
    expect(toolCallInsert?.values['siteId']).toBe(payload.siteId);
  });
});
