import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { policies } from './access';
import { sites, users } from './core';

/**
 * Memberships, newsletters & audience (epic #672).
 *
 * A member is the audience-side record of a person on one site: their tier,
 * paid/free/comped status, labels and newsletter choices. It extends the
 * `subscriber` realm (ADR-010) rather than replacing it — a member who signs
 * in through the Portal is linked to a subscriber-role `users` row, and the
 * tier's policy is attached to that user so tier-gated content is enforced by
 * the ordinary permission engine. Members imported or created by staff have no
 * user until they first sign in.
 *
 * Every table carries `site_id` and is listed in `rls-policies.sql`.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const siteRef = () =>
  text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/** One row per site: Portal switches, redirect allow-list, localized signup-card defaults. */
export const memberSettings = pgTable(
  'lumibase_member_settings',
  {
    id: id(),
    siteId: siteRef(),
    /** Master switch for the public Portal API. Off by default. */
    portalEnabled: boolean('portal_enabled').default(false).notNull(),
    /** Whether visitors may sign up themselves (otherwise invite/import only). */
    allowSelfSignup: boolean('allow_self_signup').default(true).notNull(),
    /** Exact-match landing URIs a magic link may point at (string[]). */
    redirectUris: jsonb('redirect_uris').default([]).notNull(),
    /** Newsletter ids a self-signup is subscribed to when it names none (string[]). */
    defaultNewsletterIds: jsonb('default_newsletter_ids').default([]).notNull(),
    /** `{ [locale]: { heading, description, placeholder, button, success } }` */
    signupCopy: jsonb('signup_copy').default({}).notNull(),
    /** Display name for member mail when a newsletter names none. */
    senderName: text('sender_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteUnique: uniqueIndex('member_settings_site_unique').on(t.siteId),
  }),
);

/**
 * Membership tiers. `kind = 'free'` is the tier every free member lands on;
 * `paid` tiers carry prices for a future payment provider (`external_ids`
 * holds e.g. Stripe price ids — no payment is processed here). Each tier owns
 * an ordinary policy (`policies.key = member-tier:<key>`) that operators edit
 * like any other; it is attached per user when a member holds the tier.
 */
export const memberTiers = pgTable(
  'lumibase_member_tiers',
  {
    id: id(),
    siteId: siteRef(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `free` | `paid` */
    kind: text('kind').default('paid').notNull(),
    active: boolean('active').default(true).notNull(),
    monthlyPriceCents: integer('monthly_price_cents'),
    yearlyPriceCents: integer('yearly_price_cents'),
    currency: text('currency'),
    /** Marketing bullet points (string[]). */
    benefits: jsonb('benefits').default([]).notNull(),
    /** Payment-provider references, e.g. `{ stripePriceMonthly: 'price_…' }`. */
    externalIds: jsonb('external_ids').default({}).notNull(),
    policyId: text('policy_id').references(() => policies.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('member_tiers_site_key_unique').on(t.siteId, t.key),
  }),
);

export const members = pgTable(
  'lumibase_members',
  {
    id: id(),
    siteId: siteRef(),
    /** Subscriber-realm account, set on first Portal sign-in. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    emailLower: text('email_lower').notNull(),
    name: text('name'),
    /** `free` | `paid` | `comped` */
    status: text('status').default('free').notNull(),
    tierId: text('tier_id').references(() => memberTiers.id, { onDelete: 'set null' }),
    /** Comped / paid access end; null = open-ended. */
    tierExpiresAt: timestamp('tier_expires_at'),
    /** Free-form labels (string[]). */
    labels: jsonb('labels').default([]).notNull(),
    note: text('note'),
    /** Where the member came from: `portal` | `admin` | `import` | `api`. */
    source: text('source').default('admin').notNull(),
    emailVerifiedAt: timestamp('email_verified_at'),
    /** Payment-provider customer reference (hook for Stripe; unused here). */
    externalCustomerId: text('external_customer_id'),
    emailCount: integer('email_count').default(0).notNull(),
    emailOpenedCount: integer('email_opened_count').default(0).notNull(),
    lastEmailOpenedAt: timestamp('last_email_opened_at'),
    lastSeenAt: timestamp('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteEmailUnique: uniqueIndex('members_site_email_unique').on(t.siteId, t.emailLower),
    siteStatusIdx: index('members_site_status_idx').on(t.siteId, t.status),
    siteCreatedIdx: index('members_site_created_idx').on(t.siteId, t.createdAt),
    userIdx: index('members_user_idx').on(t.userId),
  }),
);

/** A member's newsletter choices (per-member toggles). */
export const memberNewsletters = pgTable(
  'lumibase_member_newsletters',
  {
    siteId: siteRef(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    newsletterId: text('newsletter_id')
      .notNull()
      .references(() => newsletters.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memberId, t.newsletterId] }),
    siteNewsletterIdx: index('member_newsletters_site_newsletter_idx').on(t.siteId, t.newsletterId, t.memberId),
  }),
);

/**
 * Single-use Portal magic links. Only the SHA-256 of the emailed token is
 * stored; consumption is one conditional UPDATE (`consumed_at IS NULL AND
 * expires_at > now`), so two clicks of one link mint one session.
 */
export const memberLoginTokens = pgTable(
  'lumibase_member_login_tokens',
  {
    id: id(),
    siteId: siteRef(),
    tokenHash: text('token_hash').notNull(),
    emailLower: text('email_lower').notNull(),
    /** `signup` | `signin` */
    purpose: text('purpose').notNull(),
    /** Signup choices carried to verification: `{ name, newsletterIds }`. */
    payload: jsonb('payload').default({}).notNull(),
    redirectUri: text('redirect_uri'),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    hashUnique: uniqueIndex('member_login_tokens_hash_unique').on(t.tokenHash),
    siteEmailIdx: index('member_login_tokens_site_email_idx').on(t.siteId, t.emailLower, t.createdAt),
  }),
);

/**
 * Saved segments: a named filter over member attributes and activity. The
 * count is evaluated live on read, so a segment "updates itself" — nothing is
 * materialised that could go stale.
 */
export const memberSegments = pgTable(
  'lumibase_member_segments',
  {
    id: id(),
    siteId: siteRef(),
    name: text('name').notNull(),
    description: text('description'),
    /** Segment filter DSL (see `modules/members/segments.ts`). */
    filter: jsonb('filter').default({}).notNull(),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteIdx: index('member_segments_site_idx').on(t.siteId),
  }),
);

export const newsletters = pgTable(
  'lumibase_newsletters',
  {
    id: id(),
    siteId: siteRef(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    senderName: text('sender_name'),
    /** Must sit on a verified sending domain when set; else the transport default. */
    senderEmail: text('sender_email'),
    replyTo: text('reply_to'),
    /** `active` | `archived` */
    status: text('status').default('active').notNull(),
    /** `members` (everyone subscribed) | `paid` (paid + comped only). */
    audience: text('audience').default('members').notNull(),
    subscribeOnSignup: boolean('subscribe_on_signup').default(true).notNull(),
    trackOpens: boolean('track_opens').default(false).notNull(),
    trackClicks: boolean('track_clicks').default(false).notNull(),
    /** Optional email layout key wrapping every issue. */
    layoutKey: text('layout_key'),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('newsletters_site_key_unique').on(t.siteId, t.key),
  }),
);

/**
 * One newsletter issue: an item rendered once, sent to the newsletter's
 * subscribers (optionally narrowed by a segment) in batches under a lease —
 * the import-job pattern. Unique per (newsletter, collection, item) so the
 * same post cannot be mailed twice.
 */
export const newsletterSends = pgTable(
  'lumibase_newsletter_sends',
  {
    id: id(),
    siteId: siteRef(),
    newsletterId: text('newsletter_id')
      .notNull()
      .references(() => newsletters.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    segmentId: text('segment_id').references(() => memberSegments.id, { onDelete: 'set null' }),
    /** Frozen segment filter at send time (the segment may change mid-send). */
    segmentFilter: jsonb('segment_filter'),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text'),
    /** Public CMS origin for unsubscribe / tracking links, fixed at creation. */
    linkBase: text('link_base').notNull(),
    /** `queued` | `sending` | `sent` | `failed` | `cancelled` */
    status: text('status').default('queued').notNull(),
    /** Last member id handed out (keyset cursor). */
    cursor: text('cursor'),
    /** `{ recipients, sent, failed, skipped, opened, clicked }` */
    counters: jsonb('counters').default({}).notNull(),
    message: text('message'),
    createdBy: text('created_by'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteItemUnique: uniqueIndex('newsletter_sends_site_item_unique').on(t.siteId, t.newsletterId, t.collection, t.itemId),
    statusLeaseIdx: index('newsletter_sends_status_lease_idx').on(t.status, t.leaseUntil),
  }),
);

/** Per-recipient delivery row: exactly-once claim, open/click dedup. */
export const newsletterDeliveries = pgTable(
  'lumibase_newsletter_deliveries',
  {
    siteId: siteRef(),
    sendId: text('send_id')
      .notNull()
      .references(() => newsletterSends.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** `pending` | `sent` | `failed` | `skipped` */
    status: text('status').default('pending').notNull(),
    error: text('error'),
    openedAt: timestamp('opened_at'),
    clickedAt: timestamp('clicked_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sendId, t.memberId] }),
    siteSendIdx: index('newsletter_deliveries_site_send_idx').on(t.siteId, t.sendId),
  }),
);

/**
 * Automated email sequence (welcome / onboarding / win-back). Steps are
 * `{ delayMinutes, subject, html, text? }`, run per enrolled member.
 */
export const emailSequences = pgTable(
  'lumibase_email_sequences',
  {
    id: id(),
    siteId: siteRef(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** `member.created` | `member.tier_changed` | `manual` */
    trigger: text('trigger').notNull(),
    /** e.g. `{ tierKey: 'gold' }` for `member.tier_changed`. */
    triggerOptions: jsonb('trigger_options').default({}).notNull(),
    steps: jsonb('steps').default([]).notNull(),
    /** `draft` | `active` | `paused` */
    status: text('status').default('draft').notNull(),
    /** Template the sequence was created from, if any. */
    templateKey: text('template_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('email_sequences_site_key_unique').on(t.siteId, t.key),
  }),
);

export const sequenceEnrollments = pgTable(
  'lumibase_sequence_enrollments',
  {
    id: id(),
    siteId: siteRef(),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => emailSequences.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** Index of the NEXT step to send. */
    stepIndex: integer('step_index').default(0).notNull(),
    /** `active` | `completed` | `stopped` */
    status: text('status').default('active').notNull(),
    stoppedReason: text('stopped_reason'),
    nextRunAt: timestamp('next_run_at'),
    leaseUntil: timestamp('lease_until'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    sequenceMemberUnique: uniqueIndex('sequence_enrollments_sequence_member_unique').on(t.sequenceId, t.memberId),
    dueIdx: index('sequence_enrollments_due_idx').on(t.status, t.nextRunAt),
    siteMemberIdx: index('sequence_enrollments_site_member_idx').on(t.siteId, t.memberId),
  }),
);

/**
 * Custom sending domain. DKIM keys are 2048-bit RSA; the private key is
 * sealed under the KeyProvider (AAD binds it to site + domain + selector).
 * Rotation keeps the previous selector published and signable-for-verify
 * until `previous_retire_after`, so mail in flight keeps verifying.
 */
export const sendingDomains = pgTable(
  'lumibase_sending_domains',
  {
    id: id(),
    siteId: siteRef(),
    domain: text('domain').notNull(),
    /** `pending` | `verified` | `failed` */
    status: text('status').default('pending').notNull(),
    dkimSelector: text('dkim_selector').notNull(),
    dkimPublicKey: text('dkim_public_key').notNull(),
    dkimPrivateKeySealed: text('dkim_private_key_sealed').notNull(),
    /** Selector published ahead of a switch; signing moves to it once verified. */
    nextSelector: text('next_selector'),
    nextPublicKey: text('next_public_key'),
    nextPrivateKeySealed: text('next_private_key_sealed'),
    previousSelector: text('previous_selector'),
    previousPublicKey: text('previous_public_key'),
    previousRetireAfter: timestamp('previous_retire_after'),
    /** Rotate after this instant (default 180 days from activation). */
    rotateAfter: timestamp('rotate_after'),
    /** `{ spf, dkim, nextDkim, dmarc, dmarcAligned, dmarcPolicy, checkedAt, problems[] }` */
    checks: jsonb('checks').default({}).notNull(),
    lastCheckedAt: timestamp('last_checked_at'),
    verifiedAt: timestamp('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteDomainUnique: uniqueIndex('sending_domains_site_domain_unique').on(t.siteId, t.domain),
  }),
);
