import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import {
  auditRouter,
  encodeCursor,
  decodeCursor,
  parseAuditLogQuery,
  parseAuditExportFilter,
  queryAuditLog,
  countAuditRows,
  auditExportLines,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
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

// ═════════════════════════════════════════════════════════════════════════
// Export surface — GET /audit-log/export (task 12.2; Req 15.6; design §10.4)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Tests for the NDJSON export:
 *
 *   1. `parseAuditExportFilter` — reuses the query parser but drops the
 *      pagination knobs (limit/cursor), keeping event/email/from/to and
 *      the same VALIDATION_ERROR / INVALID_RANGE rules.
 *   2. `auditExportLines` — the keyset-batched async generator yields one
 *      NDJSON line per row across multiple batches, stops at end-of-data
 *      (a short batch), and stops at the row cap.
 *   3. `countAuditRows` — the pre-flight count probe.
 *   4. Route-level — non-admin → 403; over-cap → 413 EXPORT_TOO_LARGE;
 *      valid → 200 with NDJSON headers + body; reversed range → 400.
 *
 * **Validates: Requirements 15.6**
 */

// ── fake db: answers BOTH the count probe AND the batched selects ────────

/**
 * Build a fake `db` for the export route/generator. It branches on
 * whether `select()` was given a projection argument:
 *   - `select({ count })...from().where()` (count probe) — the terminal
 *     awaited node is `.where()`, which resolves to `[{ count }]`.
 *   - `select()...from().where().orderBy().limit()` (batch scan) — the
 *     terminal awaited node is `.limit()`, which pops the next configured
 *     batch (an empty array once batches are exhausted).
 */
function makeExportFakeDb(opts: {
  count: number;
  batches: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}): { db: AppEnv['Variables']['db']; batchCalls: () => number } {
  let batchIdx = 0;
  const db = {
    select(projection?: unknown) {
      const isCount = projection !== undefined;
      const chain: Record<string, unknown> = {
        from() {
          return chain;
        },
        where() {
          // Count probe: `.where()` is the awaited terminal.
          if (isCount) return Promise.resolve([{ count: opts.count }]);
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          const batch = opts.batches[batchIdx] ?? [];
          batchIdx += 1;
          return Promise.resolve([...batch]);
        },
      };
      return chain;
    },
  };
  return {
    db: db as unknown as AppEnv['Variables']['db'],
    batchCalls: () => batchIdx,
  };
}

/** Build `n` rows with unique ids + strictly-decreasing timestamps. */
function makeRows(n: number, startIdx: number, baseMs: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const k = startIdx + i;
    out.push(makeRow({ id: `row_${k}`, timestamp: new Date(baseMs - k * 1000) }));
  }
  return out;
}

/** Collect every line yielded by the export generator. */
async function collect(gen: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of gen) lines.push(line);
  return lines;
}

// ── parseAuditExportFilter ───────────────────────────────────────────────

describe('parseAuditExportFilter', () => {
  it('keeps event/email/from/to and ignores limit/cursor', () => {
    const result = parseAuditExportFilter({
      event: AUDIT_EVENTS[0],
      email: '  Boot@Example.COM  ',
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-03-01T00:00:00.000Z',
      // pagination knobs that an export must ignore:
      limit: '5',
      cursor: encodeCursor(new Date('2024-02-01T00:00:00.000Z'), 'x'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filter.event).toBe(AUDIT_EVENTS[0]);
      expect(result.filter.email).toBe('boot@example.com');
      expect(result.filter.from!.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(result.filter.to!.toISOString()).toBe('2024-03-01T00:00:00.000Z');
      // No limit/cursor on an export filter.
      expect((result.filter as Record<string, unknown>).limit).toBeUndefined();
      expect((result.filter as Record<string, unknown>).cursor).toBeUndefined();
    }
  });

  it('rejects an unknown event → VALIDATION_ERROR', () => {
    const result = parseAuditExportFilter({ event: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a reversed / oversized range → INVALID_RANGE', () => {
    const reversed = parseAuditExportFilter({
      from: '2024-06-15T00:00:00.000Z',
      to: '2024-06-01T00:00:00.000Z',
    });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.code).toBe('INVALID_RANGE');

    const from = new Date('2023-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    const oversized = parseAuditExportFilter({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe('INVALID_RANGE');
  });
});

// ── countAuditRows ─────────────────────────────────────────────────────────

describe('countAuditRows', () => {
  it('returns the count from the probe', async () => {
    const { db } = makeExportFakeDb({ count: 42, batches: [] });
    expect(await countAuditRows(db, {})).toBe(42);
  });

  it('falls back to 0 on an empty result set', async () => {
    // count: any — the empty-batches probe still returns [{count}]; verify
    // the `?? 0` guard via a probe that resolves to [] instead.
    const db = {
      select() {
        const chain: Record<string, unknown> = {
          from() {
            return chain;
          },
          where() {
            return Promise.resolve([]);
          },
        };
        return chain;
      },
    } as unknown as AppEnv['Variables']['db'];
    expect(await countAuditRows(db, {})).toBe(0);
  });
});

// ── auditExportLines: batched generator ──────────────────────────────────

describe('auditExportLines', () => {
  it('yields one NDJSON line per row across multiple batches (500 + 500 + 30 → 1030)', async () => {
    const base = 2_000_000_000_000;
    const batches = [
      makeRows(EXPORT_BATCH_SIZE, 0, base),
      makeRows(EXPORT_BATCH_SIZE, EXPORT_BATCH_SIZE, base),
      makeRows(30, EXPORT_BATCH_SIZE * 2, base),
    ];
    const { db, batchCalls } = makeExportFakeDb({ count: 1030, batches });

    const lines = await collect(auditExportLines(db, {}));

    expect(lines).toHaveLength(1030);
    // A short final batch (30 < 500) ends the scan — exactly 3 batch reads.
    expect(batchCalls()).toBe(3);
    // Every line is valid JSON ending in a newline, carrying an id.
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      const obj = JSON.parse(line) as { id?: unknown };
      expect(typeof obj.id).toBe('string');
    }
    // Joining the lines yields a well-formed NDJSON document.
    const ndjson = lines.join('');
    const parsed = ndjson
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1030);
  });

  it('stops at end-of-data when the first batch is short', async () => {
    const batches = [makeRows(3, 0, 2_000_000_000_000)];
    const { db, batchCalls } = makeExportFakeDb({ count: 3, batches });
    const lines = await collect(auditExportLines(db, {}));
    expect(lines).toHaveLength(3);
    // Short first batch (3 < 500) → a single batch read, no second probe.
    expect(batchCalls()).toBe(1);
  });

  it('stops at the row cap when batches never run short (custom small cap)', async () => {
    // A fake that ALWAYS returns full `batchSize` batches — only the cap
    // can stop it. Use a tiny batch/cap for a fast, deterministic check.
    let n = 0;
    const db = {
      select() {
        const chain: Record<string, unknown> = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          orderBy() {
            return chain;
          },
          limit(size: number) {
            const batch: Record<string, unknown>[] = [];
            for (let i = 0; i < size; i++) {
              n += 1;
              batch.push(makeRow({ id: `row_${n}`, timestamp: new Date(9_000_000_000_000 - n) }));
            }
            return Promise.resolve(batch);
          },
        };
        return chain;
      },
    } as unknown as AppEnv['Variables']['db'];

    const lines = await collect(auditExportLines(db, {}, { batchSize: 10, cap: 25 }));
    expect(lines).toHaveLength(25);
  });

  it('stops at the default EXPORT_MAX_ROWS cap when batches never run short', async () => {
    // Faithful to the task: a db that always returns full 500-row batches
    // stops at EXPORT_MAX_ROWS. Count lines without buffering them all.
    let n = 0;
    const db = {
      select() {
        const chain: Record<string, unknown> = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          orderBy() {
            return chain;
          },
          limit(size: number) {
            const batch: Record<string, unknown>[] = [];
            for (let i = 0; i < size; i++) {
              n += 1;
              batch.push(makeRow({ id: `row_${n}`, timestamp: new Date(9_000_000_000_000 - n) }));
            }
            return Promise.resolve(batch);
          },
        };
        return chain;
      },
    } as unknown as AppEnv['Variables']['db'];

    let count = 0;
    for await (const _line of auditExportLines(db, {})) count += 1;
    expect(count).toBe(EXPORT_MAX_ROWS);
  });
});

// ── route harness for the export surface ─────────────────────────────────

function buildExportApp(
  opts: {
    count: number;
    batches: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
  },
  roles: Roles,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = makeExportFakeDb(opts);
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', { roles, raw: {} } as never);
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/admin/security', auditRouter);
  return app;
}

describe('GET /audit-log/export — route', () => {
  it('returns 403 FORBIDDEN for a non-admin principal', async () => {
    const app = buildExportApp({ count: 0, batches: [] }, ['member']);
    const res = await get(app, '/admin/security/audit-log/export');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });

  it('returns 413 EXPORT_TOO_LARGE when the pre-flight count exceeds the cap', async () => {
    const app = buildExportApp(
      { count: EXPORT_MAX_ROWS + 1, batches: [] },
      ['admin'],
    );
    const res = await get(app, '/admin/security/audit-log/export');
    expect(res.status).toBe(413);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('EXPORT_TOO_LARGE');
  });

  it('returns 200 with NDJSON headers + body for a valid export', async () => {
    const rows = makeRows(3, 0, 2_000_000_000_000);
    const app = buildExportApp({ count: 3, batches: [rows] }, ['admin']);
    const res = await get(app, '/admin/security/audit-log/export');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/x-ndjson; charset=utf-8',
    );
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="audit-log-export.ndjson"',
    );

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const obj = JSON.parse(line) as { id?: unknown };
      expect(typeof obj.id).toBe('string');
    }
  });

  it('maps an unknown event filter to 400 VALIDATION_ERROR', async () => {
    const app = buildExportApp({ count: 0, batches: [] }, ['admin']);
    const res = await get(app, '/admin/security/audit-log/export?event=not_real');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('VALIDATION_ERROR');
  });

  it('maps a reversed date range to 400 INVALID_RANGE', async () => {
    const app = buildExportApp({ count: 0, batches: [] }, ['admin']);
    const res = await get(
      app,
      '/admin/security/audit-log/export?from=2024-06-15T00:00:00.000Z&to=2024-06-01T00:00:00.000Z',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('INVALID_RANGE');
  });
});
