import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from '../admin';
import type { AppEnv } from '../../env';

class EmptySelectBuilder {
  from() {
    return this;
  }

  innerJoin() {
    return this;
  }

  where() {
    return this;
  }

  limit() {
    return Promise.resolve([]);
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve([]).then(onfulfilled, onrejected);
  }
}

function appWithAuth(auth: Record<string, unknown>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    c.set('siteId', 'victim-site');
    c.set('runtime', { cache: undefined } as never);
    c.set('db', { select: () => new EmptySelectBuilder() } as never);
    await next();
  });
  app.route('/admin', adminRouter);
  return app;
}

describe('admin backup/restore authorization', () => {
  it('rejects authenticated non-admin principals before backup export', async () => {
    const app = appWithAuth({ userId: 'user_1', roles: ['member'], raw: {} });

    const res = await app.request('/admin/backup');
    const body = (await res.json()) as {
      errors: Array<{ code: string; message: string }>;
    };

    expect(res.status).toBe(403);
    expect(body.errors[0]).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Admin role required.',
    });
  });

  it('rejects admin-role principals without site-bound adminAccess', async () => {
    const app = appWithAuth({ userId: 'user_1', roles: ['admin'], raw: {} });

    const res = await app.request('/admin/backup');
    const body = (await res.json()) as {
      errors: Array<{ code: string; message: string }>;
    };

    expect(res.status).toBe(403);
    expect(body.errors[0]).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Admin access for the requested site is required.',
    });
  });
});
