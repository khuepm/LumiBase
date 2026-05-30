/**
 * Audit-log QUERY surface — authenticated, admin-only cursor-paginated
 * read API over the `audit_log` table (admin-setup-wizard task 12.1;
 * Req 15.4; design §4.9, §10.3).
 *
 *   GET /audit-log
 *     ?event=&email=&from=&to=&cursor=&limit=
 *     → 200 { data: { items: AuditLogEntry[], nextCursor: string|null } }
 *     → 400 VALIDATION_ERROR | 400 INVALID_RANGE | 403 FORBIDDEN
 *
 * This file owns ONLY the query route plus its pure, independently
 * unit-testable helpers ({@link encodeCursor}, {@link decodeCursor},
 * {@link parseAuditLogQuery}, {@link queryAuditLog}). The NDJSON export
 * route (`GET /audit-log/export`, task 12.2), the mount under the
 * authenticated `api` Hono at `/api/v1/admin/security` (task 12.3), and
 * the Studio "Security audit" tab (task 12.4) are DELIBERATELY out of
 * scope here.
 *
 * ── Authenticated surface (contrast with the recovery router) ────────────
 *
 * Unlike the PUBLIC recovery router (`modules/recovery/routes.ts`, task
 * 10.7) — which is reachable WITHOUT a session because the operator is
 * locked out — this router is the AUTHENTICATED audit surface. It is
 * mounted (task 12.3) UNDER the authenticated `api` Hono, so `withAuth`
 * (plus `withTenant` / `withDb` / `withRls`) runs UPSTREAM and a missing
 * principal is already a 401 before this router sees the request. The
 * router itself only enforces the `admin`-role gate, mirroring
 * {@link ../../routes/admin-security}'s `requireAdmin(c)` helper: it reads
 * `c.get('auth').roles`, and when `'admin'` is absent returns a flat
 * `403 { errors: [{ code: 'FORBIDDEN' }] }`. A 403 (not the 404 used by
 * `adminPathGuard` for path discovery) is intentional — the caller has
 * already proven they hold a session, so the failure is "authenticated
 * but not authorised", not "this route doesn't exist".
 *
 * ── Sort order + index alignment (design §10.3, P95 ≤ 2s) ─────────────────
 *
 * Results are ordered `timestamp DESC, id DESC` — most-recent-first,
 * the natural "recent activity" scan. `id` is the tiebreaker so the
 * sort is a TOTAL order even when two rows share a `timestamp` (the
 * column is millisecond-precision and a burst of events can collide);
 * a total order is what makes the cursor stable and gap-free.
 *
 * The ordering and the WHERE clause are aligned with the table's
 * indexes (`packages/database/src/schema/security.ts`):
 *   - no `event` filter → the `audit_log_ts_idx` on `(timestamp)`
 *     drives both the ORDER BY and the cursor range scan.
 *   - `event` filter present → the `audit_log_event_idx` on
 *     `(event, timestamp)` is the covering index for `event = $1`
 *     plus the timestamp ordering.
 * The P95 ≤ 2s budget (Req 15.4) is therefore met by index design, not
 * by a code-level timeout race — there is nothing to "enforce" in the
 * handler beyond keeping the query on indexed columns. (Contrast the
 * AuditLogger WRITE path, which DOES race a ≤1s budget because a single
 * synchronous insert can stall the request thread; a read has no such
 * obligation.)
 *
 * ── Cursor encoding (design §10.3) ───────────────────────────────────────
 *
 * A page cursor is `base64(`${timestamp_iso}|${id}`)` — the ISO-8601
 * timestamp of the LAST returned row joined to its `id` by a literal
 * `|`. Both parts are ASCII (an ISO date and a `nanoid`, whose alphabet
 * is `A-Za-z0-9_-`), so plain base64 round-trips losslessly. Decoding a
 * cursor yields the `(timestamp, id)` tuple that seeds the next page's
 * range predicate; a MALFORMED cursor (bad base64, missing `|`,
 * unparseable timestamp, empty id) is a client error → 400
 * VALIDATION_ERROR (we never silently ignore it, which would
 * accidentally restart pagination from the top).
 *
 * For the "next page" (older rows) under a `timestamp DESC, id DESC`
 * sort, the strictly-after predicate is the row-value comparison
 * `(timestamp, id) < (cursorTs, cursorId)`, expanded for portability to:
 *
 *     timestamp < cursorTs OR (timestamp = cursorTs AND id < cursorId)
 *
 * ── Filters (design §10.3) ───────────────────────────────────────────────
 *
 *   - `event` — validated against the {@link AUDIT_EVENTS} vocabulary
 *     exported by `logger.ts`. An unknown event is rejected with 400
 *     VALIDATION_ERROR ("validate event enum").
 *   - `email` — lower-cased + trimmed via {@link normalizeEmail} (the
 *     SAME canonicaliser the LoginGuard uses for `email_lower`), then
 *     matched against EITHER `actorEmail` OR `targetEmail`. The design
 *     names a single "email" filter; an audit row records an email in
 *     two roles (the actor who acted, the target who was acted upon —
 *     e.g. an admin unlocking another user), and an investigator
 *     filtering by an address wants every row that mentions it in
 *     EITHER role. Matching actor-OR-target is the useful behaviour and
 *     is documented here as a deliberate interpretation of the design.
 *   - `from` / `to` — ISO-8601 date-times parsed to `Date`. When BOTH
 *     are present we enforce `from < to` AND `to - from ≤ 366 days`,
 *     rejecting a violation with 400 INVALID_RANGE (design error table:
 *     "from/to >366 ngày hoặc đảo ngược"). When only ONE bound is
 *     supplied it is applied as a one-sided filter with NO 366-day
 *     check — the cap is a WINDOW constraint and a window needs two
 *     ends, so a single open-ended bound is allowed (documented choice,
 *     matching the design which frames the cap on the `from`/`to`
 *     window). An unparseable `from`/`to` is a 400 VALIDATION_ERROR
 *     (it's a malformed value, not a reversed/oversized range).
 *   - `limit` — integer 1–100, default 50 when ABSENT. An explicitly
 *     supplied out-of-range or non-integer value is rejected with 400
 *     VALIDATION_ERROR rather than silently clamped: an explicit bad
 *     value is a client bug worth surfacing, whereas a missing value is
 *     simply the default. We fetch `limit + 1` rows to detect whether a
 *     next page exists without a second COUNT query.
 *
 * **Validates: Requirements 15.4**
 *
 * References: requirements §15.4; design.md §4.9, §10.3, §12.1.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { auditLog, type Database } from '@lumibase/database';

import type { AppEnv } from '../../env';
import { normalizeEmail } from '../login-guard/email-normalize';
import { AUDIT_EVENTS, type AuditLogEntry } from './logger';

// ── constants ──────────────────────────────────────────────────────────

/** Default page size when `limit` is absent (design §4.9). */
export const DEFAULT_LIMIT = 50;
/** Inclusive lower bound for an explicit `limit` (design §4.9). */
export const MIN_LIMIT = 1;
/** Inclusive upper bound for an explicit `limit` (design §4.9). */
export const MAX_LIMIT = 100;
/** Maximum `to - from` window when both bounds are present (design §10.3). */
export const MAX_RANGE_DAYS = 366;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Known event codes, frozen as a Set for O(1) enum validation. */
const KNOWN_EVENTS: ReadonlySet<string> = new Set(AUDIT_EVENTS);

// ── cursor codec (pure, exported for unit tests) ─────────────────────────

/**
 * Standard-base64 encode an ASCII string, portable across Node 20+ and
 * Cloudflare Workers (mirrors the `btoa` / `Buffer` fallback used in
 * `setup-token.ts` and `recovery/service.ts`). The cursor payload is
 * always ASCII (ISO timestamp + `nanoid`), so no UTF-8 escaping is
 * needed.
 */
function base64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  return Buffer.from(input, 'binary').toString('base64');
}

/**
 * Inverse of {@link base64Encode}. Throws on structurally-invalid
 * base64 — callers ({@link decodeCursor}) catch and map to `null`.
 */
function base64Decode(input: string): string {
  if (typeof atob === 'function') return atob(input);
  return Buffer.from(input, 'base64').toString('binary');
}

/**
 * Encode a page cursor as `base64(`${timestamp_iso}|${id}`)`
 * (design §10.3). Used to mint `nextCursor` from the last returned row.
 *
 * @param timestamp the last returned row's `timestamp`.
 * @param id        the last returned row's `id` (the sort tiebreaker).
 */
export function encodeCursor(timestamp: Date, id: string): string {
  return base64Encode(`${timestamp.toISOString()}|${id}`);
}

/**
 * Decode a page cursor back into its `(timestamp, id)` tuple, or `null`
 * when the cursor is malformed.
 *
 * Returns `null` (NEVER throws) on any of: non-string input, base64 that
 * fails to decode, a payload with no `|` separator, an empty `id`, or a
 * `timestamp` that doesn't parse to a valid `Date`. The route maps a
 * `null` here to 400 VALIDATION_ERROR — a bad cursor is a client error,
 * not a silent "start from the top".
 *
 * Splits on the FIRST `|` only: a `nanoid` never contains `|`, but
 * splitting on the first separator is robust regardless and keeps any
 * stray separator inside the (already-validated) id portion.
 */
export function decodeCursor(
  cursor: string | null | undefined,
): { timestamp: Date; id: string } | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;

  let decoded: string;
  try {
    decoded = base64Decode(cursor);
  } catch {
    return null;
  }

  const sep = decoded.indexOf('|');
  if (sep < 0) return null;

  const isoPart = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (id.length === 0) return null;

  const timestamp = new Date(isoPart);
  if (Number.isNaN(timestamp.getTime())) return null;

  return { timestamp, id };
}

// ── query parsing (pure, exported for unit tests) ────────────────────────

/**
 * Normalised, validated audit-log query filter — the input to
 * {@link queryAuditLog}. All fields except `limit` are optional; an
 * absent field means "no constraint on that dimension".
 */
export interface AuditLogFilter {
  /** Exact `event` match; one of {@link AUDIT_EVENTS}. */
  readonly event?: string;
  /** Lower-cased email matched against actorEmail OR targetEmail. */
  readonly email?: string;
  /** Inclusive lower time bound. */
  readonly from?: Date;
  /** Inclusive upper time bound. */
  readonly to?: Date;
  /** Decoded page cursor (strictly-after seed); absent on the first page. */
  readonly cursor?: { readonly timestamp: Date; readonly id: string };
  /** Validated page size (1–100, default 50). */
  readonly limit: number;
}

/** Discriminated result of {@link parseAuditLogQuery}. */
export type ParseAuditQueryResult =
  | { readonly ok: true; readonly filter: AuditLogFilter }
  | {
      readonly ok: false;
      /** HTTP error code for the envelope. */
      readonly code: 'VALIDATION_ERROR' | 'INVALID_RANGE';
      readonly message: string;
    };

/**
 * Parse + validate the raw query params of `GET /audit-log` into an
 * {@link AuditLogFilter}, WITHOUT any Hono coupling so the full
 * validation matrix (event enum, range, limit, cursor) is unit-testable
 * in isolation. The handler calls this and maps `{ ok: false }` to the
 * right HTTP status (`VALIDATION_ERROR` / `INVALID_RANGE` → 400).
 *
 * Validation order is chosen so the MOST SPECIFIC error wins: a
 * malformed individual value (`event`, `from`, `to`, `limit`, `cursor`)
 * is a `VALIDATION_ERROR`; only a well-formed pair of dates that is
 * reversed or too wide is the `INVALID_RANGE` case.
 *
 * @param params raw query params (e.g. from `c.req.query()`); each value
 *   is the string form or `undefined` when the param is absent.
 */
export function parseAuditLogQuery(
  params: Record<string, string | undefined>,
): ParseAuditQueryResult {
  // ── event (enum) ──────────────────────────────────────────────────────
  let event: string | undefined;
  const rawEvent = params.event;
  if (rawEvent !== undefined && rawEvent.length > 0) {
    if (!KNOWN_EVENTS.has(rawEvent)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Unknown event "${rawEvent}".`,
      };
    }
    event = rawEvent;
  }

  // ── email (lowercase normalise) ───────────────────────────────────────
  let email: string | undefined;
  const rawEmail = params.email;
  if (rawEmail !== undefined && rawEmail.length > 0) {
    const normalised = normalizeEmail(rawEmail);
    // A non-empty input that normalises to empty (all whitespace) is a
    // malformed filter value.
    if (normalised.length === 0) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Filter "email" is empty.',
      };
    }
    email = normalised;
  }

  // ── from / to (ISO-8601 date-time) ────────────────────────────────────
  let from: Date | undefined;
  if (params.from !== undefined && params.from.length > 0) {
    const parsed = new Date(params.from);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Filter "from" must be an ISO-8601 date-time.',
      };
    }
    from = parsed;
  }
  let to: Date | undefined;
  if (params.to !== undefined && params.to.length > 0) {
    const parsed = new Date(params.to);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Filter "to" must be an ISO-8601 date-time.',
      };
    }
    to = parsed;
  }

  // Range checks ONLY when both ends are present (a window needs two
  // ends). Reversed or >366-day window → INVALID_RANGE.
  if (from && to) {
    if (from.getTime() >= to.getTime()) {
      return {
        ok: false,
        code: 'INVALID_RANGE',
        message: '"from" must be strictly before "to".',
      };
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      return {
        ok: false,
        code: 'INVALID_RANGE',
        message: `Range must not exceed ${MAX_RANGE_DAYS} days.`,
      };
    }
  }

  // ── limit (1–100, default 50) ─────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  const rawLimit = params.limit;
  if (rawLimit !== undefined && rawLimit.length > 0) {
    // Strict integer: all-digits only (reject "50abc", "1.5", "-5", "1e3").
    if (!/^\d+$/.test(rawLimit)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Filter "limit" must be an integer.',
      };
    }
    const parsed = Number.parseInt(rawLimit, 10);
    if (parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Filter "limit" must be between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
      };
    }
    limit = parsed;
  }

  // ── cursor (base64 of `${ts}|${id}`) ──────────────────────────────────
  let cursor: { timestamp: Date; id: string } | undefined;
  const rawCursor = params.cursor;
  if (rawCursor !== undefined && rawCursor.length > 0) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Malformed cursor.',
      };
    }
    cursor = decoded;
  }

  return { ok: true, filter: { event, email, from, to, cursor, limit } };
}

// ── query execution (design §10.3 `query(filter)`) ───────────────────────

/** The page returned by {@link queryAuditLog}. */
export interface AuditLogPage {
  readonly items: AuditLogEntry[];
  readonly nextCursor: string | null;
}

/**
 * Execute the audit-log query for a validated {@link AuditLogFilter},
 * returning a page of entries plus the next-page cursor — the concrete
 * implementation of the design's `query(filter): Promise<{ items,
 * nextCursor }>` interface (design §10.3).
 *
 * Strategy:
 *   - Build the WHERE from the optional filters with `and(...)`
 *     (drizzle drops `undefined` conditions). `event` → `eq`; `email`
 *     → `or(eq(actorEmail), eq(targetEmail))`; `from` → `gte`; `to` →
 *     `lte`; cursor → the `(timestamp, id) < (cursorTs, cursorId)`
 *     tuple comparison expanded to `lt` / `eq` for portability.
 *   - ORDER BY `timestamp DESC, id DESC` (index-aligned — see the
 *     module doc-block).
 *   - `LIMIT limit + 1` to detect a next page WITHOUT a second COUNT:
 *     if more than `limit` rows come back, drop the extra and mint
 *     `nextCursor` from the LAST RETURNED row; otherwise `nextCursor`
 *     is `null`.
 */
export async function queryAuditLog(
  db: Database,
  filter: AuditLogFilter,
): Promise<AuditLogPage> {
  const conditions: Array<SQL | undefined> = [];

  if (filter.event) {
    conditions.push(eq(auditLog.event, filter.event));
  }
  if (filter.email) {
    conditions.push(
      or(
        eq(auditLog.actorEmail, filter.email),
        eq(auditLog.targetEmail, filter.email),
      ),
    );
  }
  if (filter.from) {
    conditions.push(gte(auditLog.timestamp, filter.from));
  }
  if (filter.to) {
    conditions.push(lte(auditLog.timestamp, filter.to));
  }
  if (filter.cursor) {
    // Strictly-after under `timestamp DESC, id DESC`:
    //   timestamp < cursorTs OR (timestamp = cursorTs AND id < cursorId)
    conditions.push(
      or(
        lt(auditLog.timestamp, filter.cursor.timestamp),
        and(
          eq(auditLog.timestamp, filter.cursor.timestamp),
          lt(auditLog.id, filter.cursor.id),
        ),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
    .limit(filter.limit + 1);

  // Detect + trim the look-ahead row.
  const hasMore = rows.length > filter.limit;
  const pageRows = hasMore ? rows.slice(0, filter.limit) : rows;

  const items: AuditLogEntry[] = pageRows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    event: row.event,
    actorEmail: row.actorEmail,
    targetEmail: row.targetEmail,
    ip: row.ip,
    userAgent: row.userAgent,
    countryCode: row.countryCode,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    requestId: row.requestId,
  }));

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]!;
    nextCursor = encodeCursor(last.timestamp, last.id);
  }

  return { items, nextCursor };
}

// ── admin gate ───────────────────────────────────────────────────────────

/**
 * Reject the request unless `c.get('auth').roles` contains `'admin'`,
 * returning `403 FORBIDDEN`. Mirrors `requireAdmin` in
 * `apps/cms/src/routes/admin-security.ts` — `withAuth` populates
 * `auth.roles` upstream, so this is purely the authorisation gate. See
 * the module doc-block for why a 403 (not a 404) is returned.
 *
 * Returns the 403 `Response` to short-circuit, or `null` when the caller
 * holds the `admin` role and the handler should proceed.
 */
function requireAdmin(c: Context<AppEnv>): Response | null {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] },
      403,
    );
  }
  return null;
}

// ── router ─────────────────────────────────────────────────────────────────

/**
 * Authenticated, admin-only audit-log query router. Mounted (task 12.3)
 * under the authenticated `api` Hono at `/api/v1/admin/security`, so the
 * leaf path resolves to `GET /api/v1/admin/security/audit-log`.
 */
export const auditRouter = new Hono<AppEnv>();

// ── GET /audit-log (Req 15.4; design §4.9, §10.3) ────────────────────────

auditRouter.get('/audit-log', async (c) => {
  // 1. Admin gate first — withAuth ran upstream; this enforces the role.
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  // 2. Parse + validate the query params (pure helper). Map a failure to
  //    the right 400 code (VALIDATION_ERROR / INVALID_RANGE).
  const parsed = parseAuditLogQuery({
    event: c.req.query('event'),
    email: c.req.query('email'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit'),
  });
  if (!parsed.ok) {
    return c.json(
      { errors: [{ code: parsed.code, message: parsed.message }] },
      400,
    );
  }

  // 3. Run the index-aligned, cursor-paginated query. P95 ≤ 2s is met by
  //    the `(timestamp)` / `(event, timestamp)` indexes (design §10.3),
  //    not by a code-level timeout.
  const page = await queryAuditLog(c.get('db'), parsed.filter);

  return c.json({ data: { items: page.items, nextCursor: page.nextCursor } });
});
