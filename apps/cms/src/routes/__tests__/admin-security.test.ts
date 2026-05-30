import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { adminSecurityRouter } from '../admin-security';

/**
 * Unit tests for `/api/v1/admin/security/{unlock-user,unblock-ip}`
 * (admin-setup-wizard task 6.4; Req 7.6, 7.7, 8.7, 8.8, 8.9; design
 * §4.5, §4.6).
 *
 * The router relies on `withAuth` having already populated
 * `c.get('auth').roles`; we stand in for it by injecting the principal
 * directly. The DB is faked with a tiny fluent shim that captures the
 * mutations the route would have performed so we can assert on shape
 * without spinning up Postgres. The shim mirrors the one used by
 * `routes/__tests__/me-admin-path.test.ts` and the LoginGuard hook
 * tests so the patterns stay consistent across the codebase.
 */

interface CapturedSelectCall {
  table: unknown;
  predicateText: string;
}
interface CapturedUpdateCall {
  table: unknown;
  set: Record<string, unknown>;
  predicateText: string;
}
interface CapturedDeleteCall {
  table: unknown;
  predicateText: string;
}

interface FakeDb {
  db: Database;
  state: {
    /** Lookup result for the next `select(...).where(...).limit(1)` call. */
    selectRow: { id: string; email: string } | null;
    selectCalls: CapturedSelectCall[];
    updateCalls: CapturedUpdateCall[];
    deleteCalls: CapturedDeleteCall[];
  };
}

function predicateToString(predicate: unknown): string {
  // Drizzle's where(sql`...`) emits `SQL` chunks; surface the literal
  // segments so we can assert on the predicate shape coarsely.
  const sqlChunk = predicate as { queryChunks?: unknown[] };
  if (sqlChunk && Array.isArray(sqlChunk.queryChunks)) {
    let out = '';
    for (const chunk of sqlChunk.queryChunks) {
      if (typeof chunk === 'string') {
        out += chunk;
      } else if (
        typeof chunk === 'object' &&
        chunk !== null &&
        'value' in (chunk as Record<string, unknown>) &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        out += ((chunk as { value: string[] }).value.join('') ?? '');
      }
    }
    return out;
  }
  try {
    return JSON.stringify(predicate);
  } catch {
    return String(predicate);
  }
}

function makeFakeDb(initial: { selectRow?: { id: string; email: string } | null }): FakeDb {
  const state: FakeDb['state'] = {
    selectRow: initial.selectRow ?? null,
    selectCalls: [],
    updateCalls: [],
    deleteCalls: [],
  };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: unknown) => ({
          limit: async () => {
            state.selectCalls.push({
              table,
              predicateText: predicateToString(predicate),
            });
            return state.selectRow ? [state.selectRow] : [];
          },
        }),
      }),
    }),
    update: (table: unknown) => {
      let captured: Record<string, unknown> = {};
      return {
        set(values: Record<string, unknown>) {
          captured = values;
          return this;
        },
        async where(predicate: unknown) {
          state.updateCalls.push({
            table,
            set: captured,
            predicateText: predicateToString(predicate),
          });
        },
      };
    },
    delete: (table: unknown) => ({
      async where(predicate: unknown) {
        state.deleteCalls.push({
          table,
          predicateText: predicateToString(predicate),
        });
      },
    }),
    // `loadLockoutPolicyFromSettings` calls `db.execute(...)` to read
    // the policy row; return an empty result so the loader falls back
    // to the Standard preset (which is what tests want).
    execute: async () => [],
  } as unknown as Database;

  return { db, state };
}

function buildApp(
  db: Database,
  options: { auth: AuthPrincipal },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', options.auth);
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/admin/security', adminSecurityRouter);
  return app;
}

const adminPrincipal: AuthPrincipal = {
  userId: 'usr_admin',
  email: 'admin@example.com',
  roles: ['admin'],
  raw: {},
};

const memberPrincipal: AuthPrincipal = {
  userId: 'usr_member',
  email: 'member@example.com',
  roles: ['member'],
  raw: {},
};

// ── unlock-user ────────────────────────────────────────────────────────

describe('POST /admin/security/unlock-user — Req 7.6, design §4.5', () => {
  it('returns 200 { unlocked: true } and resets lockedUntil for the email', async () => {
    const { db, state } = makeFakeDb({
      selectRow: { id: 'usr_locked', email: 'Locked@Example.com' },
    });
    const app = buildApp(db, { auth: adminPrincipal });

    const res = await app.request('/admin/security/unlock-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'locked@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { unlocked: true } });

    // The user lookup should be case-insensitive — the predicate
    // contains `lower(...)`.
    expect(state.selectCalls).toHaveLength(1);
    expect(state.selectCalls[0]?.predicateText).toContain('lower(');

    // Updated `users` row clears the lockout columns.
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]?.set).toMatchObject({
      failedCount: 0,
      lockedUntil: null,
      failedCountWindowStart: null,
    });

    // Drained the email's recent fail rows from `login_attempts`.
    expect(state.deleteCalls).toHaveLength(1);
  });

  it('returns 404 USER_NOT_FOUND when no user matches the email', async () => {
    const { db, state } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: adminPrincipal });

    const res = await app.request('/admin/security/unlock-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@example.com' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('USER_NOT_FOUND');

    // No mutations should have happened.
    expect(state.updateCalls).toHaveLength(0);
    expect(state.deleteCalls).toHaveLength(0);
  });

  it('returns 403 FORBIDDEN when the caller does not have the admin role', async () => {
    const { db, state } = makeFakeDb({
      selectRow: { id: 'usr_locked', email: 'admin@example.com' },
    });
    const app = buildApp(db, { auth: memberPrincipal });

    const res = await app.request('/admin/security/unlock-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('FORBIDDEN');

    // Should short-circuit before touching the DB.
    expect(state.selectCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
    expect(state.deleteCalls).toHaveLength(0);
  });

  it('returns 400 VALIDATION_ERROR for malformed email', async () => {
    const { db } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: adminPrincipal });

    const res = await app.request('/admin/security/unlock-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('VALIDATION_ERROR');
  });
});

// ── unblock-ip ─────────────────────────────────────────────────────────

describe('POST /admin/security/unblock-ip — Req 7.7, 8.7, design §4.6', () => {
  it('returns 200 { unblocked: true } and drains login_attempts for valid IPv4', async () => {
    const { db, state } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: adminPrincipal });

    const res = await app.request('/admin/security/unblock-ip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ip: '203.0.113.42' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { unblocked: true } });
    expect(state.deleteCalls).toHaveLength(1);
  });

  it('accepts compressed IPv6 (e.g. ::1) and canonicalises loopback variants', async () => {
    const { db, state } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: adminPrincipal });

    // `::ffff:127.0.0.1` is the IPv4-mapped form of loopback; the
    // route should canonicalise it back to `127.0.0.1` before
    // touching the DB so it matches the form `extractClientIp`
    // writes into `login_attempts.ip`.
    const res = await app.request('/admin/security/unblock-ip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ip: '::ffff:127.0.0.1' }),
    });

    expect(res.status).toBe(200);
    expect(state.deleteCalls).toHaveLength(1);
  });

  it('returns 400 INVALID_IP for malformed IP strings', async () => {
    const { db, state } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: adminPrincipal });

    for (const bad of ['', 'not-an-ip', '999.999.999.999', '::g', '12.34']) {
      const res = await app.request('/admin/security/unblock-ip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: bad }),
      });
      // Empty string fails Zod min(1) -> VALIDATION_ERROR; all others
      // get through the schema and hit `parseIpToBytes` returning null.
      const body = (await res.json()) as { errors: { code: string }[] };
      if (bad === '') {
        expect(res.status).toBe(400);
        expect(body.errors[0]?.code).toBe('VALIDATION_ERROR');
      } else {
        expect(res.status).toBe(400);
        expect(body.errors[0]?.code).toBe('INVALID_IP');
      }
    }

    expect(state.deleteCalls).toHaveLength(0);
  });

  it('returns 403 FORBIDDEN when caller is not an admin', async () => {
    const { db, state } = makeFakeDb({ selectRow: null });
    const app = buildApp(db, { auth: memberPrincipal });

    const res = await app.request('/admin/security/unblock-ip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ip: '203.0.113.42' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]?.code).toBe('FORBIDDEN');
    expect(state.deleteCalls).toHaveLength(0);
  });
});
