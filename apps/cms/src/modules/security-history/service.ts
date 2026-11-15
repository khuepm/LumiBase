/**
 * Security history query (#739, epic #674 S10).
 *
 * Reads the caller's own security events out of `lumibase_audit_log`. The
 * audit trail keys rows by email (`actor_email` / `target_email`) and, for
 * most account events, by `metadata.userId`; a row's SUBJECT is resolved in
 * this order so an admin action on someone else never lands in the admin's
 * own history (and vice versa):
 *
 *   1. `metadata.targetUserId` present → subject is that user id
 *      (admin unlock-user);
 *   2. else `metadata.userId` present → subject is that user id
 *      (password change/reset, MFA, session revocation, new device);
 *   3. else `target_email` present → subject is that address
 *      (login success/failure, lockout, anomaly);
 *   4. else `actor_email`.
 *
 * Plus: the event code is in {@link HISTORY_EVENTS}, the row's `site_id` is
 * one of the sites in scope, and the row is not older than the account
 * (an address that failed logins before someone registered it does not
 * leak those attempts to the new owner).
 *
 * Pagination is keyset on `(timestamp DESC, id DESC)` with the same opaque
 * cursor codec as the admin audit-log API.
 */

import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { auditLog, type Database } from '@lumibase/database';
import type { SecurityHistoryItem } from '@lumibase/contracts';

import { encodeCursor } from '../audit/routes';
import { encodeCell, quoteCsv } from '../../services/export-service';
import { HISTORY_EVENTS, toHistoryItem, type HistoryAuditRow } from './events';

export const HISTORY_DEFAULT_LIMIT = 25;
export const HISTORY_MAX_LIMIT = 100;
/** Rows per keyset batch while exporting. */
export const HISTORY_EXPORT_BATCH = 500;
/** Hard cap on one export (audit retention is 90 days by default). */
export const HISTORY_EXPORT_MAX_ROWS = 5000;

export interface SecurityHistorySubject {
  readonly userId: string;
  /** The account's current email (compared case-insensitively). */
  readonly email: string;
  /** Account creation time; older rows are excluded. Null = no floor. */
  readonly createdAt: Date | null;
}

export interface SecurityHistoryQuery {
  readonly subject: SecurityHistorySubject;
  /** Sites whose rows are in scope. Empty → no rows. */
  readonly siteIds: readonly string[];
  readonly cursor?: { readonly timestamp: Date; readonly id: string } | null;
  readonly limit: number;
}

export interface SecurityHistoryPage {
  readonly items: SecurityHistoryItem[];
  readonly nextCursor: string | null;
}

/** The subject predicate described in the module doc. */
export function subjectPredicate(subject: SecurityHistorySubject): SQL {
  const email = subject.email.trim().toLowerCase();
  return sql`(CASE
    WHEN (${auditLog.metadata} ->> 'targetUserId') IS NOT NULL
      THEN (${auditLog.metadata} ->> 'targetUserId') = ${subject.userId}
    WHEN (${auditLog.metadata} ->> 'userId') IS NOT NULL
      THEN (${auditLog.metadata} ->> 'userId') = ${subject.userId}
    WHEN ${auditLog.targetEmail} IS NOT NULL
      THEN lower(${auditLog.targetEmail}) = ${email}
    ELSE lower(${auditLog.actorEmail}) = ${email}
  END)`;
}

function conditions(q: SecurityHistoryQuery): SQL[] {
  const conds: SQL[] = [
    inArray(auditLog.event, [...HISTORY_EVENTS]),
    inArray(auditLog.siteId, [...q.siteIds]),
    subjectPredicate(q.subject),
  ];
  if (q.subject.createdAt) conds.push(gte(auditLog.timestamp, q.subject.createdAt));
  if (q.cursor) {
    const after = or(
      lt(auditLog.timestamp, q.cursor.timestamp),
      and(eq(auditLog.timestamp, q.cursor.timestamp), lt(auditLog.id, q.cursor.id)),
    );
    if (after) conds.push(after);
  }
  return conds;
}

async function fetchRows(db: Database, q: SecurityHistoryQuery, take: number): Promise<HistoryAuditRow[]> {
  return db
    .select({
      id: auditLog.id,
      timestamp: auditLog.timestamp,
      siteId: auditLog.siteId,
      event: auditLog.event,
      actorEmail: auditLog.actorEmail,
      targetEmail: auditLog.targetEmail,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      countryCode: auditLog.countryCode,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(...conditions(q)))
    .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
    .limit(take);
}

function redact(rows: readonly HistoryAuditRow[], email: string): SecurityHistoryItem[] {
  const out: SecurityHistoryItem[] = [];
  for (const row of rows) {
    const item = toHistoryItem(row, email);
    if (item) out.push(item);
  }
  return out;
}

/** One page of the caller's history, newest first. */
export async function querySecurityHistory(
  db: Database,
  q: SecurityHistoryQuery,
): Promise<SecurityHistoryPage> {
  if (q.siteIds.length === 0) return { items: [], nextCursor: null };
  const limit = Math.min(Math.max(1, Math.floor(q.limit)), HISTORY_MAX_LIMIT);
  const rows = await fetchRows(db, { ...q, limit }, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: redact(page, q.subject.email),
    nextCursor: rows.length > limit && last ? encodeCursor(last.timestamp, last.id) : null,
  };
}

/**
 * Every in-scope row (newest first) up to {@link HISTORY_EXPORT_MAX_ROWS},
 * fetched in keyset batches so memory stays bounded per batch.
 */
export async function exportSecurityHistory(
  db: Database,
  q: Omit<SecurityHistoryQuery, 'cursor' | 'limit'>,
): Promise<{ items: SecurityHistoryItem[]; truncated: boolean }> {
  if (q.siteIds.length === 0) return { items: [], truncated: false };
  const items: SecurityHistoryItem[] = [];
  let cursor: { timestamp: Date; id: string } | null = null;
  let scanned = 0;
  for (;;) {
    const remaining = HISTORY_EXPORT_MAX_ROWS - scanned;
    if (remaining <= 0) {
      // Peek one row to tell "exactly the cap" from "more than the cap".
      const more = await fetchRows(db, { ...q, cursor, limit: 1 }, 1);
      return { items, truncated: more.length > 0 };
    }
    const take = Math.min(HISTORY_EXPORT_BATCH, remaining);
    const rows = await fetchRows(db, { ...q, cursor, limit: take }, take);
    scanned += rows.length;
    items.push(...redact(rows, q.subject.email));
    const last = rows[rows.length - 1];
    if (rows.length < take || !last) return { items, truncated: false };
    cursor = { timestamp: last.timestamp, id: last.id };
  }
}

export const HISTORY_CSV_COLUMNS = [
  'occurredAt',
  'kind',
  'siteId',
  'ipApprox',
  'countryCode',
  'userAgent',
  'details',
] as const;

/**
 * CSV rendering of an export. Cells go through the same formula-neutralising
 * encoder as collection exports (`=`, `+`, `-`, `@` … get a leading `'`), so a
 * hostile User-Agent cannot become a spreadsheet formula.
 */
export function historyToCsv(items: readonly SecurityHistoryItem[]): string {
  const lines = [HISTORY_CSV_COLUMNS.join(',')];
  for (const item of items) {
    const details = Object.keys(item.details).length > 0 ? JSON.stringify(item.details) : null;
    const cells: unknown[] = [
      item.occurredAt,
      item.kind,
      item.siteId,
      item.ipApprox,
      item.countryCode,
      item.userAgent,
      details,
    ];
    lines.push(cells.map((v) => (v === '' ? '""' : quoteCsv(encodeCell(v)))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
