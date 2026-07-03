import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { authRouter } from '../auth';

vi.mock('../../services/auth/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('pbkdf2$mock'),
  verifyPassword: vi.fn().mockResolvedValue(false),
}));

interface FakeDb {
  db: AppEnv['Variables']['db'];
  inserts: Array<Record<string, unknown>>;
}

/**
 * Minimal fluent Drizzle stand-in: each `select()` resolves the next entry of
 * `selectResults` in call order; `insert().values()` records the row and
 * supports both `.returning()` and `.onConflictDoNothing()`.
 */
function makeFakeDb(selectResults: unknown[][], returningRows: unknown[][]): FakeDb {
  let selectCount = 0;
  let insertCount = 0;
  const inserts: Array<Record<string, unknown>> = [];
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(selectResults[selectCount++] ?? []),
  };
  const db = {
    select: () => fluent,
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserts.push(row);
        const result = returningRows[insertCount++] ?? [];
        return {
          returning: () => Promise.resolve(result),
          onConflictDoNothing: () =>
            Object.assign(Promise.resolve(result), { returning: () => Promise.resolve(result) }),
        };
      },
    }),
  } as unknown as AppEnv['Variables']['db'];
  return { db, inserts };
}

function buildApp(auth: AuthPrincipal | undefined, db: AppEnv['Variables']['db']): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    c.set('siteId', 'site-a');
    c.set('db', db);
    await next();
  });
  app.route('/auth', authRouter);
  return app;
}

const adminPrincipal: AuthPrincipal = {
  userId: 'usr_admin',
  email: 'admin@example.com',
  roles: ['admin'],
  raw: {},
};

function registerRequest(app: Hono<AppEnv>) {
  return app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new@example.com', password: 'secret123' }),
  });
}

describe('POST /auth/register', () => {
  it('fails closed (403, not 500) when no principal is present', async () => {
    const { db } = makeFakeDb([], []);
    const res = await registerRequest(buildApp(undefined, db));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Only administrators can register users for a site.' }],
    });
  });

  it('rejects non-admin principals', async () => {
    const { db } = makeFakeDb([], []);
    const res = await registerRequest(
      buildApp({ userId: 'usr_m', email: 'm@example.com', roles: ['member'], raw: {} }, db),
    );

    expect(res.status).toBe(403);
  });

  it('binds the new user with the site\'s seeded member role id, not a literal key', async () => {
    const { db, inserts } = makeFakeDb(
      [
        [], // no existing user with this email
        [{ id: 'role_member_nanoid' }], // seeded member role lookup
      ],
      [
        [{ id: 'usr_new', email: 'new@example.com', firstName: null, lastName: null }], // users insert
        [], // user_sites insert
      ],
    );
    const res = await registerRequest(buildApp(adminPrincipal, db));

    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).toMatchObject({
      userId: 'usr_new',
      siteId: 'site-a',
      roleId: 'role_member_nanoid',
    });
  });

  it('returns 500 ROLE_NOT_FOUND before creating the user when the member role is missing', async () => {
    const { db, inserts } = makeFakeDb(
      [
        [], // no existing user
        [], // member role missing
      ],
      [],
    );
    const res = await registerRequest(buildApp(adminPrincipal, db));

    expect(res.status).toBe(500);
    const body = await res.json() as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('ROLE_NOT_FOUND');
    expect(inserts).toHaveLength(0);
  });
});
