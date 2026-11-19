/**
 * Newsletters as a channel (#719, epic #672 N03).
 *
 * A newsletter is a list members toggle on and off. An issue ("send") is one
 * item rendered once and mailed to the newsletter's subscribers — optionally
 * narrowed by a saved segment — through {@link MemberMailer}, so suppression,
 * one-click unsubscribe (RFC 8058), DKIM and opt-in tracking all apply.
 *
 * Sending follows the import-job pattern: the send row holds a keyset cursor
 * (last member id) and counters; a step claims a short lease, takes the next
 * chunk, records one `newsletter_deliveries` row per recipient BEFORE mailing
 * (the primary key makes the claim exactly-once per member), mails, and marks
 * each row. The creating request drives the first chunks; the members tick
 * resumes whatever is left, so a 10k-member list finishes across ticks
 * without holding a request open. A crash between "claimed" and "sent" leaves
 * `pending` rows, which the next step retries (at-least-once for that window,
 * never a full resend).
 *
 * The audience is frozen when the send is created: the segment filter is
 * copied into the row, so editing the segment mid-send does not change who
 * the remaining chunks reach. Membership of the newsletter itself is read
 * live, so a member who unsubscribes mid-send is skipped.
 *
 * A send is unique per (newsletter, collection, item): the same post cannot
 * be mailed twice by a double click or a retried request.
 */

import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  emailLayouts,
  memberNewsletters,
  members,
  newsletterDeliveries,
  newsletterSends,
  newsletters,
  type Database,
} from '@lumibase/database';
import { isRichTextDocument, richTextToHtml, richTextToPlainText } from '@lumibase/contracts/richtext';
import { MemberError, isUniqueViolation } from './errors';
import type { MemberMailer } from './mailer';
import { getSegmentRow, parseSegmentFilter, segmentWhere, type SegmentFilter } from './segments';
import { findDomainForSender } from './sending-domains';

export const NEWSLETTER_CHUNK = 100;
const LEASE_MS = 120_000;
const ACTIVE = ['queued', 'sending'] as const;

export const newsletterInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  senderName: z.string().trim().max(100).nullable().optional(),
  senderEmail: z.string().trim().toLowerCase().email().nullable().optional(),
  replyTo: z.string().trim().email().nullable().optional(),
  status: z.enum(['active', 'archived']).default('active'),
  audience: z.enum(['members', 'paid']).default('members'),
  subscribeOnSignup: z.boolean().default(true),
  trackOpens: z.boolean().default(false),
  trackClicks: z.boolean().default(false),
  layoutKey: z.string().max(64).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type NewsletterInput = z.output<typeof newsletterInputSchema>;
type NewsletterRow = typeof newsletters.$inferSelect;
type SendRow = typeof newsletterSends.$inferSelect;

export interface SendCounters {
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  clicked: number;
}

function countersOf(row: SendRow): SendCounters {
  const c = (row.counters ?? {}) as Partial<SendCounters>;
  return {
    recipients: c.recipients ?? 0,
    sent: c.sent ?? 0,
    failed: c.failed ?? 0,
    skipped: c.skipped ?? 0,
    opened: c.opened ?? 0,
    clicked: c.clicked ?? 0,
  };
}

export function toSendView(row: SendRow) {
  const counters = countersOf(row);
  return {
    id: row.id,
    newsletterId: row.newsletterId,
    collection: row.collection,
    itemId: row.itemId,
    segmentId: row.segmentId,
    subject: row.subject,
    status: row.status,
    counters,
    openRate: counters.sent > 0 ? Math.round((counters.opened * 1000) / counters.sent) / 10 : null,
    clickRate: counters.sent > 0 ? Math.round((counters.clicked * 1000) / counters.sent) / 10 : null,
    message: row.message,
    createdBy: row.createdBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

// ── Newsletter CRUD ───────────────────────────────────────────────────────

export async function listNewsletters(db: Database, siteId: string) {
  const rows = await db.select().from(newsletters).where(eq(newsletters.siteId, siteId)).orderBy(asc(newsletters.sortOrder), asc(newsletters.name));
  const counts = rows.length
    ? await db
        .select({ newsletterId: memberNewsletters.newsletterId, n: sql<number>`count(*)::int` })
        .from(memberNewsletters)
        .where(eq(memberNewsletters.siteId, siteId))
        .groupBy(memberNewsletters.newsletterId)
    : [];
  return rows.map((r) => ({ ...r, subscriberCount: counts.find((c) => c.newsletterId === r.id)?.n ?? 0 }));
}

export async function getNewsletter(db: Database, siteId: string, id: string): Promise<NewsletterRow> {
  const [row] = await db
    .select()
    .from(newsletters)
    .where(and(eq(newsletters.siteId, siteId), eq(newsletters.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Newsletter not found.');
  return row;
}

export async function createNewsletter(db: Database, siteId: string, input: NewsletterInput): Promise<NewsletterRow> {
  try {
    const [row] = await db
      .insert(newsletters)
      .values({
        siteId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        senderName: input.senderName ?? null,
        senderEmail: input.senderEmail ?? null,
        replyTo: input.replyTo ?? null,
        status: input.status,
        audience: input.audience,
        subscribeOnSignup: input.subscribeOnSignup,
        trackOpens: input.trackOpens,
        trackClicks: input.trackClicks,
        layoutKey: input.layoutKey ?? null,
        sortOrder: input.sortOrder,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('NEWSLETTER_KEY_TAKEN', 409, `Newsletter key "${input.key}" already exists.`);
    throw err;
  }
}

export async function updateNewsletter(db: Database, siteId: string, id: string, patch: Partial<NewsletterInput>): Promise<NewsletterRow> {
  await getNewsletter(db, siteId, id);
  try {
    const [row] = await db
      .update(newsletters)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(newsletters.siteId, siteId), eq(newsletters.id, id)))
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('NEWSLETTER_KEY_TAKEN', 409, 'Newsletter key already exists.');
    throw err;
  }
}

/** Archive instead of delete when issues exist (keeps send history). */
export async function deleteNewsletter(db: Database, siteId: string, id: string): Promise<'deleted' | 'archived'> {
  await getNewsletter(db, siteId, id);
  const [sent] = await db
    .select({ id: newsletterSends.id })
    .from(newsletterSends)
    .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.newsletterId, id)))
    .limit(1);
  if (sent) {
    await db.update(newsletters).set({ status: 'archived', updatedAt: new Date() }).where(and(eq(newsletters.siteId, siteId), eq(newsletters.id, id)));
    return 'archived';
  }
  await db.delete(newsletters).where(and(eq(newsletters.siteId, siteId), eq(newsletters.id, id)));
  return 'deleted';
}

// ── Compose from an item ──────────────────────────────────────────────────

export const composeOptionsSchema = z.object({
  subjectField: z.string().max(64).default('title'),
  bodyField: z.string().max(64).default('content'),
  excerptField: z.string().max(64).optional(),
  locale: z.string().max(20).optional(),
  subject: z.string().trim().max(300).optional(),
});
export type ComposeOptions = z.output<typeof composeOptionsSchema>;

/**
 * Allowlist sanitizer for item HTML going into email. It does not remove
 * patterns from the input (removal can splice a new tag together); it walks
 * the tags and REBUILDS the output: allowed tags are re-emitted with only
 * allowed attributes and escaped values, anything else is escaped to text.
 * Contents of `<script>`/`<style>` and similar are dropped with their tags.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'form']);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'align', 'class', 'id', 'name', 'target', 'rel', 'lang', 'dir']);
const URL_ATTRS = new Set(['href', 'src']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** href: http(s) / mailto only; src: https only. Anything else (incl. entity-encoded `javascript:`) is dropped. */
function safeUrl(attr: string, value: string): string | null {
  const v = value.trim();
  if (attr === 'src') return /^https:\/\//i.test(v) ? v : null;
  return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
}

function escapeText(s: string): string {
  return s.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rebuildAttrs(raw: string): string {
  let out = '';
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) continue;
    let value = m[2] ?? m[3] ?? m[4] ?? '';
    if (URL_ATTRS.has(name)) {
      const url = safeUrl(name, value);
      if (url === null) continue;
      value = url;
    }
    out += ` ${name}="${value.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`;
  }
  return out;
}

export function sanitizeEmailHtml(html: string): string {
  let out = '';
  let last = 0;
  let dropUntil: string | null = null;
  for (const m of html.matchAll(TAG_RE)) {
    const index = m.index ?? 0;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (dropUntil) {
      if (closing && tag === dropUntil) {
        dropUntil = null;
        last = index + m[0].length;
      }
      continue;
    }
    out += escapeText(html.slice(last, index));
    last = index + m[0].length;
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && m[4] !== '/') dropUntil = tag;
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
    } else {
      out += `<${tag}${rebuildAttrs(m[3] ?? '')}${VOID_TAGS.has(tag) ? ' /' : ''}>`;
    }
  }
  if (!dropUntil) out += escapeText(html.slice(last));
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A field value as text: strings as-is, translatable maps by locale (then first value). */
export function pickText(value: unknown, locale?: string): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    if (locale && typeof map[locale] === 'string') return map[locale] as string;
    const first = Object.values(map).find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : null;
  }
  return null;
}

export function composeFromItem(
  item: { id: string; data: Record<string, unknown> },
  opts: ComposeOptions,
): { subject: string; html: string; text: string | null; vars: Record<string, string> } {
  const subject = opts.subject || pickText(item.data[opts.subjectField], opts.locale);
  if (!subject) throw new MemberError('COMPOSE_NO_SUBJECT', 400, `Item has no text in "${opts.subjectField}"; pass a subject.`);
  const rawBody = item.data[opts.bodyField];
  const localized =
    rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && !isRichTextDocument(rawBody) && opts.locale
      ? (rawBody as Record<string, unknown>)[opts.locale]
      : rawBody;
  const excerpt = opts.excerptField ? pickText(item.data[opts.excerptField], opts.locale) : null;
  const header = `<h1>${escapeHtml(subject)}</h1>${excerpt ? `<p><em>${escapeHtml(excerpt)}</em></p>` : ''}`;
  if (isRichTextDocument(localized)) {
    // Structured rich text (#669 model): the serializer escapes text and drops unsafe URLs.
    return {
      subject: subject.slice(0, 300),
      html: header + richTextToHtml(localized),
      text: richTextToPlainText(localized),
      vars: { 'post.title': subject, 'post.id': item.id },
    };
  }
  const body = pickText(rawBody, opts.locale);
  if (!body) throw new MemberError('COMPOSE_NO_BODY', 400, `Item has no HTML/text in "${opts.bodyField}".`);
  const looksHtml = /<[a-z][\s\S]*>/i.test(body);
  const html = looksHtml ? sanitizeEmailHtml(body) : body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  return {
    subject: subject.slice(0, 300),
    html: header + html,
    text: looksHtml ? null : body,
    vars: { 'post.title': subject, 'post.id': item.id },
  };
}

// ── Sends ─────────────────────────────────────────────────────────────────

function audienceWhere(siteId: string, newsletter: NewsletterRow, filter: SegmentFilter | null, now: Date): SQL {
  const subscribed = sql`EXISTS (SELECT 1 FROM ${memberNewsletters} WHERE ${memberNewsletters.memberId} = ${members.id} AND ${memberNewsletters.siteId} = ${siteId} AND ${memberNewsletters.newsletterId} = ${newsletter.id})`;
  const parts: SQL[] = [segmentWhere(siteId, filter ?? { match: 'all', conditions: [] }, now), subscribed];
  if (newsletter.audience === 'paid') parts.push(inArray(members.status, ['paid', 'comped']));
  return and(...parts)!;
}

export async function countAudience(db: Database, siteId: string, newsletter: NewsletterRow, filter: SegmentFilter | null, now = new Date()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(audienceWhere(siteId, newsletter, filter, now));
  return row?.n ?? 0;
}

export interface CreateSendInput {
  newsletterId: string;
  collection: string;
  itemId: string;
  segmentId?: string | null;
  composed: { subject: string; html: string; text: string | null };
  linkBase: string;
}

export async function createSend(db: Database, siteId: string, input: CreateSendInput, createdBy: string | null): Promise<SendRow> {
  const newsletter = await getNewsletter(db, siteId, input.newsletterId);
  if (newsletter.status !== 'active') throw new MemberError('NEWSLETTER_ARCHIVED', 409, 'Archived newsletters cannot send.');
  if (newsletter.senderEmail) {
    const domain = await findDomainForSender(db, siteId, newsletter.senderEmail);
    if (!domain || domain.status !== 'verified') {
      throw new MemberError('SENDER_DOMAIN_UNVERIFIED', 409, `Verify a sending domain for ${newsletter.senderEmail} before sending.`);
    }
  }
  let filter: SegmentFilter | null = null;
  if (input.segmentId) filter = parseSegmentFilter((await getSegmentRow(db, siteId, input.segmentId)).filter);
  const recipients = await countAudience(db, siteId, newsletter, filter);
  try {
    const [row] = await db
      .insert(newsletterSends)
      .values({
        siteId,
        newsletterId: newsletter.id,
        collection: input.collection,
        itemId: input.itemId,
        segmentId: input.segmentId ?? null,
        segmentFilter: filter,
        subject: input.composed.subject,
        html: input.composed.html,
        text: input.composed.text,
        linkBase: input.linkBase,
        status: 'queued',
        counters: { recipients, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0 },
        createdBy,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('ALREADY_SENT', 409, 'This item was already sent with this newsletter.');
    throw err;
  }
}

export async function listSends(db: Database, siteId: string, newsletterId?: string) {
  const rows = await db
    .select()
    .from(newsletterSends)
    .where(and(eq(newsletterSends.siteId, siteId), newsletterId ? eq(newsletterSends.newsletterId, newsletterId) : undefined))
    .orderBy(sql`${newsletterSends.createdAt} desc`)
    .limit(100);
  return rows.map(toSendView);
}

export async function getSend(db: Database, siteId: string, id: string): Promise<SendRow> {
  const [row] = await db
    .select()
    .from(newsletterSends)
    .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Send not found.');
  return row;
}

export async function cancelSend(db: Database, siteId: string, id: string): Promise<SendRow> {
  const [row] = await db
    .update(newsletterSends)
    .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date(), leaseOwner: null, leaseUntil: null })
    .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.id, id), inArray(newsletterSends.status, [...ACTIVE])))
    .returning();
  if (!row) throw new MemberError('SEND_NOT_ACTIVE', 409, 'Only a queued or sending issue can be cancelled.');
  return row;
}

export interface SendStepDeps {
  db: Database;
  mailerFor: (siteId: string) => MemberMailer | null;
  chunkSize?: number;
  now?: () => Date;
}

export type SendStepOutcome = 'progressed' | 'done' | 'busy';

/** Atomic in-place increments of counter keys (read-modify-write inside one UPDATE). */
function bump(by: Partial<Record<keyof SendCounters, number>>): SQL {
  let expr: SQL = sql`${newsletterSends.counters}`;
  for (const [key, n] of Object.entries(by)) {
    expr = sql`jsonb_set(${expr}, ${`{${key}}`}::text[], to_jsonb(coalesce((${newsletterSends.counters}->>${key})::int, 0) + ${n}::int))`;
  }
  return expr;
}

/** One chunk of one send under a lease. */
export async function runSendStep(deps: SendStepDeps, sendId: string): Promise<SendStepOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const owner = crypto.randomUUID();
  const [send] = await db
    .update(newsletterSends)
    .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), status: 'sending', startedAt: sql`coalesce(${newsletterSends.startedAt}, now())`, updatedAt: now })
    .where(
      and(
        eq(newsletterSends.id, sendId),
        inArray(newsletterSends.status, [...ACTIVE]),
        or(isNull(newsletterSends.leaseUntil), lt(newsletterSends.leaseUntil, now)),
      ),
    )
    .returning();
  if (!send) {
    const [cur] = await db.select({ status: newsletterSends.status }).from(newsletterSends).where(eq(newsletterSends.id, sendId)).limit(1);
    return cur && (ACTIVE as readonly string[]).includes(cur.status) ? 'busy' : 'done';
  }
  const siteId = send.siteId;
  const release = (set: Partial<typeof newsletterSends.$inferInsert> & Record<string, unknown>) =>
    db
      .update(newsletterSends)
      .set({ ...set, leaseOwner: null, leaseUntil: null, updatedAt: deps.now?.() ?? new Date() })
      .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.id, sendId), eq(newsletterSends.leaseOwner, owner)));

  const mailer = deps.mailerFor(siteId);
  if (!mailer) {
    await release({ status: 'failed', message: 'Email is not configured on this runtime.', finishedAt: now });
    return 'done';
  }
  const [newsletter] = await db
    .select()
    .from(newsletters)
    .where(and(eq(newsletters.siteId, siteId), eq(newsletters.id, send.newsletterId)))
    .limit(1);
  if (!newsletter) {
    await release({ status: 'failed', message: 'Newsletter was deleted.', finishedAt: now });
    return 'done';
  }
  let layoutHtml: string | null = null;
  if (newsletter.layoutKey) {
    const [layout] = await db
      .select({ html: emailLayouts.html })
      .from(emailLayouts)
      .where(and(eq(emailLayouts.siteId, siteId), eq(emailLayouts.key, newsletter.layoutKey)))
      .limit(1);
    layoutHtml = layout?.html ?? null;
  }

  // Leftovers from a crashed step first, then the next keyset chunk.
  const chunk = deps.chunkSize ?? NEWSLETTER_CHUNK;
  const pending = await db
    .select({ memberId: newsletterDeliveries.memberId })
    .from(newsletterDeliveries)
    .where(and(eq(newsletterDeliveries.siteId, siteId), eq(newsletterDeliveries.sendId, sendId), eq(newsletterDeliveries.status, 'pending')))
    .limit(chunk);
  let memberIds = pending.map((p) => p.memberId);
  let cursor = send.cursor;
  if (memberIds.length === 0) {
    const filter = send.segmentFilter ? parseSegmentFilter(send.segmentFilter) : null;
    const next = await db
      .select({ id: members.id })
      .from(members)
      .where(and(audienceWhere(siteId, newsletter, filter, now), cursor ? gt(members.id, cursor) : undefined))
      .orderBy(asc(members.id))
      .limit(chunk);
    if (next.length === 0) {
      await release({ status: 'sent', finishedAt: now });
      return 'done';
    }
    cursor = next[next.length - 1]!.id;
    const claimed = await db
      .insert(newsletterDeliveries)
      .values(next.map((m) => ({ siteId, sendId, memberId: m.id, status: 'pending' })))
      .onConflictDoNothing()
      .returning({ memberId: newsletterDeliveries.memberId });
    memberIds = claimed.map((c) => c.memberId);
  }

  const recipients = memberIds.length
    ? await db
        .select({ id: members.id, email: members.email, name: members.name })
        .from(members)
        .where(and(eq(members.siteId, siteId), inArray(members.id, memberIds)))
    : [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const sentIds: string[] = [];
  for (const member of recipients) {
    const outcome = await mailer.send({
      member,
      subject: send.subject,
      html: send.html,
      text: send.text,
      from: newsletter.senderEmail,
      fromName: newsletter.senderName,
      replyTo: newsletter.replyTo,
      linkBase: send.linkBase,
      newsletterId: newsletter.id,
      tracking: { sendId, opens: newsletter.trackOpens, clicks: newsletter.trackClicks },
      vars: { 'post.title': send.subject, 'newsletter.name': newsletter.name },
      layoutHtml,
    });
    const status = outcome.status === 'sent' ? 'sent' : outcome.status === 'suppressed' ? 'skipped' : 'failed';
    if (status === 'sent') {
      sent += 1;
      sentIds.push(member.id);
    } else if (status === 'skipped') skipped += 1;
    else failed += 1;
    await db
      .update(newsletterDeliveries)
      .set({ status, error: outcome.status === 'failed' ? outcome.error : outcome.status === 'not_configured' ? 'email not configured' : null })
      .where(and(eq(newsletterDeliveries.sendId, sendId), eq(newsletterDeliveries.memberId, member.id)));
  }
  // Members deleted between claim and send.
  const gone = memberIds.filter((id) => !recipients.some((r) => r.id === id));
  if (gone.length) {
    await db
      .update(newsletterDeliveries)
      .set({ status: 'skipped', error: 'member deleted' })
      .where(and(eq(newsletterDeliveries.sendId, sendId), inArray(newsletterDeliveries.memberId, gone)));
    skipped += gone.length;
  }
  if (sentIds.length) {
    await db
      .update(members)
      .set({ emailCount: sql`${members.emailCount} + 1` })
      .where(and(eq(members.siteId, siteId), inArray(members.id, sentIds)));
  }
  await release({
    cursor,
    counters: bump({ sent, failed, skipped }),
  });
  return 'progressed';
}

export async function driveSend(deps: SendStepDeps, sendId: string, budgetMs: number): Promise<SendStepOutcome> {
  const deadline = Date.now() + budgetMs;
  let outcome: SendStepOutcome = 'progressed';
  while (Date.now() < deadline) {
    outcome = await runSendStep(deps, sendId);
    if (outcome !== 'progressed') break;
  }
  return outcome;
}

/** Cron entry: resume sends with a free lease, oldest first, across sites. */
export async function runNewsletterTick(deps: SendStepDeps, opts: { budgetMs: number }): Promise<{ resumed: number }> {
  const deadline = Date.now() + opts.budgetMs;
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select({ id: newsletterSends.id })
    .from(newsletterSends)
    .where(and(inArray(newsletterSends.status, [...ACTIVE]), or(isNull(newsletterSends.leaseUntil), lt(newsletterSends.leaseUntil, now))))
    .orderBy(asc(newsletterSends.createdAt))
    .limit(20);
  let resumed = 0;
  for (const s of due) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await driveSend(deps, s.id, left);
    resumed += 1;
  }
  return { resumed };
}

// ── Tracking ──────────────────────────────────────────────────────────────

/** Record an open once per (send, member). Returns true when it counted. */
export async function recordOpen(db: Database, siteId: string, sendId: string, memberId: string, now = new Date()): Promise<boolean> {
  const [hit] = await db
    .update(newsletterDeliveries)
    .set({ openedAt: now })
    .where(
      and(
        eq(newsletterDeliveries.siteId, siteId),
        eq(newsletterDeliveries.sendId, sendId),
        eq(newsletterDeliveries.memberId, memberId),
        eq(newsletterDeliveries.status, 'sent'),
        isNull(newsletterDeliveries.openedAt),
      ),
    )
    .returning({ memberId: newsletterDeliveries.memberId });
  if (!hit) return false;
  await db
    .update(newsletterSends)
    .set({ counters: bump({ opened: 1 }) })
    .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.id, sendId)));
  await db
    .update(members)
    .set({ emailOpenedCount: sql`${members.emailOpenedCount} + 1`, lastEmailOpenedAt: now })
    .where(and(eq(members.siteId, siteId), eq(members.id, memberId)));
  return true;
}

/** Record a click once per (send, member); a click implies an open. */
export async function recordClick(db: Database, siteId: string, sendId: string, memberId: string, now = new Date()): Promise<boolean> {
  await recordOpen(db, siteId, sendId, memberId, now);
  const [hit] = await db
    .update(newsletterDeliveries)
    .set({ clickedAt: now })
    .where(
      and(
        eq(newsletterDeliveries.siteId, siteId),
        eq(newsletterDeliveries.sendId, sendId),
        eq(newsletterDeliveries.memberId, memberId),
        isNull(newsletterDeliveries.clickedAt),
      ),
    )
    .returning({ memberId: newsletterDeliveries.memberId });
  if (!hit) return false;
  await db
    .update(newsletterSends)
    .set({ counters: bump({ clicked: 1 }) })
    .where(and(eq(newsletterSends.siteId, siteId), eq(newsletterSends.id, sendId)));
  return true;
}
