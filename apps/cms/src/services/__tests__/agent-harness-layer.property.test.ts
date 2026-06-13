import { Hono } from 'hono';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  agentApprovals,
  agentArtifacts,
  agentEvaluations,
  agentGoals,
  agentRuns,
  agentToolCalls,
  aiApprovals,
  constitutions,
  type Database,
} from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { agentRouter } from '../../routes/agent';
import { AgentArtifactService } from '../agent-artifact-service';
import { AgentRunService } from '../agent-run-service';
import { AISecureHarness } from '../ai-harness';

type Row = Record<string, unknown>;

function tableKey(table: unknown): string {
  switch (table) {
    case agentGoals:
      return 'goals';
    case agentRuns:
      return 'runs';
    case agentToolCalls:
      return 'toolCalls';
    case agentApprovals:
      return 'approvals';
    case agentArtifacts:
      return 'artifacts';
    case agentEvaluations:
      return 'evaluations';
    case aiApprovals:
      return 'legacyApprovals';
    case constitutions:
      return 'constitutions';
    default:
      return 'unknown';
  }
}

function createHarnessDb(activeSiteId: string, seed: Partial<Record<string, Row[]>> = {}) {
  let seq = 0;
  const rows: Record<string, Row[]> = {
    goals: [...(seed.goals ?? [])],
    runs: [...(seed.runs ?? [])],
    toolCalls: [...(seed.toolCalls ?? [])],
    approvals: [...(seed.approvals ?? [])],
    artifacts: [...(seed.artifacts ?? [])],
    evaluations: [...(seed.evaluations ?? [])],
    legacyApprovals: [...(seed.legacyApprovals ?? [])],
    // Publish gate dependency: no active constitution → gate passes.
    constitutions: [...(seed.constitutions ?? [])],
  };

  const visible = (key: string) => {
    const scoped = rows[key]!.filter((row) => row['siteId'] === undefined || row['siteId'] === activeSiteId);
    if (key === 'evaluations') {
      return scoped.filter((row) => row['status'] === 'pass');
    }
    return scoped;
  };

  const db = {
    insert(table: unknown) {
      const key = tableKey(table);
      return {
        values(value: Row) {
          return {
            returning: async () => {
              const now = new Date();
              const record = {
                id: value['id'] ?? `${key}_${++seq}`,
                createdAt: value['createdAt'] ?? now,
                updatedAt: value['updatedAt'] ?? now,
                ...value,
              };
              rows[key]!.push(record);
              return [record];
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const key = tableKey(table);
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async (n: number) => visible(key).slice(0, n),
            then: (resolve: (value: Row[]) => unknown) => Promise.resolve(visible(key)).then(resolve),
          };
          return chain;
        },
      };
    },
    update(table: unknown) {
      const key = tableKey(table);
      return {
        set(patch: Row) {
          return {
            where() {
              const updated = visible(key).map((row) => {
                Object.assign(row, patch);
                return row;
              });
              return {
                returning: async () => updated,
                then: (resolve: (value: Row[]) => unknown) => Promise.resolve(updated).then(resolve),
              };
            },
          };
        },
      };
    },
  } as unknown as Database;

  return { db, rows };
}

function createQueueRecorder(): QueueProvider & { jobs: Row[] } {
  const jobs: Row[] = [];
  return {
    jobs,
    async enqueue(queueName, jobName, data) {
      jobs.push({ queueName, jobName, data });
      return `job_${jobs.length}`;
    },
    process() {},
    async getStatus() {
      return null;
    },
  };
}

const siteIdArb = fc.stringMatching(/^site_[a-z0-9]{3,12}$/);

describe('Agent Harness Layer completion properties', () => {
  it('keeps run and tool-call reads scoped to the active site', async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, siteIdArb, async (siteA, siteB) => {
        fc.pre(siteA !== siteB);
        const { db, rows } = createHarnessDb(siteB, {
          runs: [
            { id: 'run_a', goalId: 'goal_a', siteId: siteA, agentName: 'other', status: 'failed', createdAt: new Date() },
          ],
        });

        const service = new AgentRunService(db, siteB);
        const run = await service.ensureRun({ title: 'scoped run' });
        await service.appendToolCall({ runId: run.runId, toolName: 'listCollections', input: { apiKey: 'secret' } });
        const listed = await service.listRuns();

        expect(listed.every((entry) => entry.siteId === siteB)).toBe(true);
        expect(rows['toolCalls']!.every((entry) => entry.siteId === siteB)).toBe(true);
        expect(rows['toolCalls']![0]!.input).toEqual({ apiKey: '[masked]' });
      }),
      { numRuns: 30 },
    );
  });

  it('preserves failed run audit, retries as a new run, and dead-letters repeated failures once', async () => {
    const queue = createQueueRecorder();
    const { db, rows } = createHarnessDb('site_a');
    const service = new AgentRunService(db, 'site_a', queue);
    const first = await service.ensureRun({ title: 'retry target' });

    await service.failRun(first.runId, 'first failure', { stopReason: 'error' });
    const second = await service.retryRun(first.runId);
    expect(second).not.toBeNull();
    await service.failRun(second!.runId, 'second failure', { stopReason: 'error' });
    const third = await service.retryRun(second!.runId);
    await service.failRun(third!.runId, 'third failure', { stopReason: 'error' });

    const failed = rows['runs']!.filter((run) => run.status === 'failed');
    expect(failed).toHaveLength(3);
    expect(new Set(rows['toolCalls']!.map((call) => call.id)).size).toBe(rows['toolCalls']!.length);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.queueName).toBe('agent-dead-letter');
  });

  it('denies dangerous approvals that were rejected or expired before execution', async () => {
    const now = new Date();
    const { db } = createHarnessDb('site_a', {
      legacyApprovals: [
        {
          id: 'legacy_1',
          siteId: 'site_a',
          skillName: 'deleteItem',
          arguments: { collection: 'products', id: 'item_1' },
          status: 'pending',
          agentName: 'lumibase-copilot',
          context: null,
          createdAt: now,
        },
      ],
      approvals: [
        {
          id: 'agent_approval_1',
          runId: 'run_1',
          siteId: 'site_a',
          legacyApprovalId: 'legacy_1',
          subjectType: 'tool_call',
          subjectId: 'tool_1',
          status: 'rejected',
          requestedByAgent: 'lumibase-copilot',
          expiresAt: null,
          createdAt: now,
        },
      ],
    });
    const harness = new AISecureHarness({ db, siteId: 'site_a', enableAgentHarnessAudit: true });

    const rejected = await harness.executeApproved('legacy_1', 'user_1');
    expect(rejected.status).toBe('denied');

    const expiredDb = createHarnessDb('site_a', {
      legacyApprovals: [
        {
          id: 'legacy_2',
          siteId: 'site_a',
          skillName: 'deleteItem',
          arguments: { collection: 'products', id: 'item_1' },
          status: 'pending',
          agentName: 'lumibase-copilot',
          context: null,
          createdAt: now,
        },
      ],
      approvals: [
        {
          id: 'agent_approval_2',
          runId: 'run_2',
          siteId: 'site_a',
          legacyApprovalId: 'legacy_2',
          subjectType: 'tool_call',
          subjectId: 'tool_2',
          status: 'pending',
          requestedByAgent: 'lumibase-copilot',
          expiresAt: new Date(now.getTime() - 1000),
          createdAt: now,
        },
      ],
    }).db;
    const expiredHarness = new AISecureHarness({ db: expiredDb, siteId: 'site_a', enableAgentHarnessAudit: true });
    const expired = await expiredHarness.executeApproved('legacy_2', 'user_1');
    expect(expired.status).toBe('denied');
    expect(expired.message).toMatch(/expired/i);
  });

  it('blocks failed artifact evaluations, keeps hashes stable, and makes publish/rollback idempotent', async () => {
    const { db, rows } = createHarnessDb('site_a');
    const service = new AgentArtifactService(db, 'site_a');
    const bad = await service.createArtifact({
      runId: 'run_1',
      type: 'schema_diff',
      title: 'Bad diff',
      content: { title: 'missing operations' },
    });

    await expect(service.publishArtifact(bad.id)).resolves.toMatchObject({ allowed: false });
    rows['evaluations']!.push({
      id: 'eval_1',
      runId: 'run_1',
      siteId: 'site_a',
      artifactId: bad.id,
      kind: 'schema_validation',
      status: 'fail',
      artifactHash: bad.hash,
      createdAt: new Date(),
    });
    await expect(service.publishArtifact(bad.id)).resolves.toMatchObject({ allowed: false });

    rows['evaluations']!.push({
      id: 'eval_2',
      runId: 'run_1',
      siteId: 'site_a',
      artifactId: bad.id,
      kind: 'schema_validation',
      status: 'pass',
      artifactHash: bad.hash,
      createdAt: new Date(),
    });
    const firstPublish = await service.publishArtifact(bad.id);
    const secondPublish = await service.publishArtifact(bad.id);
    expect(firstPublish.allowed).toBe(true);
    expect(secondPublish.allowed).toBe(true);
    expect(firstPublish.artifact?.hash).toBe(secondPublish.artifact?.hash);

    const firstRollback = await service.rollbackArtifact(bad.id, 'test rollback');
    const secondRollback = await service.rollbackArtifact(bad.id, 'test rollback');
    expect(firstRollback.allowed).toBe(true);
    expect(secondRollback.allowed).toBe(true);
    expect(secondRollback.artifact?.status).toBe('rolled_back');
  });

  it('runs the storefront generation flow end-to-end through the Agent router', async () => {
    const { db } = createHarnessDb('site_demo');
    const queue = createQueueRecorder();
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('db', db);
        c.set('siteId', 'site_demo');
        c.set('auth', { userId: 'user_1', raw: {} });
        c.set('runtime', { queue } as unknown as RuntimeContext);
        await next();
      })
      .route('/agent', agentRouter);

    const res = await app.request('/agent/generate-app', {
      method: 'POST',
      body: JSON.stringify({
        collections: ['products', 'orders', 'customers'],
        targetApp: 'storefront',
        approvalPolicy: 'before_commit',
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { artifacts: Row[]; evaluations: Row[]; run: Row } };
    expect(body.data.run.runId).toBeTruthy();
    expect(body.data.artifacts.map((artifact) => artifact.type).sort()).toEqual([
      'api_spec',
      'component_spec',
      'page_spec',
      'seed_data',
    ]);
    expect(body.data.evaluations).toHaveLength(4);
    expect(body.data.evaluations.every((evaluation) => evaluation.status === 'pass')).toBe(true);
  });
});
