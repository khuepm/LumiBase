import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  auditLog,
  createDb,
  loginAttempts,
  sites,
  type Database,
} from '@lumibase/database';

import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import {
  auditRouter,
  queryAuditLog,
  countAuditRows,
  auditExportLines,
} from '../modules/audit/routes';
import { AuditRotator } from '../modules/audit/rotator';

/**
 * Integration tests for the audit-log subsystem
 * (admin-setup-wizard task 12.5; Req 15.1, 15.4, 15.5, 15.6; design
 * §13.2, Property 10).
 *
 * Three end-to-end scenarios, exercising the REAL modules against a
 * REAL Postgres so the write-path masking, the cursor-paginated query
 * surface, the retention rotation, and the keyset-batched NDJSON export
 * all run together rather than against fakes:
 *
 *   1. **Write → query round-trip (Req 15.1, 15.4)** — the production
 *      `AuditLogger.write` inserts a masked row; the production
 *      `auditRouter` `GET /audit-log` then returns it. The crucial
 *      assertion is that the `setupToken` carried in `metadata` survived
 *      the round-trip MASKED (its 8-hex-char SHA-256 prefix, NOT the raw
 *      secret — Req 15.3), while a non-secret sibling key is preserved
 *      verbatim. The `admin`-role gate is asserted too (member → 403).
 *
 *   2. **Retention rotation (Req 15.5, Property 10)** — old + recent rows
 *      are seeded into BOTH `audit_log` and `login_attempts` with
 *      explicit past timestamps; `AuditRotator.rotate()` with a 90-day
 *      horizon deletes exactly the rows strictly older than the cutoff
 *      and leaves the newer ones untouched. A boundary pair (89 days
 *      inside vs 91 days outside the window) pins Property 10's
 *      invariant.
 *
 *   3. **Export streaming (Req 15.6)** — ~1000 rows are inserted, then
 *      the production export (`GET /audit-log/export`) streams them as
 *      NDJSON. 1000 rows span MULTIPLE 500-row keyset batches, so the key
 *      correctness check is that ALL 1000 distinct ids appear exactly
 *      once (no dupes, no gaps from the keyset pagination). The NDJSON
 *      headers and the `countAuditRows` pre-flight probe are asserted
 *      too.
 *
 * Uses the project's shared `DATABASE_URL` env var pattern: when the
 * variable is unset or the database isn't reachable the suite skips with
 * a warning so local-only `pnpm test` doesn't break.
 *
 * **Validates: Requirements 15.1, 15.4, 15.5, 15.6**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

/** One day in milliseconds — the unit the retention test reasons in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Build a `Date` `n` days before now (used to age seeded rows). */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

// ── independent sha256 prefix (test oracle, mirrors logger.test.ts) ──────

const enc = new TextEncoder();

/**
 * The first 8 lowercase hex chars of `sha256(input)`, computed
 * independently of the production masker so the round-trip assertion has
 * a real oracle (not just a shape check) for Req 15.3.
 */
async function sha256Prefix8(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex.slice(0, 8);
}

describe('Audit log — integration', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      canConnect = false;
    }
  });

  beforeEach(async () => {
    if (!canConnect) return;
    // Reset every relevant table so each test starts on a clean slate.
    // CASCADE handles incidental FK references (login_attempts → users,
    // settings → sites, user_sites → users).
    await db.execute(
      sql`TRUNCATE TABLE lumibase_audit_log, lumibase_login_attempts, lumibase_system_state, lumibase_settings, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
    await db.insert(sites).values({ id: 'site_test', name: 'Test site' });
  });

  /**
   * Build a Hono app mounting the REAL `auditRouter` at
   * `/admin/security` (mirroring the unit-test harness in
   * `modules/audit/__tests__/routes.test.ts`). A leading middleware pins
   * the test `db`, an `auth` principal carrying `roles`, and a
   * `requestId` on the context. The router reads `c.get('db')` and
   * `c.get('auth').roles` directly and never calls `withDb()`, so no env
   * bindings are required.
   */
  function buildApp(roles: string[]): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', { roles, raw: {} });
      c.set('siteId', 'site_test');
      c.set('requestId', `req_test_${Math.random().toString(36).slice(2)}`);
      await next();
    });
    app.route('/admin/security', auditRouter);
    return app;
  }

  function get(app: Hono<AppEnv>, path: string): Promise<Response> {
    return Promise.resolve(app.request(path, { method: 'GET' }));
  }

  // ── 1. Write event → query returns the (masked) entry ───────────────

  it('writes a masked audit entry and returns it through the query route, with secrets masked and the admin gate enforced (Req 15.1, 15.4)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const RAW_SECRET = 'raw-secret';

    // Write through the production logger — masks `setupToken` before
    // the INSERT (Req 15.3) and leaves the non-secret `adminPathHash`
    // untouched (Req 15.2).
    await new AuditLogger({ db, siteId: 'site_test' }).write({
      event: 'setup_completed',
      actorEmail: 'admin@example.com',
      ip: '203.0.113.7',
      metadata: { setupToken: RAW_SECRET, adminPathHash: 'abc12345' },
    });

    // Drive the read through the REAL router as an admin.
    const adminApp = buildApp(['admin']);
    const res = await get(
      adminApp,
      '/admin/security/audit-log?event=setup_completed',
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        items: Array<{
          event: string;
          actorEmail: string | null;
          ip: string | null;
          metadata: Record<string, unknown>;
        }>;
        nextCursor: string | null;
      };
    };

    // Exactly the one written entry comes back, matching event + actor.
    expect(body.data.items).toHaveLength(1);
    const entry = body.data.items[0]!;
    expect(entry.event).toBe('setup_completed');
    expect(entry.actorEmail).toBe('admin@example.com');
    expect(entry.ip).toBe('203.0.113.7');

    // CRUCIAL (Req 15.3): the setupToken survived the round-trip MASKED —
    // it is the 8-hex-char SHA-256 prefix, never the raw secret.
    const expectedMask = await sha256Prefix8(RAW_SECRET);
    expect(entry.metadata.setupToken).toBe(expectedMask);
    expect(entry.metadata.setupToken).not.toBe(RAW_SECRET);
    expect(entry.metadata.setupToken).toMatch(/^[0-9a-f]{8}$/);
    // The non-secret sibling key is preserved verbatim.
    expect(entry.metadata.adminPathHash).toBe('abc12345');

    // The same masking holds when reading via the pure query helper
    // directly (detailed metadata check, no HTTP layer in between).
    const page = await queryAuditLog(db, {
      siteId: 'site_test',
      event: 'setup_completed',
      limit: 50,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.metadata?.setupToken).toBe(expectedMask);
    expect(page.items[0]!.metadata?.adminPathHash).toBe('abc12345');

    // Admin gate (Req 15.4): a non-admin principal is rejected with 403
    // before any rows are read.
    const memberApp = buildApp(['member']);
    const forbidden = await get(
      memberApp,
      '/admin/security/audit-log?event=setup_completed',
    );
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as {
      errors: Array<{ code: string }>;
    };
    expect(forbiddenBody.errors[0]!.code).toBe('FORBIDDEN');
  }, 30000);

  // ── 2. Retention rotation deletes old rows, keeps recent ones ───────

  it('rotates rows strictly older than the retention cutoff in both audit_log and login_attempts, never touching newer rows (Req 15.5, Property 10)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    // Seed audit_log: two OLD rows (200 days, and 91 days = just OUTSIDE
    // the 90-day window) and two RECENT rows (now, and 89 days = just
    // INSIDE the window). `timestamp` defaults to now(), so the old/inside
    // rows pass an explicit past `timestamp`.
    await db.insert(auditLog).values([
      { event: 'login_failed', actorEmail: 'old200@example.com', timestamp: daysAgo(200) },
      { event: 'login_failed', actorEmail: 'old91@example.com', timestamp: daysAgo(91) },
      { event: 'login_failed', actorEmail: 'recent-now@example.com', timestamp: new Date() },
      { event: 'login_failed', actorEmail: 'recent89@example.com', timestamp: daysAgo(89) },
    ]);

    // Seed login_attempts: one OLD (200 days) + one RECENT (1 day).
    // `created_at` defaults to now(), so the old row passes an explicit
    // past `createdAt`. `emailLower`, `ip`, `result` are NOT NULL.
    await db.insert(loginAttempts).values([
      {
        emailLower: 'old-login@example.com',
        ip: '203.0.113.7',
        result: 'fail',
        createdAt: daysAgo(200),
      },
      {
        emailLower: 'recent-login@example.com',
        ip: '203.0.113.8',
        result: 'fail',
        createdAt: daysAgo(1),
      },
    ]);

    // Rotate at the 90-day horizon. Strictly-older-than-cutoff rows go;
    // newer rows stay. Old audit (200d, 91d) + old login (200d) = 3 rows.
    const result = await new AuditRotator({ db, retentionDays: 90 }).rotate();
    expect(result.deleted).toBe(3);

    // ── audit_log: the two OLD rows are GONE … ─────────────────────────
    const countAuditBy = async (actorEmail: string): Promise<number> => {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(eq(auditLog.actorEmail, actorEmail));
      return rows[0]?.count ?? 0;
    };
    expect(await countAuditBy('old200@example.com')).toBe(0);
    // Property 10 boundary: a row just OUTSIDE the window (91d) is deleted.
    expect(await countAuditBy('old91@example.com')).toBe(0);

    // … and the two RECENT rows REMAIN.
    expect(await countAuditBy('recent-now@example.com')).toBe(1);
    // Property 10 boundary: a row just INSIDE the window (89d) is kept.
    expect(await countAuditBy('recent89@example.com')).toBe(1);

    // Exactly the two recent audit rows survive in total.
    const remainingAudit = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog);
    expect(remainingAudit[0]?.count).toBe(2);

    // ── login_attempts: the OLD row is GONE, the RECENT one REMAINS ────
    const countLoginBy = async (emailLower: string): Promise<number> => {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(loginAttempts)
        .where(eq(loginAttempts.emailLower, emailLower));
      return rows[0]?.count ?? 0;
    };
    expect(await countLoginBy('old-login@example.com')).toBe(0);
    expect(await countLoginBy('recent-login@example.com')).toBe(1);

    const remainingLogins = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts);
    expect(remainingLogins[0]?.count).toBe(1);
  }, 30000);

  // ── 3. Export streaming with ~1000 rows ─────────────────────────────

  it('streams ~1000 audit rows as NDJSON across multiple keyset batches with every id present exactly once (Req 15.6)', async () => {
    if (!canConnect) {
      console.warn('Skipping: DATABASE_URL not set or database not reachable');
      return;
    }

    const TOTAL = 1000;
    // Strictly-decreasing, distinct timestamps so the keyset ordering
    // (`timestamp DESC, id DESC`) is deterministic. A fixed base keeps the
    // run reproducible. ids are assigned by the table's nanoid default.
    const base = new Date('2024-06-15T12:00:00.000Z').getTime();
    const rows = Array.from({ length: TOTAL }, (_v, i) => ({
      siteId: 'site_test',
      event: 'login_success' as const,
      actorEmail: `user${i}@example.com`,
      timestamp: new Date(base - i * 1000),
    }));

    // Insert in chunks of 250 to stay comfortably under any driver
    // bind-param ceiling.
    const CHUNK = 250;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(auditLog).values(rows.slice(i, i + CHUNK));
    }

    // Pre-flight probe (the route's 413 gate input) sees all 1000 rows.
    expect(await countAuditRows(db, { siteId: 'site_test' })).toBe(TOTAL);

    // Drive the REAL export route as an admin and read the streamed body.
    const adminApp = buildApp(['admin']);
    const res = await get(adminApp, '/admin/security/audit-log/export');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/x-ndjson; charset=utf-8',
    );
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="audit-log-export.ndjson"',
    );

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(TOTAL);

    // Every line is valid JSON carrying a string id; collect the ids.
    const ids = new Set<string>();
    for (const line of lines) {
      const obj = JSON.parse(line) as { id?: unknown; event?: unknown };
      expect(typeof obj.id).toBe('string');
      expect(obj.event).toBe('login_success');
      ids.add(obj.id as string);
    }

    // The KEY correctness check for the batched keyset streaming: 1000
    // rows span MULTIPLE 500-row batches, and every id appears EXACTLY
    // once — no duplicates, no gaps from the keyset pagination seek.
    expect(ids.size).toBe(TOTAL);

    // The generator-level surface yields the same 1000 distinct ids
    // (verifies the batched scan independently of the HTTP layer).
    const genIds = new Set<string>();
    for await (const line of auditExportLines(db, { siteId: 'site_test' })) {
      const obj = JSON.parse(line) as { id: string };
      genIds.add(obj.id);
    }
    expect(genIds.size).toBe(TOTAL);
  }, 30000);
});
