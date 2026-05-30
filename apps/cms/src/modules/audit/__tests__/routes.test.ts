import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import {
  auditRouter,
  encodeCursor,
  decodeCursor,
  parseAuditLogQuery,
  queryAuditLog,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
} from '../routes';
import { AUDIT_EVENTS } from '../logger';

/**
 * Tests for the audit-log QUERY surface
 * (admin-setup-wizard task 12.1; design §4.9, §10.3).
 *
 *   GET /audit-log ?event=&email=&from=&to=&cursor=&limit=
 *
 * Two layers:
 *
 *   1. Pure helpers — `encodeCursor`/`decodeCursor` round-trip + malformed
 *      handling, and the full `parseAuditLogQuery` validation matrix
 *      (default limit, out-of-range limit, unknown event, reversed range,
 *      >366-day range, valid window, email lower-casing, malformed
 *      cursor). These need no Postgres and no Hono.
 *
 *   2. Route-level — a tiny Hono app mounts `auditRouter` behind a test
 *      middleware that injects a fake `db` and an `auth` principal so we
 *      can assert: non-admin → 403; admin happy-path → 200 `{ data: {
 *      items, nextCursor } }` (nextCursor null when fewer than limit+1
 *      rows; a base64 cursor when exactly limit+1); and the 400 mapping
 *      for validation / range errors. The fake db's
 *      `select().from().where().orderBy().limit()` chain returns a
 *      configurable row array (mirrors the fake-db chain pattern used in
 *      the recovery + login-guard suites).
 *
 * **Validates: Requirements 15.4**
 */

// ── pure helpers: cursor codec ───────────────────────────────────────────

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a (timestamp, id) tuple losslessly', () => {
    const ts = new Date('2024-06-15T12:34:56.789Z');
    const id = 'abc123_DEF-456';
    const cursor = encodeCursor(ts, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(id);
    expect(decoded!.timestamp.toISOString()).toBe(ts.toISOString());
  });

  it('returns null for malformed input', () => {
    // not base64 of a `ts|id` payload
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    // base64 of a payload with no separator
    expect(decodeCursor(Buffer.from('no-separator', 'binary').toString('base64'))).toBeNull();
    // base64 of an empty id
    expect(
      decodeCursor(
        Buffer.from('2024-06-15T12:34:56.789Z|', 'binary').toString('base64'),
      ),
    ).toBeNull();
    // base64 of an unparseable timestamp
    expect(
      decodeCursor(Buffer.from('not-a-date|abc', 'binary').toString('base64')),
    ).toBeNull();
    // structurally-invalid base64 that throws on decode
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });
});

// ── pure helpers: parseAuditLogQuery ─────────────────────────────────────

describe('parseAuditLogQuery', () => {
  it('defaults limit to 50 when absent', () => {
    const result = parseAuditLogQuery({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.limit).toBe(DEFAULT_LIMIT);
      expect(result.filter.event).toBeUndefined();
      expect(result.filter.email).toBeUndefined();
      expect(result.filter.from).toBeUndefined();
      expect(result.filter.to).toBeUndefined();
      expect(result.filter.cursor).toBeUndefined();
    }
  });

  it('accepts a valid explicit limit within 1–100', () => {
    const result = parseAuditLogQuery({ limit: '25' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filter.limit).toBe(25);
  });

  it('rejects an out-of-range limit (0, 101) → VALIDATION_ERROR', () => {
    for (const bad of ['0', String(MAX_LIMIT + 1), '999']) {
      const result = parseAuditLogQuery({ limit: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a non-integer limit → VALIDATION_ERROR', () => {
    for (const bad of ['1.5', '50abc', '-5', 'abc']) {
      const result = parseAuditLogQuery({ limit: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts a known event and rejects an unknown one', () => {
    const known = parseAuditLogQuery({ event: AUDIT_EVENTS[0] });
    expect(known.ok).toBe(true);
    if (known.ok) expect(known.filter.event).toBe(AUDIT_EVENTS[0]);

    const unknown = parseAuditLogQuery({ event: 'not_a_real_event' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('VALIDATION_ERROR');
  });

  it('normalises the email filter to lowercase + trimmed', () => {
    const result = parseAuditLogQuery({ email: '  Boot@Example.COM  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filter.email).toBe('boot@example.com');
  });

  it('rejects an all-whitespace email → VALIDATION_ERROR', () => {
    const result = parseAuditLogQuery({ email: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unparseable from/to → VALIDATION_ERROR', () => {
    const bad = parseAuditLogQuery({ from: 'not-a-date' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a reversed range (from > to) → INVALID_RANGE', () => {
    const result = parseAuditLogQuery({
      from: '2024-06-15T00:00:00.000Z',
      to: '2024-06-01T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_RANGE');
  });

  it('rejects from == to (not strictly before) → INVALID_RANGE', () => {
    const result = parseAuditLogQuery({
      from: '2024-06-15T00:00:00.000Z',
      to: '2024-06-15T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_RANGE');
  });

  it('rejects a range wider than 366 days → INVALID_RANGE', () => {
    const from = new Date('2023-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    const result = parseAuditLogQuery({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_RANGE');
  });

  it('accepts a valid window (from < to, ≤366 days)', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-03-01T00:00:00.000Z');
    const result = parseAuditLogQuery({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.from!.toISOString()).toBe(from.toISOString());
      expect(result.filter.to!.toISOString()).toBe(to.toISOString());
    }
  });

  it('allows a single open-ended bound with no 366-day check', () => {
    const onlyFrom = parseAuditLogQuery({ from: '2020-01-01T00:00:00.000Z' });
    expect(onlyFrom.ok).toBe(true);
    const onlyTo = parseAuditLogQuery({ to: '2024-01-01T00:00:00.000Z' });
    expect(onlyTo.ok).toBe(true);
  });

  it('decodes a valid cursor and rejects a malformed one', () => {
    const cursor = encodeCursor(new Date('2024-06-15T12:00:00.000Z'), 'row_1');
    const ok = parseAuditLogQuery({ cursor });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.filter.cursor!.id).toBe('row_1');
    }

    const bad = parseAuditLogQuery({ cursor: '!!!not-base64!!!' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('VALIDATION_ERROR');
  });
});

// ── fake Drizzle client ──────────────────────────────────────────────────

/**
 * Build a fake `db` whose `select().from().where().orderBy().limit()`
 * chain resolves to `rows`. `queryAuditLog` awaits the result of
 * `.limit(...)`, so only the terminal `limit` needs to be thenable.
 * Captures the limit argument for the look-ahead assertion.
 */
function makeFakeDb(rows: ReadonlyArray<Record<string, unknown>>): {
  db: AppEnv['Variables']['db'];
  captured: { limit?: number };
} {
  const captured: { limit?: number } = {};
  const chain = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit(n: number) {
      captured.limit = n;
      return Promise.resolve([...rows]);
    },
  };
  const db = {
    select() {
      return chain;
    },
  };
  return { db: db as unknown as AppEnv['Variables']['db'], captured };
}

function makeRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row_1',
    timestamp: new Date('2024-06-15T12:00:00.000Z'),
    event: 'login_success',
    actorEmail: 'actor@example.com',
    targetEmail: null,
    ip: '203.0.113.7',
    userAgent: 'test-agent',
    countryCode: 'US',
    metadata: {},
    requestId: 'req_1',
    ...over,
  };
}

// ── queryAuditLog: look-ahead → nextCursor ───────────────────────────────

describe('queryAuditLog', () => {
  it('returns nextCursor null when fewer than limit+1 rows come back', async () => {
    const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];
    const { db, captured } = makeFakeDb(rows);

    const page = await queryAuditLog(db, { limit: 50 });

    // It fetches limit + 1 to detect a next page.
    expect(captured.limit).toBe(51);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('trims the look-ahead row and mints a base64 nextCursor when exactly limit+1 rows', async () => {
    // limit 2 → fetch 3; return 3 → there IS a next page.
    const rows = [
      makeRow({ id: 'a', timestamp: new Date('2024-06-15T12:00:02.000Z') }),
      makeRow({ id: 'b', timestamp: new Date('2024-06-15T12:00:01.000Z') }),
      makeRow({ id: 'c', timestamp: new Date('2024-06-15T12:00:00.000Z') }),
    ];
    const { db } = makeFakeDb(rows);

    const page = await queryAuditLog(db, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
    // The cursor encodes the LAST RETURNED row (b), not the dropped one (c).
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded!.id).toBe('b');
  });
});

// ── route harness ────────────────────────────────────────────────────────

type Roles = string[];

function buildApp(
  rows: ReadonlyArray<Record<string, unknown>>,
  roles: Roles,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = makeFakeDb(rows);
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', { roles, raw: {} } as never);
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/admin/security', auditRouter);
  return app;
}

function get(app: Hono<AppEnv>, path: string): Promise<Response> {
  return Promise.resolve(app.request(path, { method: 'GET' }));
}

describe('GET /audit-log — route', () => {
  it('returns 403 FORBIDDEN for a non-admin principal', async () => {
    const app = buildApp([makeRow()], ['member']);
    const res = await get(app, '/admin/security/audit-log');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });

  it('returns 200 { data: { items, nextCursor: null } } for an admin with no filters (fewer than limit+1 rows)', async () => {
    const app = buildApp([makeRow({ id: 'a' }), makeRow({ id: 'b' })], ['admin']);
    const res = await get(app, '/admin/security/audit-log');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: unknown[]; nextCursor: string | null };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();
  });

  it('returns a base64 nextCursor when exactly limit+1 rows come back', async () => {
    const rows = [
      makeRow({ id: 'a', timestamp: new Date('2024-06-15T12:00:02.000Z') }),
      makeRow({ id: 'b', timestamp: new Date('2024-06-15T12:00:01.000Z') }),
      makeRow({ id: 'c', timestamp: new Date('2024-06-15T12:00:00.000Z') }),
    ];
    const app = buildApp(rows, ['admin']);
    const res = await get(app, '/admin/security/audit-log?limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: unknown[]; nextCursor: string | null };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).not.toBeNull();
    expect(decodeCursor(body.data.nextCursor!)!.id).toBe('b');
  });

  it('maps an unknown event filter to 400 VALIDATION_ERROR', async () => {
    const app = buildApp([makeRow()], ['admin']);
    const res = await get(app, '/admin/security/audit-log?event=not_real');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('VALIDATION_ERROR');
  });

  it('maps a reversed date range to 400 INVALID_RANGE', async () => {
    const app = buildApp([makeRow()], ['admin']);
    const res = await get(
      app,
      '/admin/security/audit-log?from=2024-06-15T00:00:00.000Z&to=2024-06-01T00:00:00.000Z',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('INVALID_RANGE');
  });

  it('maps a malformed cursor to 400 VALIDATION_ERROR', async () => {
    const app = buildApp([makeRow()], ['admin']);
    const res = await get(app, '/admin/security/audit-log?cursor=!!!bad!!!');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('VALIDATION_ERROR');
  });
});
