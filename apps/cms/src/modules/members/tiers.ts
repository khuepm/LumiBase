/**
 * Membership tiers (#717, epic #672 N01).
 *
 * Tier-gated content rides on the existing permission engine instead of a
 * parallel check: each tier owns an ordinary policy (`member-tier:<key>`,
 * no admin/app access) that operators shape like any other policy — in the
 * Studio policy editor or through {@link grantTierAccess}. When a member who
 * has a subscriber account holds a tier, that policy is attached to the user
 * via `user_policies` for this site; when the tier changes, lapses or the
 * member is deleted, it is detached. `PermissionService` already composes
 * user-level policies, so a gated `read` works for items, delivery and search
 * the same way a role grant does.
 *
 * Payments are out of scope: a `paid` tier only carries prices and
 * `externalIds` (e.g. Stripe price ids) for the payment hook to use later.
 */

import { z } from 'zod';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  memberTiers,
  members,
  permissions,
  policies,
  userPolicies,
  type Database,
} from '@lumibase/database';
import { resolveGrant, type AccessGrant, type GrantInput, type RealmDefinition } from '../../services/auth/realm-access';
import { MemberError, isUniqueViolation } from './errors';

export const TIER_POLICY_PREFIX = 'member-tier:';
/** Priority of tier policies on the user; after role policies (0–100). */
export const TIER_POLICY_PRIORITY = 200;
export const FREE_TIER_KEY = 'free';

const KEY_RE = /^[a-z0-9][a-z0-9-_]{0,62}$/;

export const tierInputSchema = z.object({
  key: z.string().regex(KEY_RE, 'lowercase letters, digits, - and _'),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  kind: z.enum(['free', 'paid']).default('paid'),
  active: z.boolean().default(true),
  monthlyPriceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  yearlyPriceCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  benefits: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  externalIds: z.record(z.string(), z.string().max(200)).default({}),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type TierInput = z.output<typeof tierInputSchema>;

type TierRow = typeof memberTiers.$inferSelect;

/** Grants on a tier policy are read-only and cannot express "own rows". */
const TIER_REALM: RealmDefinition = {
  key: 'member-tier',
  allowedActions: ['read'],
  supportsOwnOnly: false,
  roleName: 'Member tier',
  roleDescription: '',
  policyName: 'Member tier',
  policyDescription: '',
  icon: 'crown',
};

export interface TierView extends TierRow {
  memberCount: number;
}

export function tierPolicyKey(tierKey: string): string {
  return `${TIER_POLICY_PREFIX}${tierKey}`;
}

/** Provision (or find) the tier's policy and store its id on the tier. */
async function ensureTierPolicy(db: Database, siteId: string, tier: TierRow): Promise<string> {
  if (tier.policyId) return tier.policyId;
  const key = tierPolicyKey(tier.key);
  const inserted = await db
    .insert(policies)
    .values({
      siteId,
      key,
      name: `Member tier: ${tier.name}`,
      description: `Content members on the "${tier.name}" tier may read. Attached per member by the members module.`,
      icon: 'crown',
      adminAccess: false,
      appAccess: false,
      enforceTfa: false,
    })
    .onConflictDoNothing()
    .returning({ id: policies.id });
  let policyId = inserted[0]?.id;
  if (!policyId) {
    const [existing] = await db
      .select({ id: policies.id, adminAccess: policies.adminAccess, appAccess: policies.appAccess })
      .from(policies)
      .where(and(eq(policies.siteId, siteId), eq(policies.key, key)))
      .limit(1);
    // A hand-made policy with this key that grants Studio/admin access must
    // never be attached to an audience member.
    if (existing && (existing.adminAccess || existing.appAccess)) {
      throw new MemberError('TIER_POLICY_CONFLICT', 409, `Policy "${key}" exists with Studio/admin access; rename it first.`);
    }
    policyId = existing?.id;
  }
  if (!policyId) throw new Error(`failed to provision tier policy ${key}`);
  await db
    .update(memberTiers)
    .set({ policyId, updatedAt: new Date() })
    .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.id, tier.id)));
  return policyId;
}

export async function listTiers(db: Database, siteId: string): Promise<TierView[]> {
  const rows = await db
    .select()
    .from(memberTiers)
    .where(eq(memberTiers.siteId, siteId))
    .orderBy(asc(memberTiers.sortOrder), asc(memberTiers.createdAt));
  const counts = await db
    .select({ tierId: members.tierId })
    .from(members)
    .where(and(eq(members.siteId, siteId), isNotNull(members.tierId)));
  const byTier = new Map<string, number>();
  for (const r of counts) if (r.tierId) byTier.set(r.tierId, (byTier.get(r.tierId) ?? 0) + 1);
  return rows.map((r) => ({ ...r, memberCount: byTier.get(r.id) ?? 0 }));
}

export async function getTier(db: Database, siteId: string, id: string): Promise<TierRow> {
  const [row] = await db
    .select()
    .from(memberTiers)
    .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Tier not found.');
  return row;
}

export async function findTierByKey(db: Database, siteId: string, key: string): Promise<TierRow | null> {
  const [row] = await db
    .select()
    .from(memberTiers)
    .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.key, key)))
    .limit(1);
  return row ?? null;
}

export async function createTier(db: Database, siteId: string, input: TierInput): Promise<TierRow> {
  let row: TierRow | undefined;
  try {
    [row] = await db
      .insert(memberTiers)
      .values({
        siteId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        active: input.active,
        monthlyPriceCents: input.monthlyPriceCents ?? null,
        yearlyPriceCents: input.yearlyPriceCents ?? null,
        currency: input.currency ?? null,
        benefits: input.benefits,
        externalIds: input.externalIds,
        sortOrder: input.sortOrder,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('TIER_KEY_TAKEN', 409, `Tier key "${input.key}" already exists.`);
    throw err;
  }
  const policyId = await ensureTierPolicy(db, siteId, row!);
  return { ...row!, policyId };
}

/** The site's free tier, created on first use. */
export async function ensureFreeTier(db: Database, siteId: string): Promise<TierRow> {
  const [existing] = await db
    .select()
    .from(memberTiers)
    .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.kind, 'free')))
    .orderBy(asc(memberTiers.sortOrder), asc(memberTiers.createdAt))
    .limit(1);
  if (existing) return existing;
  await db
    .insert(memberTiers)
    .values({ siteId, key: FREE_TIER_KEY, name: 'Free', kind: 'free', sortOrder: 0 })
    .onConflictDoNothing();
  const row = await findTierByKey(db, siteId, FREE_TIER_KEY);
  if (!row) throw new Error('failed to provision free tier');
  if (row.kind !== 'free') {
    throw new MemberError('FREE_TIER_CONFLICT', 409, 'A paid tier uses the key "free"; create a free tier explicitly.');
  }
  const policyId = await ensureTierPolicy(db, siteId, row);
  return { ...row, policyId };
}

export async function updateTier(
  db: Database,
  siteId: string,
  id: string,
  patch: Partial<TierInput>,
): Promise<TierRow> {
  const current = await getTier(db, siteId, id);
  if (patch.key !== undefined && patch.key !== current.key) {
    throw new MemberError('TIER_KEY_IMMUTABLE', 400, 'A tier key cannot change; create a new tier instead.');
  }
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    throw new MemberError('TIER_KIND_IMMUTABLE', 400, 'A tier cannot switch between free and paid.');
  }
  const { key: _key, kind: _kind, ...rest } = patch;
  const [row] = await db
    .update(memberTiers)
    .set({ ...rest, updatedAt: new Date() })
    .where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.id, id)))
    .returning();
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Tier not found.');
  return row;
}

/** Delete a tier with no members. Its policy is removed with it. */
export async function deleteTier(db: Database, siteId: string, id: string): Promise<void> {
  const tier = await getTier(db, siteId, id);
  const [holder] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.siteId, siteId), eq(members.tierId, id)))
    .limit(1);
  if (holder) throw new MemberError('TIER_IN_USE', 409, 'Move members off this tier before deleting it.');
  await db.delete(memberTiers).where(and(eq(memberTiers.siteId, siteId), eq(memberTiers.id, id)));
  if (tier.policyId) {
    await db.delete(policies).where(and(eq(policies.siteId, siteId), eq(policies.id, tier.policyId)));
  }
}

/** Grant read on a collection to a tier (published-only by default). */
export async function grantTierAccess(
  db: Database,
  siteId: string,
  tierId: string,
  input: GrantInput,
): Promise<AccessGrant> {
  const tier = await getTier(db, siteId, tierId);
  const grant = resolveGrant(TIER_REALM, input);
  const policyId = await ensureTierPolicy(db, siteId, tier);
  const rule = grant.publishedOnly ? { status: { _eq: 'published' } } : {};
  await db
    .insert(permissions)
    .values({
      siteId,
      policyId,
      collection: grant.collection,
      action: grant.action,
      permissions: rule,
      validation: {},
      presets: {},
      fields: grant.fields,
    })
    .onConflictDoUpdate({
      target: [permissions.policyId, permissions.collection, permissions.action],
      set: { permissions: rule, fields: grant.fields },
    });
  return grant;
}

export async function revokeTierAccess(db: Database, siteId: string, tierId: string, collection: string): Promise<boolean> {
  const tier = await getTier(db, siteId, tierId);
  if (!tier.policyId) return false;
  const deleted = await db
    .delete(permissions)
    .where(
      and(
        eq(permissions.siteId, siteId),
        eq(permissions.policyId, tier.policyId),
        eq(permissions.collection, collection),
        eq(permissions.action, 'read'),
      ),
    )
    .returning({ id: permissions.id });
  return deleted.length > 0;
}

export async function listTierAccess(db: Database, siteId: string, tierId: string): Promise<AccessGrant[]> {
  const tier = await getTier(db, siteId, tierId);
  if (!tier.policyId) return [];
  const rows = await db
    .select({ collection: permissions.collection, action: permissions.action, rule: permissions.permissions, fields: permissions.fields })
    .from(permissions)
    .where(and(eq(permissions.siteId, siteId), eq(permissions.policyId, tier.policyId)));
  return rows.map((r) => ({
    collection: r.collection,
    action: 'read' as const,
    publishedOnly: JSON.stringify(r.rule ?? {}).includes('"status"'),
    ownOnly: false,
    fields: Array.isArray(r.fields) ? (r.fields as string[]) : ['*'],
  }));
}

/**
 * Whether a member's tier currently grants access: free members hold the free
 * tier; paid/comped members hold their tier until `tierExpiresAt`.
 */
export function tierIsLive(member: { tierExpiresAt: Date | null }, tier: { active: boolean } | null, now: Date): boolean {
  if (!tier || !tier.active) return false;
  return !member.tierExpiresAt || member.tierExpiresAt.getTime() > now.getTime();
}

/**
 * Reconcile `user_policies` for one member: detach every tier policy of the
 * site from the member's user, then attach the current tier's policy when it
 * is live. Returns true when anything changed (callers bump the permission
 * version). A member with no user is a no-op.
 */
export async function syncMemberTierPolicy(
  db: Database,
  siteId: string,
  member: { userId: string | null; tierId: string | null; tierExpiresAt: Date | null },
  now: Date = new Date(),
): Promise<boolean> {
  if (!member.userId) return false;
  const tiers = await db
    .select({ id: memberTiers.id, policyId: memberTiers.policyId, active: memberTiers.active })
    .from(memberTiers)
    .where(eq(memberTiers.siteId, siteId));
  const tierPolicyIds = tiers.map((t) => t.policyId).filter((p): p is string => !!p);
  const current = member.tierId ? tiers.find((t) => t.id === member.tierId) ?? null : null;
  const want = current && current.policyId && tierIsLive(member, current, now) ? current.policyId : null;

  const held = tierPolicyIds.length
    ? await db
        .select({ policyId: userPolicies.policyId })
        .from(userPolicies)
        .where(
          and(
            eq(userPolicies.userId, member.userId),
            eq(userPolicies.siteId, siteId),
            inArray(userPolicies.policyId, tierPolicyIds),
          ),
        )
    : [];
  const stale = held.map((h) => h.policyId).filter((p) => p !== want);
  let changed = false;
  if (stale.length) {
    await db
      .delete(userPolicies)
      .where(and(eq(userPolicies.userId, member.userId), eq(userPolicies.siteId, siteId), inArray(userPolicies.policyId, stale)));
    changed = true;
  }
  if (want && !held.some((h) => h.policyId === want)) {
    await db
      .insert(userPolicies)
      .values({ userId: member.userId, siteId, policyId: want, priority: TIER_POLICY_PRIORITY })
      .onConflictDoNothing();
    changed = true;
  }
  return changed;
}
