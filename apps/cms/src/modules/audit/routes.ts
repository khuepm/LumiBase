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
 * This file owns the QUERY route (`GET /audit-log`, task 12.1) and the
 * NDJSON EXPORT route (`GET /audit-log/export`, task 12.2) plus their
 * pure, independently unit-testable helpers ({@link encodeCursor},
 * {@link decodeCursor}, {@link parseAuditLogQuery}, {@link queryAuditLog},
 * {@link parseAuditExportFilter}, {@link countAuditRows},
 * {@link auditExportLines}, {@link ndjsonStream}). The mount under the
 * authenticated `api` Hono at `/api/v1/admin/security` (task 12.3) and
 * the Studio "Security audit" tab (task 12.4) are DELIBERATELY out of
 * scope here.
 *
 *   GET /audit-log/export
 *     ?event=&email=&from=&to=
 *     → 200 application/x-ndjson  (streamed; one JSON object per line)
 *     → 400 VALIDATION_ERROR | 400 INVALID_RANGE | 403 FORBIDDEN
 *     → 413 EXPORT_TOO_LARGE  (would exceed the 100,000-row cap)
 *
 * ── NDJSON streaming export (task 12.2; Req 15.6; design §10.4) ───────────
 *
 * The export streams the FULL result set matching the same filters as
 * the query route (minus pagination — an export does not paginate, it
 * emits everything up to the cap) as newline-delimited JSON (NDJSON):
 * one `JSON.stringify(row)` per line, terminated by `\n`. The body is
 * built from a pull-based {@link ndjsonStream | ReadableStream} backed by
 * the {@link auditExportLines} async generator, which queries the DB in
 * keyset-paginated batches of {@link EXPORT_BATCH_SIZE} (500) rows rather
 * than loading the whole table into memory. Streaming + batching keeps a
 * multi-megabyte export flat on memory: at most one 500-row batch is
 * resident at a time, and the HTTP layer back-pressures the generator
 * via the stream's `pull` so we never out-run the client's read rate.
 *
 * Why keyset (`(timestamp, id) < (lastTs, lastId)`) and not `OFFSET`?
 * An `OFFSET n` scan re-reads and discards `n` rows on every batch, so a
 * full-table export degrades to O(n²); keyset pagination seeks directly
 * past the last row of the previous batch using the same
 * `(timestamp DESC, id DESC)` index the query route relies on, keeping
 * each batch O(batch) regardless of how deep into the export we are. The
 * cursor tuple is the SAME comparison {@link queryAuditLog} uses — the
 * two share {@link auditFilterConditions}.
 *
 * ── The 100,000-row cap → 413 (Req 15.6; design §10.4) ────────────────────
 *
 * The design caps an export at {@link EXPORT_MAX_ROWS} (100,000) rows.
 * We enforce it with a PRE-FLIGHT `SELECT count(*)` ({@link countAuditRows})
 * over the SAME filters BEFORE opening the stream: if the count exceeds
 * the cap we return `413 { errors: [{ code: 'EXPORT_TOO_LARGE' }] }`
 * deterministically, without having streamed a single byte. A count
 * probe is the clean way to reject up-front — once a `200` + body has
 * begun streaming we can no longer change the status code, so the cap
 * MUST be decided before the stream opens. The ≤366-day range cap is a
 * separate gate already enforced by the shared filter validation
 * (reversed / oversized window → 400 INVALID_RANGE); and even with NO
 * `from`/`to`, the count probe still bounds the export. As a defensive
 * belt-and-brace the streaming generator ALSO stops at the cap, so a row
 * inserted between the probe and the stream can never push the body past
 * {@link EXPORT_MAX_ROWS}.
 *
 * ── metadata is pre-masked at write time (Req 15.3) ──────────────────────
 *
 * The exported rows are emitted VERBATIM — no re-masking on read. This
 * is safe because {@link ../audit/logger | AuditLogger.write} masks the
 * four secret keys (`passwordHash`, `setupToken`, `backupCode`,
 * `recoveryToken`) out of `metadata` BEFORE the insert (task 11.1), so
 * the secrets never landed in the table in the first place. There is
 * nothing to strip on the way out.
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
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';
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

/**
 * Number of rows fetched per keyset-paginated batch by
 * {@link auditExportLines} (design §10.4). Bounds peak memory: at most
 * one batch of rows is resident at a time. 500 balances round-trip
 * overhead (fewer, larger queries) against memory footprint.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * Hard cap on the number of rows a single NDJSON export may emit
 * (Req 15.6; design §10.4). The route rejects an export whose pre-flight
 * count exceeds this with 413 EXPORT_TOO_LARGE; the streaming generator
 * also stops here defensively so a concurrent insert can never push the
 * body past the cap.
 */
export const EXPORT_MAX_ROWS = 100_000;

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
  /** Active tenant/site id; set by route handlers before executing DB reads. */
  readonly siteId?: string;
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
 * Build the shared WHERE conditions for the non-pagination filters
 * (`event`, `email`, `from`, `to`) common to BOTH the query route and
 * the export route. Returns the array of drizzle conditions (empty when
 * the filter is fully open); only present conditions are pushed so the
 * caller can `and(...conditions)` directly.
 *
 *   - `event` → `eq(event, $)`
 *   - `email` → `or(eq(actorEmail, $), eq(targetEmail, $))` (actor OR
 *     target — see the module doc-block on the email filter)
 *   - `from`  → `gte(timestamp, $)`
 *   - `to`    → `lte(timestamp, $)`
 *
 * Factored out so the query's cursor scan and the export's keyset batch
 * scan share EXACTLY the same filter semantics (DRY — a divergence here
 * would mean an export silently covered a different row set than the
 * paginated view of the same filters).
 */
function auditFilterConditions(filter: {
  readonly siteId: string;
  readonly event?: string;
  readonly email?: string;
  readonly from?: Date;
  readonly to?: Date;
}): SQL[] {
  const conditions: SQL[] = [eq(auditLog.siteId, filter.siteId)];
  if (filter.event) {
    conditions.push(eq(auditLog.event, filter.event));
  }
  if (filter.email) {
    conditions.push(
      or(
        eq(auditLog.actorEmail, filter.email),
        eq(auditLog.targetEmail, filter.email),
      )!,
    );
  }
  if (filter.from) {
    conditions.push(gte(auditLog.timestamp, filter.from));
  }
  if (filter.to) {
    conditions.push(lte(auditLog.timestamp, filter.to));
  }
  return conditions;
}

/**
 * The strictly-after keyset predicate for the `timestamp DESC, id DESC`
 * sort: a row is "after" the cursor (i.e. on a later page / later batch)
 * when it is strictly older:
 *
 *     timestamp < cursorTs OR (timestamp = cursorTs AND id < cursorId)
 *
 * Shared by the query route's cursor and the export's batch seek so the
 * two cannot drift apart.
 */
function keysetAfter(cursor: { timestamp: Date; id: string }): SQL {
  return or(
    lt(auditLog.timestamp, cursor.timestamp),
    and(eq(auditLog.timestamp, cursor.timestamp), lt(auditLog.id, cursor.id)),
  )!;
}

/**
 * Map a raw `audit_log` row to the public {@link AuditLogEntry} shape
 * the query route returns and the export serialises. Shared so both
 * surfaces emit byte-identical row shapes.
 */
function toAuditLogEntry(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    timestamp: row.timestamp as Date,
    siteId: (row.siteId ?? null) as string | null,
    event: row.event as string,
    actorEmail: (row.actorEmail ?? null) as string | null,
    targetEmail: (row.targetEmail ?? null) as string | null,
    ip: (row.ip ?? null) as string | null,
    userAgent: (row.userAgent ?? null) as string | null,
    countryCode: (row.countryCode ?? null) as string | null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    requestId: (row.requestId ?? null) as string | null,
  };
}

/**
 * Execute the audit-log query for a validated {@link AuditLogFilter},
 * returning a page of entries plus the next-page cursor — the concrete
 * implementation of the design's `query(filter): Promise<{ items,
 * nextCursor }>` interface (design §10.3).
 *
 * Strategy:
 *   - Build the WHERE from the optional filters via
 *     {@link auditFilterConditions} plus the cursor's
 *     {@link keysetAfter} predicate.
 *   - ORDER BY `timestamp DESC, id DESC` (index-aligned — see the
 *     module doc-block).
 *   - `LIMIT limit + 1` to detect a next page WITHOUT a second COUNT:
 *     if more than `limit` rows come back, drop the extra and mint
 *     `nextCursor` from the LAST RETURNED row; otherwise `nextCursor`
 *     is `null`.
 */
export async function queryAuditLog(
  db: Database,
  filter: AuditLogFilter & { readonly siteId: string },
): Promise<AuditLogPage> {
  const conditions: SQL[] = auditFilterConditions(filter);
  if (filter.cursor) {
    conditions.push(keysetAfter(filter.cursor));
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

  const items: AuditLogEntry[] = pageRows.map((row) => toAuditLogEntry(row));

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]!;
    nextCursor = encodeCursor(last.timestamp, last.id);
  }

  return { items, nextCursor };
}

// ── export filter parsing (pure, exported for unit tests) ────────────────

/**
 * Normalised, validated audit-log EXPORT filter — the input to
 * {@link countAuditRows} and {@link auditExportLines}. Identical to the
 * non-pagination subset of {@link AuditLogFilter}: an export streams the
 * FULL matching set, so it has NO `limit` and NO `cursor` (those are the
 * query route's pagination knobs).
 */
export interface AuditExportFilter {
  readonly siteId?: string;
  readonly event?: string;
  readonly email?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/** Discriminated result of {@link parseAuditExportFilter}. */
export type ParseAuditExportResult =
  | { readonly ok: true; readonly filter: AuditExportFilter }
  | {
      readonly ok: false;
      readonly code: 'VALIDATION_ERROR' | 'INVALID_RANGE';
      readonly message: string;
    };

/**
 * Parse + validate the raw query params of `GET /audit-log/export` into
 * an {@link AuditExportFilter}. DRY: delegates to {@link
 * parseAuditLogQuery} (which owns the event-enum / email-normalise /
 * from-to-range validation matrix) and simply DROPS the `limit` and
 * `cursor` it returns — the export does not paginate, so those knobs are
 * meaningless here. Reusing the query parser guarantees the export's
 * filter validation can never drift from the query route's (same event
 * vocabulary, same email canonicalisation, same ≤366-day / reversed
 * window → INVALID_RANGE rule).
 *
 * Note `limit`/`cursor` are not even read from `params`, so an export
 * caller that erroneously passes them is silently tolerated rather than
 * rejected — they have no effect on a full-set stream.
 */
export function parseAuditExportFilter(
  params: Record<string, string | undefined>,
): ParseAuditExportResult {
  const parsed = parseAuditLogQuery({
    event: params.event,
    email: params.email,
    from: params.from,
    to: params.to,
    // explicitly ignore pagination knobs for an export
  });
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: parsed.message };
  }
  const { event, email, from, to } = parsed.filter;
  return { ok: true, filter: { event, email, from, to } };
}

// ── pre-flight count probe (the 100k cap → 413) ──────────────────────────

/**
 * `SELECT count(*)` over the export's filters — the deterministic
 * pre-flight gate for the {@link EXPORT_MAX_ROWS} cap (Req 15.6; design
 * §10.4). Run BEFORE the stream opens: once a `200` + body has begun
 * streaming the status code is fixed, so the cap must be decided here.
 *
 * Uses the SAME {@link auditFilterConditions} as the stream so the count
 * matches exactly the row set the stream would emit. Casts to `::int`
 * inside the SQL (matching `PostgresCounterStore`) so the JS side gets a
 * plain number, and falls back to `0` on an empty result set.
 */
export async function countAuditRows(
  db: Database,
  filter: AuditExportFilter & { readonly siteId: string },
): Promise<number> {
  const conditions = auditFilterConditions(filter);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(where);

  return rows[0]?.count ?? 0;
}

// ── NDJSON streaming generator (design §10.4) ────────────────────────────

/** Tunable knobs for {@link auditExportLines}; defaulted from the constants. */
export interface AuditExportOptions {
  /** Rows per keyset batch. Defaults to {@link EXPORT_BATCH_SIZE} (500). */
  readonly batchSize?: number;
  /** Hard row cap. Defaults to {@link EXPORT_MAX_ROWS} (100,000). */
  readonly cap?: number;
}

/**
 * Async generator yielding one NDJSON line (`JSON.stringify(entry) +
 * '\n'`) per matching `audit_log` row, in `timestamp DESC, id DESC`
 * order, fetched in keyset-paginated batches of `batchSize` (design
 * §10.4).
 *
 * Why a generator (and not a raw ReadableStream)? A generator yielding
 * strings is trivially unit-testable — collect the yielded lines with a
 * fake `db` and assert one line per row — whereas asserting on a
 * ReadableStream requires a reader pump. The route adapts this generator
 * into a ReadableStream via {@link ndjsonStream}.
 *
 * Batching + keyset (see the module doc-block): each batch fetches
 * `batchSize` rows WHERE `(timestamp, id) < (lastTs, lastId)` of the
 * previous batch, seeking directly past the prior page using the
 * `(timestamp DESC, id DESC)` index — O(batch) per step, not O(offset).
 * The loop stops when either:
 *   - a batch returns fewer than `batchSize` rows (end of data), or
 *   - the running total reaches `cap` (defensive — the route's
 *     pre-flight count should already have rejected an over-cap export
 *     with 413, but a row inserted between the probe and the stream must
 *     never push the body past the cap).
 *
 * metadata is emitted verbatim — it was masked at write time (Req 15.3),
 * so there are no secrets to strip on read (see the module doc-block).
 *
 * **Validates: Requirements 15.6**
 */
export async function* auditExportLines(
  db: Database,
  filter: AuditExportFilter & { readonly siteId: string },
  opts: AuditExportOptions = {},
): AsyncGenerator<string, void, unknown> {
  const batchSize =
    opts.batchSize && opts.batchSize > 0 ? opts.batchSize : EXPORT_BATCH_SIZE;
  const cap = opts.cap && opts.cap > 0 ? opts.cap : EXPORT_MAX_ROWS;

  const baseConditions = auditFilterConditions(filter);
  let cursor: { timestamp: Date; id: string } | undefined;
  let emitted = 0;

  // Keyset scan: each iteration seeks past the previous batch's last row.
  for (;;) {
    const conditions = [...baseConditions];
    if (cursor) {
      conditions.push(keysetAfter(cursor));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      if (emitted >= cap) return; // defensive cap (see doc-block)
      const entry = toAuditLogEntry(row);
      yield `${JSON.stringify(entry)}\n`;
      emitted += 1;
    }

    // Seed the next batch from the LAST row of this one.
    const last = rows[rows.length - 1]! as Record<string, unknown>;
    cursor = { timestamp: last.timestamp as Date, id: last.id as string };

    // A short batch means we've reached the end of the data.
    if (rows.length < batchSize) break;
    if (emitted >= cap) return;
  }
}

/**
 * Adapt an async generator of strings into a pull-based byte
 * {@link ReadableStream} suitable for `c.body(...)` (design §10.4). The
 * stream's `pull` advances the generator one yield at a time and
 * enqueues the UTF-8 bytes of each line, applying natural back-pressure:
 * the platform only calls `pull` again when the consumer is ready, so a
 * slow client throttles the DB scan rather than buffering the whole
 * export in memory. The stream closes when the generator is exhausted.
 *
 * Runtime-portable: `ReadableStream` and `TextEncoder` are standard on
 * Node 20+ and Cloudflare Workers (the same baseline the rest of the
 * module relies on).
 */
export function ndjsonStream(
  lines: AsyncGenerator<string, void, unknown>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (err) {
        // Surface a mid-stream DB failure to the consumer; the HTTP
        // layer has already sent 200 + headers, so the body simply
        // errors out (the client sees a truncated/aborted download).
        controller.error(err);
      }
    },
    async cancel() {
      // Consumer aborted (closed the connection): let the generator run
      // its `finally` so any DB resources are released.
      await lines.return?.();
    },
  });
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
  const page = await queryAuditLog(c.get('db'), {
    ...parsed.filter,
    siteId: c.get('siteId'),
  });

  return c.json({ data: { items: page.items, nextCursor: page.nextCursor } });
});

// ── GET /audit-log/export (Req 15.6; design §4.10, §10.4) ────────────────

auditRouter.get('/audit-log/export', async (c) => {
  // 1. Admin gate first — withAuth ran upstream; this enforces the role.
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  // 2. Parse + validate the filters (shared with the query route, minus
  //    pagination). Map a failure to the right 400 code.
  const parsed = parseAuditExportFilter({
    event: c.req.query('event'),
    email: c.req.query('email'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.ok) {
    return c.json(
      { errors: [{ code: parsed.code, message: parsed.message }] },
      400,
    );
  }

  const db = c.get('db');

  // 3. PRE-FLIGHT CAP CHECK → 413. Decide the cap deterministically with
  //    a count probe BEFORE opening the stream (a 200 + body can no
  //    longer change its status code). Req 15.6; design §10.4.
  const filter = { ...parsed.filter, siteId: c.get('siteId') };
  const total = await countAuditRows(db, filter);
  if (total > EXPORT_MAX_ROWS) {
    return c.json(
      {
        errors: [
          {
            code: 'EXPORT_TOO_LARGE',
            message: `Export of ${total} rows exceeds the ${EXPORT_MAX_ROWS}-row cap. Narrow the filters or date range.`,
          },
        ],
      },
      413,
    );
  }

  // 4. Stream the NDJSON body from the keyset-batched generator. Headers
  //    MUST be set before `c.body(...)`: an attachment download of
  //    newline-delimited JSON.
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header(
    'Content-Disposition',
    'attachment; filename="audit-log-export.ndjson"',
  );

  const stream = ndjsonStream(auditExportLines(db, filter));
  return c.body(stream);
});
