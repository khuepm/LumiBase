/**
 * Members (#717, epic #672 N01): profiles, status (free / paid / comped),
 * tier, labels and per-member newsletter toggles.
 *
 * Every read and write is bound to one site. Status and tier move together:
 *   - `free`   → the site's free tier (created on first use);
 *   - `paid`   → a paid tier, normally set by the payment hook;
 *   - `comped` → a paid tier granted by staff without payment.
 * After any change that can affect access, {@link syncMemberTierPolicy}
 * reconciles the member's tier policy on their subscriber account and the
 * caller bumps the permission version.
 *
 * Member events (`member.created`, `member.tier_changed`, `member.deleted`)
 * fan out to event-triggered Flows (collection `lumibase_members`) and enrol
 * members into matching email sequences.
 */

import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  memberNewsletters,
  memberTiers,
  members,
  newsletters,
  type Database,
} from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { dispatchItemEvent } from '../../services/flow-dispatch';
import { escapeLikePattern } from '../../services/like-pattern';
import { normalizeEmail } from '../login-guard/email-normalize';
import { MemberError, isUniqueViolation } from './errors';
import { MEMBER_STATUSES, parseSegmentFilter, segmentWhere, type MemberStatus } from './segments';
import { enrollForTrigger, stopEnrollments } from './sequences';
import { ensureFreeTier, getTier, syncMemberTierPolicy } from './tiers';

export const MEMBERS_FLOW_COLLECTION = 'lumibase_members';
export type MemberEventName = 'member.created' | 'member.tier_changed' | 'member.deleted' | 'member.unsubscribed';

const label = z.string().trim().min(1).max(60);

export const memberCreateSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(200).nullable().optional(),
  status: z.enum(MEMBER_STATUSES).default('free'),
  tierId: z.string().min(1).nullable().optional(),
  tierExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  labels: z.array(label).max(50).default([]),
  note: z.string().max(2000).nullable().optional(),
  /** Newsletter ids; omitted = the newsletters with `subscribeOnSignup`. */
  newsletterIds: z.array(z.string().min(1)).max(50).optional(),
});
export type MemberCreateInput = z.output<typeof memberCreateSchema>;

export const memberUpdateSchema = memberCreateSchema.omit({ email: true }).extend({
  email: z.string().trim().email().max(320),
});

export interface MemberServiceDeps {
  db: Database;
  siteId: string;
  /** Flow-events queue; absent = no flow fan-out (tests, degraded runtime). */
  queue?: QueueProvider;
  now?: () => Date;
}

type MemberRow = typeof members.$inferSelect;

export interface MemberView {
  id: string;
  email: string;
  name: string | null;
  status: MemberStatus;
  tier: { id: string; key: string; name: string; kind: string } | null;
  tierExpiresAt: Date | null;
  labels: string[];
  note: string | null;
  source: string;
  emailVerified: boolean;
  hasAccount: boolean;
  newsletters: Array<{ id: string; key: string; name: string }>;
  emailCount: number;
  emailOpenedCount: number;
  emailOpenRate: number | null;
  lastEmailOpenedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListMembersQuery {
  limit?: number;
  offset?: number;
  search?: string;
  /** Segment filter DSL (already resolved from `segmentId` by the route). */
  filter?: unknown;
  sort?: 'created_at' | '-created_at' | 'email' | '-last_seen_at';
}

function asLabels(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export class MemberService {
  private readonly now: () => Date;

  constructor(private readonly deps: MemberServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get db() {
    return this.deps.db;
  }
  private get siteId() {
    return this.deps.siteId;
  }

  // ── Views ──────────────────────────────────────────────────────────────

  private async toViews(rows: MemberRow[]): Promise<MemberView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const tierIds = [...new Set(rows.map((r) => r.tierId).filter((t): t is string => !!t))];
    const [tiers, subs] = await Promise.all([
      tierIds.length
        ? this.db
            .select({ id: memberTiers.id, key: memberTiers.key, name: memberTiers.name, kind: memberTiers.kind })
            .from(memberTiers)
            .where(and(eq(memberTiers.siteId, this.siteId), inArray(memberTiers.id, tierIds)))
        : Promise.resolve([]),
      this.db
        .select({ memberId: memberNewsletters.memberId, id: newsletters.id, key: newsletters.key, name: newsletters.name })
        .from(memberNewsletters)
        .innerJoin(newsletters, eq(newsletters.id, memberNewsletters.newsletterId))
        .where(and(eq(memberNewsletters.siteId, this.siteId), inArray(memberNewsletters.memberId, ids)))
        .orderBy(asc(newsletters.sortOrder)),
    ]);
    const tierById = new Map(tiers.map((t) => [t.id, t]));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      status: r.status as MemberStatus,
      tier: r.tierId ? tierById.get(r.tierId) ?? null : null,
      tierExpiresAt: r.tierExpiresAt,
      labels: asLabels(r.labels),
      note: r.note,
      source: r.source,
      emailVerified: !!r.emailVerifiedAt,
      hasAccount: !!r.userId,
      newsletters: subs.filter((s) => s.memberId === r.id).map(({ id, key, name }) => ({ id, key, name })),
      emailCount: r.emailCount,
      emailOpenedCount: r.emailOpenedCount,
      emailOpenRate: r.emailCount > 0 ? Math.round((r.emailOpenedCount * 1000) / r.emailCount) / 10 : null,
      lastEmailOpenedAt: r.lastEmailOpenedAt,
      lastSeenAt: r.lastSeenAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async view(row: MemberRow): Promise<MemberView> {
    const [v] = await this.toViews([row]);
    return v!;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async list(query: ListMembersQuery): Promise<{ data: MemberView[]; meta: { total: number; limit: number; offset: number } }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const parts: SQL[] = [segmentWhere(this.siteId, parseSegmentFilter(query.filter ?? {}), this.now())];
    const search = query.search?.trim();
    if (search) {
      const pattern = `%${escapeLikePattern(search.toLowerCase())}%`;
      parts.push(or(ilike(members.emailLower, pattern), ilike(members.name, pattern))!);
    }
    const where = and(...parts);
    const order =
      query.sort === 'created_at'
        ? asc(members.createdAt)
        : query.sort === 'email'
          ? asc(members.emailLower)
          : query.sort === '-last_seen_at'
            ? sql`${members.lastSeenAt} DESC NULLS LAST`
            : desc(members.createdAt);
    const [rows, [count]] = await Promise.all([
      this.db.select().from(members).where(where).orderBy(order, asc(members.id)).limit(limit).offset(offset),
      this.db.select({ n: sql<number>`count(*)::int` }).from(members).where(where),
    ]);
    return { data: await this.toViews(rows), meta: { total: count?.n ?? 0, limit, offset } };
  }

  async getRow(id: string): Promise<MemberRow> {
    const [row] = await this.db
      .select()
      .from(members)
      .where(and(eq(members.siteId, this.siteId), eq(members.id, id)))
      .limit(1);
    if (!row) throw new MemberError('NOT_FOUND', 404, 'Member not found.');
    return row;
  }

  async findByEmail(email: string): Promise<MemberRow | null> {
    const [row] = await this.db
      .select()
      .from(members)
      .where(and(eq(members.siteId, this.siteId), eq(members.emailLower, normalizeEmail(email))))
      .limit(1);
    return row ?? null;
  }

  async findByUser(userId: string): Promise<MemberRow | null> {
    const [row] = await this.db
      .select()
      .from(members)
      .where(and(eq(members.siteId, this.siteId), eq(members.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async get(id: string): Promise<MemberView> {
    return this.view(await this.getRow(id));
  }

  // ── Status / tier resolution ────────────────────────────────────────────

  /** Validate a status/tier pair and return the tier id to store. */
  private async resolveTier(status: MemberStatus, tierId: string | null | undefined): Promise<string> {
    if (status === 'free') {
      if (tierId) {
        const tier = await getTier(this.db, this.siteId, tierId);
        if (tier.kind !== 'free') throw new MemberError('TIER_STATUS_MISMATCH', 400, 'A free member must be on a free tier.');
        return tier.id;
      }
      return (await ensureFreeTier(this.db, this.siteId)).id;
    }
    if (!tierId) throw new MemberError('TIER_REQUIRED', 400, `A ${status} member needs a paid tier.`);
    const tier = await getTier(this.db, this.siteId, tierId);
    if (tier.kind !== 'paid') throw new MemberError('TIER_STATUS_MISMATCH', 400, `A ${status} member must be on a paid tier.`);
    return tier.id;
  }

  private async defaultNewsletterIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: newsletters.id })
      .from(newsletters)
      .where(and(eq(newsletters.siteId, this.siteId), eq(newsletters.status, 'active'), eq(newsletters.subscribeOnSignup, true)));
    return rows.map((r) => r.id);
  }

  /** Keep only active newsletters of this site that the member's status may receive. */
  private async allowedNewsletterIds(ids: readonly string[], status: MemberStatus): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: newsletters.id, audience: newsletters.audience })
      .from(newsletters)
      .where(and(eq(newsletters.siteId, this.siteId), eq(newsletters.status, 'active'), inArray(newsletters.id, [...ids])));
    return rows.filter((r) => r.audience !== 'paid' || status !== 'free').map((r) => r.id);
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async create(
    input: MemberCreateInput,
    opts: { source?: string; userId?: string | null; emailVerified?: boolean } = {},
  ): Promise<MemberRow> {
    const now = this.now();
    const tierId = await this.resolveTier(input.status, input.tierId);
    let row: MemberRow | undefined;
    try {
      [row] = await this.db
        .insert(members)
        .values({
          siteId: this.siteId,
          userId: opts.userId ?? null,
          email: input.email,
          emailLower: normalizeEmail(input.email),
          name: input.name ?? null,
          status: input.status,
          tierId,
          tierExpiresAt: input.tierExpiresAt ? new Date(input.tierExpiresAt) : null,
          labels: [...new Set(input.labels)],
          note: input.note ?? null,
          source: opts.source ?? 'admin',
          emailVerifiedAt: opts.emailVerified ? now : null,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new MemberError('MEMBER_EXISTS', 409, 'A member with this email already exists.');
      throw err;
    }
    const member = row!;
    const wanted = input.newsletterIds ?? (await this.defaultNewsletterIds());
    await this.replaceNewsletters(member, wanted);
    await syncMemberTierPolicy(this.db, this.siteId, member, now);
    await this.emit('member.created', member, 'create');
    return member;
  }

  async update(id: string, patch: Partial<z.output<typeof memberUpdateSchema>>): Promise<{ row: MemberRow; accessChanged: boolean }> {
    const current = await this.getRow(id);
    const status = (patch.status ?? current.status) as MemberStatus;
    const tierTouched = patch.status !== undefined || patch.tierId !== undefined;
    const tierId = tierTouched
      ? await this.resolveTier(status, patch.tierId !== undefined ? patch.tierId : status === current.status ? current.tierId : null)
      : current.tierId;

    const set: Partial<typeof members.$inferInsert> = { updatedAt: this.now() };
    if (patch.email !== undefined && normalizeEmail(patch.email) !== current.emailLower) {
      if (current.userId) {
        throw new MemberError('EMAIL_LOCKED', 409, 'This member signs in with their email; it can only change through their account.');
      }
      set.email = patch.email;
      set.emailLower = normalizeEmail(patch.email);
      set.emailVerifiedAt = null;
    }
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.labels !== undefined) set.labels = [...new Set(patch.labels)];
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.tierExpiresAt !== undefined) set.tierExpiresAt = patch.tierExpiresAt ? new Date(patch.tierExpiresAt) : null;
    if (tierTouched) {
      set.status = status;
      set.tierId = tierId;
    }
    let row: MemberRow | undefined;
    try {
      [row] = await this.db
        .update(members)
        .set(set)
        .where(and(eq(members.siteId, this.siteId), eq(members.id, id)))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new MemberError('MEMBER_EXISTS', 409, 'A member with this email already exists.');
      throw err;
    }
    const member = row!;
    if (patch.newsletterIds !== undefined) await this.replaceNewsletters(member, patch.newsletterIds);
    const accessChanged = await syncMemberTierPolicy(this.db, this.siteId, member, this.now());
    if (member.tierId !== current.tierId || member.status !== current.status) {
      // Paid-only newsletters follow the status down.
      if (member.status === 'free') await this.dropPaidNewsletters(member.id);
      await this.emit('member.tier_changed', member, 'update', { previousStatus: current.status, previousTierId: current.tierId });
    }
    return { row: member, accessChanged };
  }

  async delete(id: string): Promise<{ accessChanged: boolean }> {
    const current = await this.getRow(id);
    await this.db.delete(members).where(and(eq(members.siteId, this.siteId), eq(members.id, id)));
    const accessChanged = await syncMemberTierPolicy(this.db, this.siteId, { userId: current.userId, tierId: null, tierExpiresAt: null });
    await this.emit('member.deleted', current, 'delete');
    return { accessChanged };
  }

  /** Link a subscriber account to the member and attach the tier policy. */
  async linkUser(member: MemberRow, userId: string): Promise<{ row: MemberRow; accessChanged: boolean }> {
    const now = this.now();
    const [row] = await this.db
      .update(members)
      .set({ userId, emailVerifiedAt: member.emailVerifiedAt ?? now, lastSeenAt: now, updatedAt: now })
      .where(and(eq(members.siteId, this.siteId), eq(members.id, member.id)))
      .returning();
    const accessChanged = await syncMemberTierPolicy(this.db, this.siteId, row!, now);
    return { row: row!, accessChanged };
  }

  async touch(memberId: string): Promise<void> {
    await this.db
      .update(members)
      .set({ lastSeenAt: this.now() })
      .where(and(eq(members.siteId, this.siteId), eq(members.id, memberId)));
  }

  // ── Newsletter toggles ─────────────────────────────────────────────────

  async replaceNewsletters(member: Pick<MemberRow, 'id' | 'status'>, ids: readonly string[]): Promise<void> {
    const allowed = await this.allowedNewsletterIds([...new Set(ids)], member.status as MemberStatus);
    await this.db
      .delete(memberNewsletters)
      .where(and(eq(memberNewsletters.siteId, this.siteId), eq(memberNewsletters.memberId, member.id)));
    if (allowed.length) {
      await this.db
        .insert(memberNewsletters)
        .values(allowed.map((newsletterId) => ({ siteId: this.siteId, memberId: member.id, newsletterId })))
        .onConflictDoNothing();
    }
  }

  async setNewsletter(memberId: string, newsletterId: string, subscribed: boolean): Promise<void> {
    const member = await this.getRow(memberId);
    if (subscribed) {
      const allowed = await this.allowedNewsletterIds([newsletterId], member.status as MemberStatus);
      if (allowed.length === 0) throw new MemberError('NEWSLETTER_NOT_AVAILABLE', 400, 'This newsletter is not available to this member.');
      await this.db
        .insert(memberNewsletters)
        .values({ siteId: this.siteId, memberId, newsletterId })
        .onConflictDoNothing();
      return;
    }
    await this.db
      .delete(memberNewsletters)
      .where(
        and(
          eq(memberNewsletters.siteId, this.siteId),
          eq(memberNewsletters.memberId, memberId),
          eq(memberNewsletters.newsletterId, newsletterId),
        ),
      );
  }

  /**
   * Opt the member out of all member mail: drop every newsletter and stop
   * every running sequence. Used by the one-click unsubscribe and the
   * "unsubscribe from everything" toggle in the Portal.
   */
  async unsubscribeAll(memberId: string, reason: string): Promise<void> {
    const member = await this.getRow(memberId);
    await this.db
      .delete(memberNewsletters)
      .where(and(eq(memberNewsletters.siteId, this.siteId), eq(memberNewsletters.memberId, memberId)));
    await stopEnrollments(this.db, this.siteId, memberId, reason);
    await this.emit('member.unsubscribed', member, 'update', { reason });
  }

  private async dropPaidNewsletters(memberId: string): Promise<void> {
    const paid = await this.db
      .select({ id: newsletters.id })
      .from(newsletters)
      .where(and(eq(newsletters.siteId, this.siteId), eq(newsletters.audience, 'paid')));
    if (paid.length === 0) return;
    await this.db.delete(memberNewsletters).where(
      and(
        eq(memberNewsletters.siteId, this.siteId),
        eq(memberNewsletters.memberId, memberId),
        inArray(
          memberNewsletters.newsletterId,
          paid.map((p) => p.id),
        ),
      ),
    );
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private async emit(
    event: MemberEventName,
    member: MemberRow,
    action: 'create' | 'update' | 'delete',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (event === 'member.created' || event === 'member.tier_changed') {
      const tierKey = member.tierId
        ? (
            await this.db
              .select({ key: memberTiers.key })
              .from(memberTiers)
              .where(and(eq(memberTiers.siteId, this.siteId), eq(memberTiers.id, member.tierId)))
              .limit(1)
          )[0]?.key ?? null
        : null;
      await enrollForTrigger(this.db, this.siteId, member.id, event, { tierKey, status: member.status }, this.now());
    }
    if (this.deps.queue) {
      await dispatchItemEvent(
        { db: this.db, siteId: this.siteId, queue: this.deps.queue },
        {
          collection: MEMBERS_FLOW_COLLECTION,
          action,
          itemId: member.id,
          payload: {
            event,
            memberId: member.id,
            email: member.email,
            name: member.name,
            status: member.status,
            tierId: member.tierId,
            labels: asLabels(member.labels),
            ...extra,
          },
        },
      );
    }
  }
}
