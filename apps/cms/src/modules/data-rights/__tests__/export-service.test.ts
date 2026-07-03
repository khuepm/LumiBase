import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { DataExportService } from '../export-service';
import { dataExportRouter } from '../../../routes/data-export';

/**
 * Fake DB that returns queued result sets in call order. `export()` issues its
 * queries in a fixed sequence: profile, consents, activity, revisions,
 * notifications — so the queue mirrors that order.
 */
function makeFakeDb(queue: unknown[][]) {
  const q = [...queue];
  return {
    select() {
      const chain: any = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return Promise.resolve(q.shift() ?? []);
        },
      };
      return chain;
    },
    insert() {
      const chain: any = {
        values() {
          return chain;
        },
        onConflictDoNothing() {
          return Promise.resolve();
        },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve(undefined).then(res);
        },
      };
      return chain;
    },
  } as unknown as AppEnv['Variables']['db'];
}

const FIXED_NOW = new Date('2026-06-24T10:00:00.000Z');

function fullQueue() {
  return [
    [{ id: 'user_1', email: 'a@b.co', firstName: 'Ada', preferences: {} }], // profile
    [{ consentType: 'marketing', granted: true }], // consents
    [{ action: 'login', createdAt: FIXED_NOW }], // activity
    [{ id: 'rev1', itemId: 'i1' }], // revisions
    [{ subject: 'Welcome', status: 'read' }], // notifications
  ];
}

describe('DataExportService', () => {
  it('assembles the user\'s data and excludes secrets', async () => {
    const db = makeFakeDb(fullQueue());
    const result = await new DataExportService({ db, now: () => FIXED_NOW }).export({
      siteId: 'site_1',
      userId: 'user_1',
    });

    expect(result.exportedAt).toBe(FIXED_NOW.toISOString());
    expect(result.profile).toMatchObject({ id: 'user_1', email: 'a@b.co' });
    // Secrets are never selected into the profile.
    expect(result.profile).not.toHaveProperty('passwordHash');
    expect(result.profile).not.toHaveProperty('tfa');
    expect(result.consents).toHaveLength(1);
    expect(result.activity).toHaveLength(1);
    expect(result.revisionsAuthored).toHaveLength(1);
    expect(result.notifications).toHaveLength(1);
    expect(result.truncated.activity).toBe(false);
  });

  it('returns null profile when the user row is missing', async () => {
    const db = makeFakeDb([[], [], [], [], []]);
    const result = await new DataExportService({ db, now: () => FIXED_NOW }).export({
      siteId: 'site_1',
      userId: 'ghost',
    });
    expect(result.profile).toBeNull();
    expect(result.consents).toEqual([]);
  });
});

describe('GET /me/data-export', () => {
  function buildApp(auth: Record<string, unknown>, queue: unknown[][]) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', makeFakeDb(queue));
      c.set('auth', auth as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/me/data-export', dataExportRouter);
    return app;
  }

  it('rejects an API-key principal with 400', async () => {
    const res = await buildApp({ type: 'api_key', raw: {} }, fullQueue()).request('/me/data-export');
    expect(res.status).toBe(400);
  });

  it('returns the export for a user principal with a download header', async () => {
    const res = await buildApp({ userId: 'user_1', email: 'a@b.co', raw: {} }, fullQueue()).request(
      '/me/data-export',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('lumibase-data-export.json');
    const body = (await res.json()) as { data: { profile: { id: string } } };
    expect(body.data.profile.id).toBe('user_1');
  });
});
