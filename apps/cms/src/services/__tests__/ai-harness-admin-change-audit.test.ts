import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #988 — a control-plane skill executed by an agent records the same
 * `admin_change` audit event a person's HTTP request does, with `via: 'agent'`
 * and the run id. Argument names only — never values.
 */

const h = vi.hoisted(() => ({ writes: [] as Array<Record<string, unknown>> }));

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    constructor(readonly deps: { siteId?: string | null }) {}
    write(entry: Record<string, unknown>) {
      h.writes.push({ ...entry, siteId: this.deps.siteId });
      return Promise.resolve();
    }
  },
}));

const { AISecureHarness } = await import('../ai-harness');

beforeEach(() => {
  h.writes.length = 0;
});

describe('agent control-plane skills are audited', () => {
  it('records an executed control-plane skill with via=agent, run id and argument names', async () => {
    const deleteCollection = vi.fn().mockResolvedValue({ ok: true });
    const harness = new AISecureHarness({ db: {} as never, siteId: 'site_1', schemaService: { deleteCollection } as never });

    const result = await harness.runSkill('deleteCollection', { name: 'posts' }, { runId: 'run_42' });
    expect(result.success).toBe(true);
    expect(h.writes).toEqual([
      expect.objectContaining({
        event: 'admin_change',
        siteId: 'site_1',
        metadata: { via: 'agent', skill: 'deleteCollection', runId: 'run_42', changedFields: ['name'] },
      }),
    ]);
    expect(JSON.stringify(h.writes)).not.toContain('posts');
  });

  it('does not record a skill that failed', async () => {
    const deleteCollection = vi.fn().mockRejectedValue(new Error('boom'));
    const harness = new AISecureHarness({ db: {} as never, siteId: 'site_1', schemaService: { deleteCollection } as never });

    const result = await harness.runSkill('deleteCollection', { name: 'posts' });
    expect(result.success).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('does not record safe (non-control-plane) skills', async () => {
    const listCollections = vi.fn().mockResolvedValue([]);
    const harness = new AISecureHarness({ db: {} as never, siteId: 'site_1', schemaService: { listCollections } as never });

    const result = await harness.runSkill('listCollections', {});
    expect(result.success).toBe(true);
    expect(listCollections).toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});
