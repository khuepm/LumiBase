import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { getHandler, runFlow, type FlowGraph } from '../flow-service';
import { processFlowRunJob, runFlowSyncWithTimeout } from '../flow-run-service';

const secret = 'synthetic-secret-proof';
const environment = { JWT_SECRET: secret, ENCRYPTION_KEY: secret, TYPESAFE_API_KEY: secret, DATABASE_URL: secret };
const blockedPaths = [
  'env', 'env.processEnv', ...Object.keys(environment).map((key) => `env.processEnv.${key}`),
  'env.keys', 'env.db', '', 'input.__proto__', 'input.constructor.prototype',
  'steps.__proto__', 'steps.previous.constructor', 'input.prototype',
];
const graphFor = (path: string): FlowGraph => ({ nodes: [
  { id: 'extract', key: 'condition', options: { path, value: '' } },
] });

describe('condition data boundary (#546)', () => {
  it.each(blockedPaths)('rejects %s without exposing runtime data', async (path) => {
    const result = await runFlow(graphFor(path), {}, { processEnv: environment });
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.steps.extract).not.toHaveProperty('actual');
  });

  it('does not traverse inherited input properties', async () => {
    const result = await runFlow(graphFor('input.hidden'), Object.create({ hidden: secret }));
    expect(result.status).toBe('success');
    expect(result.steps.extract).toHaveProperty('actual', undefined);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('preserves nested input, arrays, previous steps and missing-field comparisons', async () => {
    const condition = getHandler('condition')!;
    const ctx = { input: { tags: ['news'] }, steps: { previous: { score: 0.9 } }, env: { processEnv: environment } };
    expect(await condition(ctx, { path: 'input.tags.0', value: 'news' })).toMatchObject({ pass: true, actual: 'news' });
    expect(await condition(ctx, { path: 'steps.previous.score', operator: '>', value: 0.8 })).toMatchObject({ pass: true });
    expect(await condition(ctx, { path: 'input.missing' })).toMatchObject({ pass: true, actual: undefined });
  });

  it.each(['sync', 'worker'] as const)('%s runs never return or persist credentials', async (mode) => {
    for (const path of blockedPaths) {
      const writes: Record<string, unknown>[] = [];
      const db = {
        select: () => ({ from: () => ({ where: async () => [{ graph: graphFor(path) }] }) }),
        update: () => ({ set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: async () => undefined };
        } }),
      } as unknown as Database;
      if (mode === 'sync') {
        const result = await runFlowSyncWithTimeout(db, 'site', 'flow', 'run', {}, undefined, environment);
        expect(result.status).toBe('error');
        expect(JSON.stringify(result)).not.toContain(secret);
      } else {
        await processFlowRunJob(db, { kind: 'flow', siteId: 'site', flowId: 'flow', runId: 'run', input: {} }, undefined, environment);
      }
      expect(writes.at(-1)).toMatchObject({ status: 'error' });
      expect(JSON.stringify(writes)).not.toContain(secret);
    }
  });
});
