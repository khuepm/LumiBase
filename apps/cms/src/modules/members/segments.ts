/**
 * Saved member segments (#723, epic #672 N07).
 *
 * A segment is a named filter over member attributes and activity. Nothing is
 * materialised: the filter compiles to a parameterised SQL predicate that is
 * evaluated on every read, so the count and the membership "update
 * themselves" as members sign up, change tier, open mail or go quiet. Relative
 * date conditions (`within_days`, `older_than_days`) are computed against the
 * clock at evaluation time, which is what makes "opened in the last 30 days"
 * move without anyone pressing refresh.
 *
 * The same compiled predicate is the audience of a newsletter send (frozen
 * into the send row when it starts) and the condition a sequence enrols on.
 *
 * Every predicate is bound to one site: the caller passes `siteId`, and the
 * sub-selects (tiers, newsletters) repeat the site condition so a tier key or
 * newsletter key of another site can never match.
 */

import { z } from 'zod';
import { and, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  memberNewsletters,
  memberSegments,
  memberTiers,
  members,
  newsletters,
  type Database,
} from '@lumibase/database';
import { MemberError } from './errors';

export const MEMBER_STATUSES = ['free', 'paid', 'comped'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

const DATE_FIELDS = ['created_at', 'last_seen_at', 'last_email_opened_at'] as const;
const COUNT_FIELDS = ['email_count', 'email_opened_count'] as const;
const MAX_CONDITIONS = 25;
const MAX_LIST = 100;

const shortString = z.string().trim().min(1).max(120);

// A plain union: the date fields appear in two shapes (absolute / relative).
const conditionSchema = z.union([
  z.object({ field: z.literal('status'), op: z.enum(['in', 'not_in']), value: z.array(z.enum(MEMBER_STATUSES)).min(1) }),
  z.object({ field: z.literal('tier'), op: z.enum(['in', 'not_in']), value: z.array(shortString).min(1).max(MAX_LIST) }),
  z.object({ field: z.literal('label'), op: z.enum(['has', 'not_has']), value: shortString }),
  z.object({ field: z.literal('newsletter'), op: z.enum(['subscribed', 'not_subscribed']), value: shortString }),
  z.object({ field: z.literal('source'), op: z.enum(['in', 'not_in']), value: z.array(shortString).min(1).max(MAX_LIST) }),
  z.object({ field: z.literal('email_verified'), op: z.literal('is'), value: z.boolean() }),
  z.object({
    field: z.enum(DATE_FIELDS),
    op: z.enum(['before', 'after']),
    value: z.string().datetime({ offset: true }),
  }),
  z.object({
    field: z.enum(DATE_FIELDS),
    op: z.enum(['within_days', 'older_than_days', 'never']),
    value: z.number().int().min(0).max(36_500).optional(),
  }),
  z.object({ field: z.enum(COUNT_FIELDS), op: z.enum(['gte', 'lte', 'eq']), value: z.number().int().min(0).max(1_000_000) }),
  z.object({ field: z.literal('email_open_rate'), op: z.enum(['gte', 'lte']), value: z.number().min(0).max(100) }),
]);

export const segmentFilterSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  })
  .strict();

export type SegmentFilter = z.output<typeof segmentFilterSchema>;
export type SegmentCondition = z.output<typeof conditionSchema>;

/** Parse an untrusted filter (route body or stored row). Throws `MemberError('VALIDATION')`. */
export function parseSegmentFilter(raw: unknown): SegmentFilter {
  const parsed = segmentFilterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new MemberError('VALIDATION', 400, 'Invalid segment filter.', parsed.error.issues);
  }
  for (const c of parsed.data.conditions) {
    if ((c.op === 'within_days' || c.op === 'older_than_days') && c.value === undefined) {
      throw new MemberError('VALIDATION', 400, `${c.field} ${c.op} needs a number of days.`);
    }
  }
  return parsed.data;
}

function dateColumn(field: (typeof DATE_FIELDS)[number]) {
  if (field === 'created_at') return members.createdAt;
  if (field === 'last_seen_at') return members.lastSeenAt;
  return members.lastEmailOpenedAt;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

function compileCondition(siteId: string, c: SegmentCondition, now: Date): SQL {
  switch (c.field) {
    case 'status':
      return c.op === 'in' ? inArray(members.status, c.value) : notInArray(members.status, c.value);
    case 'tier': {
      const tierIds = sql`(SELECT ${memberTiers.id} FROM ${memberTiers} WHERE ${memberTiers.siteId} = ${siteId} AND ${inArray(memberTiers.key, c.value)})`;
      return c.op === 'in'
        ? sql`${members.tierId} IN ${tierIds}`
        : sql`(${members.tierId} IS NULL OR ${members.tierId} NOT IN ${tierIds})`;
    }
    case 'label': {
      const has = sql`${members.labels} @> ${JSON.stringify([c.value])}::jsonb`;
      return c.op === 'has' ? has : sql`NOT (${has})`;
    }
    case 'newsletter': {
      const exists = sql`EXISTS (SELECT 1 FROM ${memberNewsletters} INNER JOIN ${newsletters} ON ${newsletters.id} = ${memberNewsletters.newsletterId} WHERE ${memberNewsletters.memberId} = ${members.id} AND ${memberNewsletters.siteId} = ${siteId} AND ${newsletters.siteId} = ${siteId} AND ${newsletters.key} = ${c.value})`;
      return c.op === 'subscribed' ? exists : sql`NOT ${exists}`;
    }
    case 'source':
      return c.op === 'in' ? inArray(members.source, c.value) : notInArray(members.source, c.value);
    case 'email_verified':
      return c.value ? sql`${members.emailVerifiedAt} IS NOT NULL` : sql`${members.emailVerifiedAt} IS NULL`;
    case 'email_count':
    case 'email_opened_count': {
      const col = c.field === 'email_count' ? members.emailCount : members.emailOpenedCount;
      if (c.op === 'gte') return sql`${col} >= ${c.value}`;
      if (c.op === 'lte') return sql`${col} <= ${c.value}`;
      return sql`${col} = ${c.value}`;
    }
    case 'email_open_rate': {
      // Members who were never mailed have no rate; they match neither bound.
      const rate = sql`(${members.emailOpenedCount}::float * 100 / NULLIF(${members.emailCount}, 0))`;
      return c.op === 'gte' ? sql`${rate} >= ${c.value}` : sql`${rate} <= ${c.value}`;
    }
    default: {
      // Drizzle operators (not raw `sql`) so the Date is mapped by the column type.
      const col = dateColumn(c.field);
      if (c.op === 'before') return lt(col, new Date(c.value));
      if (c.op === 'after') return gt(col, new Date(c.value));
      if (c.op === 'never') return isNull(col);
      const edge = daysAgo(now, typeof c.value === 'number' ? c.value : 0);
      return c.op === 'within_days' ? gte(col, edge) : or(isNull(col), lt(col, edge))!;
    }
  }
}

/**
 * The full WHERE predicate for a segment: the site condition AND the
 * filter. An empty filter is "every member of the site".
 */
export function segmentWhere(siteId: string, filter: SegmentFilter, now: Date = new Date()): SQL {
  const site = eq(members.siteId, siteId);
  if (filter.conditions.length === 0) return site;
  const parts = filter.conditions.map((c) => compileCondition(siteId, c, now));
  const combined = filter.match === 'any' ? or(...parts) : and(...parts);
  return and(site, combined)!;
}

export async function countSegment(db: Database, siteId: string, filter: SegmentFilter, now?: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(segmentWhere(siteId, filter, now));
  return row?.n ?? 0;
}

// ── Saved segments CRUD ────────────────────────────────────────────────────

export const segmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  filter: z.unknown(),
});

export interface SegmentView {
  id: string;
  name: string;
  description: string | null;
  filter: SegmentFilter;
  /** Live count, evaluated on this read. */
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

type SegmentRow = typeof memberSegments.$inferSelect;

async function toView(db: Database, siteId: string, row: SegmentRow): Promise<SegmentView> {
  const filter = parseSegmentFilter(row.filter);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filter,
    count: await countSegment(db, siteId, filter),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSegments(db: Database, siteId: string): Promise<SegmentView[]> {
  const rows = await db.select().from(memberSegments).where(eq(memberSegments.siteId, siteId)).orderBy(memberSegments.name);
  return Promise.all(rows.map((r) => toView(db, siteId, r)));
}

export async function getSegmentRow(db: Database, siteId: string, id: string): Promise<SegmentRow> {
  const [row] = await db
    .select()
    .from(memberSegments)
    .where(and(eq(memberSegments.siteId, siteId), eq(memberSegments.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Segment not found.');
  return row;
}

export async function getSegment(db: Database, siteId: string, id: string): Promise<SegmentView> {
  return toView(db, siteId, await getSegmentRow(db, siteId, id));
}

export async function createSegment(
  db: Database,
  siteId: string,
  input: { name: string; description?: string | null; filter: unknown },
  createdBy: string | null,
): Promise<SegmentView> {
  const filter = parseSegmentFilter(input.filter);
  const [row] = await db
    .insert(memberSegments)
    .values({ siteId, name: input.name, description: input.description ?? null, filter, createdBy })
    .returning();
  return toView(db, siteId, row!);
}

export async function updateSegment(
  db: Database,
  siteId: string,
  id: string,
  patch: { name?: string; description?: string | null; filter?: unknown },
): Promise<SegmentView> {
  const set: Partial<typeof memberSegments.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.filter !== undefined) set.filter = parseSegmentFilter(patch.filter);
  const [row] = await db
    .update(memberSegments)
    .set(set)
    .where(and(eq(memberSegments.siteId, siteId), eq(memberSegments.id, id)))
    .returning();
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Segment not found.');
  return toView(db, siteId, row);
}

export async function deleteSegment(db: Database, siteId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(memberSegments)
    .where(and(eq(memberSegments.siteId, siteId), eq(memberSegments.id, id)))
    .returning({ id: memberSegments.id });
  if (deleted.length === 0) throw new MemberError('NOT_FOUND', 404, 'Segment not found.');
}

/** Preview: count + first page of an unsaved filter (Studio live preview). */
export async function previewSegment(
  db: Database,
  siteId: string,
  rawFilter: unknown,
  limit = 20,
): Promise<{ count: number; sample: Array<{ id: string; email: string; name: string | null; status: string }> }> {
  const filter = parseSegmentFilter(rawFilter);
  const where = segmentWhere(siteId, filter);
  const [count, sample] = await Promise.all([
    countSegment(db, siteId, filter),
    db
      .select({ id: members.id, email: members.email, name: members.name, status: members.status })
      .from(members)
      .where(where)
      .orderBy(members.createdAt)
      .limit(Math.min(Math.max(limit, 1), 100)),
  ]);
  return { count, sample };
}
