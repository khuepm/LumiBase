/**
 * Automated email sequences (#720, epic #672 N04): welcome / onboarding /
 * win-back.
 *
 * The Flow engine runs a graph synchronously (its `sleep` caps at 60 s), so a
 * sequence spaced over days cannot be one flow run. A sequence is therefore a
 * durable, per-member state machine: the definition holds ordered steps
 * (`delayMinutes` after the previous step, then a message), an enrolment row
 * holds the member's position and `next_run_at`, and the members tick sends
 * whatever is due. Flows still drive it:
 *   - member events reach event-triggered Flows (collection `lumibase_members`),
 *   - the `members:enroll` Flow operation enrols a member into a sequence, so a
 *     flow can branch first and enrol second;
 *   - the built-in templates are shipped as starting points (welcome,
 *     onboarding, win-back) the same way automation templates are.
 *
 * Enrolment stops — and no further step is sent — when the member
 * unsubscribes from member mail (Portal toggle or one-click link), is on the
 * site suppression list, or is deleted; it also stops if the sequence is
 * paused or deleted. Enrolment is unique per (sequence, member), so a trigger
 * firing twice cannot start the same sequence twice.
 */

import { z } from 'zod';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  emailSequences,
  members,
  sequenceEnrollments,
  type Database,
} from '@lumibase/database';
import { MemberError, isUniqueViolation } from './errors';
import type { MemberMailer } from './mailer';
import { getSegmentRow, parseSegmentFilter, segmentWhere } from './segments';

export const SEQUENCE_TRIGGERS = ['member.created', 'member.tier_changed', 'segment', 'manual'] as const;
export type SequenceTrigger = (typeof SEQUENCE_TRIGGERS)[number];

const MAX_STEPS = 20;
const LEASE_MS = 120_000;

export const sequenceStepSchema = z.object({
  /** Minutes after enrolment (first step) or after the previous step. */
  delayMinutes: z.number().int().min(0).max(525_600),
  subject: z.string().trim().min(1).max(300),
  html: z.string().min(1).max(200_000),
  text: z.string().max(100_000).nullable().optional(),
});
export type SequenceStep = z.output<typeof sequenceStepSchema>;

export const sequenceInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/),
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(SEQUENCE_TRIGGERS),
  triggerOptions: z
    .object({
      /** `member.created`: only members with these statuses. */
      statuses: z.array(z.enum(['free', 'paid', 'comped'])).optional(),
      /** `member.tier_changed`: only when the new tier has this key. */
      tierKey: z.string().max(64).optional(),
      /** `segment`: enrol members as they enter this saved segment. */
      segmentId: z.string().max(64).optional(),
      /** Sender for every step; must sit on a verified sending domain to be DKIM-signed. */
      fromEmail: z.string().email().optional(),
      fromName: z.string().max(100).optional(),
    })
    .strict()
    .default({}),
  steps: z.array(sequenceStepSchema).min(1).max(MAX_STEPS),
  status: z.enum(['draft', 'active', 'paused']).default('draft'),
  templateKey: z.string().max(64).nullable().optional(),
});
export type SequenceInput = z.output<typeof sequenceInputSchema>;
type SequenceRow = typeof emailSequences.$inferSelect;
type TriggerOptions = SequenceInput['triggerOptions'];

// ── Templates ─────────────────────────────────────────────────────────────

export interface SequenceTemplate {
  key: string;
  name: string;
  description: string;
  sequence: Omit<SequenceInput, 'status' | 'templateKey'>;
}

const DAY = 24 * 60;

export const SEQUENCE_TEMPLATES: readonly SequenceTemplate[] = [
  {
    key: 'welcome',
    name: 'Welcome series',
    description: 'Three emails over the first week for every new member.',
    sequence: {
      key: 'welcome',
      name: 'Welcome series',
      trigger: 'member.created',
      triggerOptions: {},
      steps: [
        { delayMinutes: 0, subject: 'Welcome, {{member.first_name}}!', html: '<p>Hi {{member.first_name}},</p><p>Thanks for joining. Here is what to expect from us.</p>' },
        { delayMinutes: 2 * DAY, subject: 'Our most-read stories', html: '<p>A few of the pieces readers like best to get you started.</p>' },
        { delayMinutes: 5 * DAY, subject: 'Tell us what you want to read', html: '<p>Reply to this email and tell us what you would like more of.</p>' },
      ],
    },
  },
  {
    key: 'onboarding',
    name: 'Paid onboarding',
    description: 'Two emails when a member moves to a paid tier.',
    sequence: {
      key: 'paid-onboarding',
      name: 'Paid onboarding',
      trigger: 'member.tier_changed',
      triggerOptions: { statuses: ['paid', 'comped'] },
      steps: [
        { delayMinutes: 0, subject: 'Your membership is active', html: '<p>Thank you for supporting us, {{member.first_name}}. Everything for members is now unlocked.</p>' },
        { delayMinutes: 3 * DAY, subject: 'Getting the most from your membership', html: '<p>Here is how to manage newsletters and your account from the member portal.</p>' },
      ],
    },
  },
  {
    key: 'win-back',
    name: 'Win-back',
    description: 'Reach members who have not opened an email in 60 days. Enrols as members enter the segment.',
    sequence: {
      key: 'win-back',
      name: 'Win-back',
      trigger: 'segment',
      triggerOptions: {},
      steps: [
        { delayMinutes: 0, subject: 'We miss you, {{member.first_name}}', html: '<p>It has been a while. Here is what you missed.</p>' },
        { delayMinutes: 7 * DAY, subject: 'Still interested?', html: '<p>If these emails are not for you any more, you can <a href="{{unsubscribe_url}}">unsubscribe</a> in one click.</p>' },
      ],
    },
  },
];

// ── CRUD ──────────────────────────────────────────────────────────────────

async function validateTrigger(db: Database, siteId: string, trigger: SequenceTrigger, options: TriggerOptions): Promise<void> {
  if (trigger === 'segment') {
    if (!options.segmentId) throw new MemberError('VALIDATION', 400, 'A segment-triggered sequence needs triggerOptions.segmentId.');
    await getSegmentRow(db, siteId, options.segmentId);
  }
}

export async function listSequences(db: Database, siteId: string) {
  const rows = await db.select().from(emailSequences).where(eq(emailSequences.siteId, siteId)).orderBy(asc(emailSequences.name));
  const stats = rows.length
    ? await db
        .select({ sequenceId: sequenceEnrollments.sequenceId, status: sequenceEnrollments.status, n: sql<number>`count(*)::int` })
        .from(sequenceEnrollments)
        .where(and(eq(sequenceEnrollments.siteId, siteId), inArray(sequenceEnrollments.sequenceId, rows.map((r) => r.id))))
        .groupBy(sequenceEnrollments.sequenceId, sequenceEnrollments.status)
    : [];
  return rows.map((r) => ({
    ...r,
    enrollments: Object.fromEntries(stats.filter((s) => s.sequenceId === r.id).map((s) => [s.status, s.n])) as Record<string, number>,
  }));
}

export async function getSequence(db: Database, siteId: string, id: string): Promise<SequenceRow> {
  const [row] = await db
    .select()
    .from(emailSequences)
    .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Sequence not found.');
  return row;
}

export async function createSequence(db: Database, siteId: string, input: SequenceInput): Promise<SequenceRow> {
  await validateTrigger(db, siteId, input.trigger, input.triggerOptions);
  try {
    const [row] = await db
      .insert(emailSequences)
      .values({
        siteId,
        key: input.key,
        name: input.name,
        trigger: input.trigger,
        triggerOptions: input.triggerOptions,
        steps: input.steps,
        status: input.status,
        templateKey: input.templateKey ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('SEQUENCE_KEY_TAKEN', 409, `Sequence key "${input.key}" already exists.`);
    throw err;
  }
}

export async function updateSequence(db: Database, siteId: string, id: string, patch: Partial<SequenceInput>): Promise<SequenceRow> {
  const current = await getSequence(db, siteId, id);
  const trigger = (patch.trigger ?? current.trigger) as SequenceTrigger;
  const options = (patch.triggerOptions ?? current.triggerOptions) as TriggerOptions;
  await validateTrigger(db, siteId, trigger, options);
  const set: Partial<typeof emailSequences.$inferInsert> = { updatedAt: new Date() };
  if (patch.key !== undefined) set.key = patch.key;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.trigger !== undefined) set.trigger = patch.trigger;
  if (patch.triggerOptions !== undefined) set.triggerOptions = patch.triggerOptions;
  if (patch.steps !== undefined) set.steps = patch.steps;
  if (patch.status !== undefined) set.status = patch.status;
  try {
    const [row] = await db
      .update(emailSequences)
      .set(set)
      .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.id, id)))
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('SEQUENCE_KEY_TAKEN', 409, 'Sequence key already exists.');
    throw err;
  }
}

export async function deleteSequence(db: Database, siteId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(emailSequences)
    .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.id, id)))
    .returning({ id: emailSequences.id });
  if (deleted.length === 0) throw new MemberError('NOT_FOUND', 404, 'Sequence not found.');
}

export async function createSequenceFromTemplate(
  db: Database,
  siteId: string,
  templateKey: string,
  overrides: { key?: string; segmentId?: string; fromEmail?: string; fromName?: string },
): Promise<SequenceRow> {
  const tpl = SEQUENCE_TEMPLATES.find((t) => t.key === templateKey);
  if (!tpl) throw new MemberError('NOT_FOUND', 404, `Unknown sequence template "${templateKey}".`);
  const triggerOptions: TriggerOptions = {
    ...tpl.sequence.triggerOptions,
    ...(overrides.segmentId ? { segmentId: overrides.segmentId } : {}),
    ...(overrides.fromEmail ? { fromEmail: overrides.fromEmail } : {}),
    ...(overrides.fromName ? { fromName: overrides.fromName } : {}),
  };
  // Draft: an operator reviews the copy before turning it on.
  return createSequence(db, siteId, {
    ...tpl.sequence,
    key: overrides.key ?? tpl.sequence.key,
    triggerOptions,
    status: 'draft',
    templateKey: tpl.key,
  });
}

// ── Enrolment ─────────────────────────────────────────────────────────────

function stepsOf(row: SequenceRow): SequenceStep[] {
  return Array.isArray(row.steps) ? (row.steps as SequenceStep[]) : [];
}

export async function enroll(
  db: Database,
  siteId: string,
  sequence: SequenceRow,
  memberId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const steps = stepsOf(sequence);
  if (steps.length === 0) return false;
  const inserted = await db
    .insert(sequenceEnrollments)
    .values({
      siteId,
      sequenceId: sequence.id,
      memberId,
      stepIndex: 0,
      status: 'active',
      nextRunAt: new Date(now.getTime() + steps[0]!.delayMinutes * 60_000),
    })
    .onConflictDoNothing()
    .returning({ id: sequenceEnrollments.id });
  return inserted.length > 0;
}

/** Enrol a member by sequence id (manual / Flow operation). */
export async function enrollMember(db: Database, siteId: string, sequenceId: string, memberId: string, now?: Date): Promise<boolean> {
  const seq = await getSequence(db, siteId, sequenceId);
  if (seq.status !== 'active') throw new MemberError('SEQUENCE_NOT_ACTIVE', 409, 'Activate the sequence before enrolling members.');
  const [m] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.siteId, siteId), eq(members.id, memberId)))
    .limit(1);
  if (!m) throw new MemberError('NOT_FOUND', 404, 'Member not found.');
  return enroll(db, siteId, seq, memberId, now);
}

/** Flow operation entry (`members:enroll`): resolve the sequence by key. */
export async function enrollMemberByKey(db: Database, siteId: string, sequenceKey: string, memberId: string, now?: Date): Promise<boolean> {
  const [seq] = await db
    .select({ id: emailSequences.id })
    .from(emailSequences)
    .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.key, sequenceKey)))
    .limit(1);
  if (!seq) throw new MemberError('NOT_FOUND', 404, `Sequence "${sequenceKey}" not found.`);
  return enrollMember(db, siteId, seq.id, memberId, now);
}

/** Enrol a member into every active sequence whose trigger matches an event. */
export async function enrollForTrigger(
  db: Database,
  siteId: string,
  memberId: string,
  event: 'member.created' | 'member.tier_changed',
  ctx: { tierKey: string | null; status: string },
  now: Date = new Date(),
): Promise<number> {
  const seqs = await db
    .select()
    .from(emailSequences)
    .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.status, 'active'), eq(emailSequences.trigger, event)));
  let n = 0;
  for (const s of seqs) {
    const opts = (s.triggerOptions ?? {}) as TriggerOptions;
    if (opts.statuses && opts.statuses.length > 0 && !opts.statuses.includes(ctx.status as 'free')) continue;
    if (event === 'member.tier_changed' && opts.tierKey && opts.tierKey !== ctx.tierKey) continue;
    if (await enroll(db, siteId, s, memberId, now)) n += 1;
  }
  return n;
}

export async function stopEnrollments(db: Database, siteId: string, memberId: string, reason: string): Promise<number> {
  const stopped = await db
    .update(sequenceEnrollments)
    .set({ status: 'stopped', stoppedReason: reason, nextRunAt: null, updatedAt: new Date() })
    .where(and(eq(sequenceEnrollments.siteId, siteId), eq(sequenceEnrollments.memberId, memberId), eq(sequenceEnrollments.status, 'active')))
    .returning({ id: sequenceEnrollments.id });
  return stopped.length;
}

export async function listEnrollments(db: Database, siteId: string, sequenceId: string, limit = 100) {
  return db
    .select({
      id: sequenceEnrollments.id,
      memberId: sequenceEnrollments.memberId,
      email: members.email,
      stepIndex: sequenceEnrollments.stepIndex,
      status: sequenceEnrollments.status,
      stoppedReason: sequenceEnrollments.stoppedReason,
      nextRunAt: sequenceEnrollments.nextRunAt,
      lastError: sequenceEnrollments.lastError,
      createdAt: sequenceEnrollments.createdAt,
    })
    .from(sequenceEnrollments)
    .innerJoin(members, eq(members.id, sequenceEnrollments.memberId))
    .where(and(eq(sequenceEnrollments.siteId, siteId), eq(sequenceEnrollments.sequenceId, sequenceId)))
    .orderBy(asc(sequenceEnrollments.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

// ── Tick ──────────────────────────────────────────────────────────────────

/** Enrol members who entered the segment of each active segment-triggered sequence. */
export async function enrollSegmentSequences(db: Database, now: Date = new Date(), perSequence = 500): Promise<number> {
  const seqs = await db
    .select()
    .from(emailSequences)
    .where(and(eq(emailSequences.status, 'active'), eq(emailSequences.trigger, 'segment')))
    .limit(200);
  let n = 0;
  for (const s of seqs) {
    const opts = (s.triggerOptions ?? {}) as TriggerOptions;
    if (!opts.segmentId) continue;
    let filter;
    try {
      filter = parseSegmentFilter((await getSegmentRow(db, s.siteId, opts.segmentId)).filter);
    } catch {
      continue; // segment deleted or invalid: nothing to enrol
    }
    const already = sql`NOT EXISTS (SELECT 1 FROM ${sequenceEnrollments} WHERE ${sequenceEnrollments.sequenceId} = ${s.id} AND ${sequenceEnrollments.memberId} = ${members.id})`;
    const fresh = await db
      .select({ id: members.id })
      .from(members)
      .where(and(segmentWhere(s.siteId, filter, now), already))
      .limit(perSequence);
    for (const m of fresh) if (await enroll(db, s.siteId, s, m.id, now)) n += 1;
  }
  return n;
}

export interface SequenceTickDeps {
  db: Database;
  /** Mailer for a site; null when email is not configured. */
  mailerFor: (siteId: string) => MemberMailer | null;
  linkBase: string | null;
}

/**
 * Send every due step. Each enrolment is claimed with a short lease by a
 * conditional UPDATE, so overlapping ticks cannot send the same step twice.
 */
export async function runSequenceTick(
  deps: SequenceTickDeps,
  opts: { now?: Date; limit?: number; budgetMs?: number } = {},
): Promise<{ sent: number; completed: number; stopped: number; failed: number }> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  const out = { sent: 0, completed: 0, stopped: 0, failed: 0 };
  const { db } = deps;
  const due = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .innerJoin(emailSequences, eq(emailSequences.id, sequenceEnrollments.sequenceId))
    .where(
      and(
        eq(sequenceEnrollments.status, 'active'),
        eq(emailSequences.status, 'active'),
        lte(sequenceEnrollments.nextRunAt, now),
        or(isNull(sequenceEnrollments.leaseUntil), lt(sequenceEnrollments.leaseUntil, now)),
      ),
    )
    .orderBy(asc(sequenceEnrollments.nextRunAt))
    .limit(opts.limit ?? 200);

  for (const { id } of due) {
    if (Date.now() > deadline) break;
    const [claimed] = await db
      .update(sequenceEnrollments)
      .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(
        and(
          eq(sequenceEnrollments.id, id),
          eq(sequenceEnrollments.status, 'active'),
          or(isNull(sequenceEnrollments.leaseUntil), lt(sequenceEnrollments.leaseUntil, now)),
        ),
      )
      .returning();
    if (!claimed) continue;
    const siteId = claimed.siteId;
    const release = (set: Partial<typeof sequenceEnrollments.$inferInsert>) =>
      db
        .update(sequenceEnrollments)
        .set({ ...set, leaseUntil: null, updatedAt: now })
        .where(and(eq(sequenceEnrollments.siteId, siteId), eq(sequenceEnrollments.id, id)));

    const [seq] = await db
      .select()
      .from(emailSequences)
      .where(and(eq(emailSequences.siteId, siteId), eq(emailSequences.id, claimed.sequenceId)))
      .limit(1);
    const [member] = await db
      .select({ id: members.id, email: members.email, name: members.name })
      .from(members)
      .where(and(eq(members.siteId, siteId), eq(members.id, claimed.memberId)))
      .limit(1);
    const steps = seq ? stepsOf(seq) : [];
    const step = steps[claimed.stepIndex];
    // Unsubscribing stops enrolments at once (`stopEnrollments`); a suppressed
    // address is caught by the mailer below.
    if (!seq || !member || !step) {
      await release({ status: 'stopped', stoppedReason: !member ? 'member_deleted' : 'sequence_changed', nextRunAt: null });
      out.stopped += 1;
      continue;
    }
    const mailer = deps.mailerFor(siteId);
    if (!mailer || !deps.linkBase) {
      await release({ lastError: !mailer ? 'email not configured' : 'LUMIBASE_PUBLIC_URL is not set' });
      out.failed += 1;
      continue;
    }
    const opts2 = (seq.triggerOptions ?? {}) as TriggerOptions;
    const result = await mailer.send({
      member,
      subject: step.subject,
      html: step.html,
      text: step.text ?? null,
      from: opts2.fromEmail ?? null,
      fromName: opts2.fromName ?? null,
      linkBase: deps.linkBase,
    });
    if (result.status === 'suppressed') {
      await release({ status: 'stopped', stoppedReason: 'suppressed', nextRunAt: null });
      out.stopped += 1;
      continue;
    }
    if (result.status !== 'sent') {
      const error = result.status === 'failed' ? result.error : 'email not configured';
      // Retry on the next tick; the lease release makes it claimable again.
      await release({ lastError: error.slice(0, 500), nextRunAt: new Date(now.getTime() + 15 * 60_000) });
      out.failed += 1;
      continue;
    }
    await db
      .update(members)
      .set({ emailCount: sql`${members.emailCount} + 1` })
      .where(and(eq(members.siteId, siteId), eq(members.id, member.id)));
    out.sent += 1;
    const nextIndex = claimed.stepIndex + 1;
    const next = steps[nextIndex];
    if (!next) {
      await release({ status: 'completed', stepIndex: nextIndex, nextRunAt: null, lastError: null });
      out.completed += 1;
    } else {
      await release({ stepIndex: nextIndex, nextRunAt: new Date(now.getTime() + next.delayMinutes * 60_000), lastError: null });
    }
  }
  return out;
}
