import { getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { checkContentIntegrity, parseContentIntegrityPolicy, type ContentIntegrityActor } from '../monitor';

/**
 * #989 — the monitor turns scan signals and publish bursts into an audit
 * alert, unpublishes under the site's `unpublish` policy, demotes an agent
 * whose content raised a signal, and never fails the write it checks.
 */

function fakeDb(state: { policy?: unknown; hosts?: string[]; recentPublishes?: number; agentName?: string | null; fail?: boolean }): Database {
  const rowsFor = (table: Table): unknown[] => {
    if (state.fail) throw new Error('db down');
    switch (getTableName(table)) {
      case 'lumibase_settings': return state.policy === undefined ? [] : [{ value: state.policy }];
      case 'lumibase_site_domains': return (state.hosts ?? []).map((hostname) => ({ hostname }));
      case 'lumibase_items': return [{ n: state.recentPublishes ?? 0 }];
      case 'lumibase_agent_runs': return state.agentName ? [{ agentName: state.agentName }] : [];
      default: return [];
    }
  };
  return {
    select: () => ({
      from: (table: Table) => ({
        where: () => ({
          limit: async () => rowsFor(table),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
            try {
              return Promise.resolve(rowsFor(table)).then(resolve, reject);
            } catch (err) {
              return Promise.reject(err).then(resolve, reject);
            }
          },
        }),
      }),
    }),
  } as unknown as Database;
}

const user: ContentIntegrityActor = { type: 'user', userId: 'usr_1' };
const zip = { body: 'Get it: https://files.evil.example/template.zip' };

async function run(state: Parameters<typeof fakeDb>[0], content: unknown, opts: { actor?: ContentIntegrityActor; firstPublish?: boolean } = {}) {
  const audit = vi.fn(async (_entry: { event: string; metadata: Record<string, unknown> }) => {});
  const recordIncident = vi.fn(async (_incident: { agentRole: string; capability: string; runId: string | null; detail: Record<string, unknown> }) => {});
  const outcome = await checkContentIntegrity(
    { db: fakeDb(state), siteId: 'site-a', actor: opts.actor ?? user, audit, recordIncident },
    { collection: 'articles', itemId: 'it_1', content, firstPublish: opts.firstPublish ?? false },
  );
  return { outcome, audit, recordIncident };
}

describe('checkContentIntegrity', () => {
  it('alerts (notify by default) on an off-site archive download, without unpublishing', async () => {
    const { outcome, audit } = await run({ hosts: ['cms.acme.com'] }, zip);
    expect(outcome.unpublish).toBe(false);
    expect(audit).toHaveBeenCalledWith({
      event: 'content_integrity_alert',
      metadata: expect.objectContaining({
        collection: 'articles',
        itemId: 'it_1',
        action: 'notified',
        actorType: 'user',
        userId: 'usr_1',
        signals: [expect.objectContaining({ kind: 'download_link', extension: 'zip' })],
      }),
    });
  });

  it('asks the caller to unpublish under the unpublish policy', async () => {
    const { outcome, audit } = await run({ policy: { action: 'unpublish' } }, zip);
    expect(outcome.unpublish).toBe(true);
    expect(audit.mock.calls[0]![0].metadata.action).toBe('unpublished');
  });

  it('does nothing for clean content', async () => {
    const { outcome, audit } = await run({}, { body: 'Plain text with https://wikipedia.org/' });
    expect(outcome.signals).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('honours allowedHosts', async () => {
    const { outcome } = await run({ policy: { allowedHosts: ['files.evil.example'] } }, zip);
    expect(outcome.signals).toEqual([]);
  });

  it('can be switched off', async () => {
    const { audit } = await run({ policy: { enabled: false } }, zip);
    expect(audit).not.toHaveBeenCalled();
  });

  it('alerts when first publishes cross the burst threshold — once, not on every publish', async () => {
    const policy = { burstThreshold: 5 };
    const crossing = await run({ policy, recentPublishes: 6 }, { body: 'x' }, { firstPublish: true });
    expect(crossing.outcome.signals).toEqual([{ kind: 'publish_burst', count: 6 }]);
    expect((await run({ policy, recentPublishes: 7 }, { body: 'x' }, { firstPublish: true })).outcome.signals).toEqual([]);
    expect((await run({ policy, recentPublishes: 11 }, { body: 'x' }, { firstPublish: true })).outcome.signals).toHaveLength(1);
  });

  it('never unpublishes for a burst alone', async () => {
    const { outcome } = await run({ policy: { burstThreshold: 1, action: 'unpublish' }, recentPublishes: 2 }, { body: 'x' }, { firstPublish: true });
    expect(outcome).toMatchObject({ unpublish: false, signals: [{ kind: 'publish_burst' }] });
  });

  it('demotes the agent role whose run published the flagged content', async () => {
    const { recordIncident } = await run({ agentName: 'newsroom-writer' }, zip, { actor: { type: 'agent', runId: 'run_9' } });
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ agentRole: 'newsroom-writer', capability: 'items:update', runId: 'run_9' }));
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ capability: 'items:create' }));
  });

  it('never throws: a failing database leaves the write alone', async () => {
    const { outcome, audit } = await run({ fail: true }, zip);
    expect(outcome).toEqual({ signals: [], unpublish: false });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('parseContentIntegrityPolicy', () => {
  it('defaults safely and ignores junk', () => {
    expect(parseContentIntegrityPolicy(undefined)).toEqual({ enabled: true, action: 'notify', allowedHosts: [], burstThreshold: 25, burstWindowMinutes: 10, firstPublishSignal: true, weeklyDigest: true });
    expect(parseContentIntegrityPolicy({ firstPublishSignal: false, weeklyDigest: false })).toMatchObject({ firstPublishSignal: false, weeklyDigest: false });
    expect(parseContentIntegrityPolicy({ action: 'delete', burstThreshold: -3, allowedHosts: ['a.com', 7] })).toMatchObject({ action: 'notify', burstThreshold: 25, allowedHosts: ['a.com'] });
  });
});
