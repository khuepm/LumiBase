import { z } from 'zod';

const name = z.string().trim().min(1).max(255);
const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const OrgRoleSchema = z.enum(['owner', 'admin', 'billing', 'member']);
export const OrganizationCreateSchema = z.strictObject({ name, slug });
// Fields are individually optional: omitted fields must never acquire defaults.
export const OrganizationUpdateSchema = z.strictObject({
  name: name.optional(), slug: slug.optional(), settings: z.record(z.string(), z.unknown()).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export const OrgSiteCreateSchema = z.strictObject({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  name, slug: slug.optional(),
}).refine((v) => !v.id || !v.slug || v.id === v.slug, 'id and slug must agree');
export const OrgMemberUpsertSchema = z.strictObject({
  userId: z.string().min(1).optional(), email: z.email().max(254).transform((v) => v.toLowerCase()).optional(),
  role: OrgRoleSchema,
}).refine((v) => Boolean(v.userId) !== Boolean(v.email), 'Provide userId or email');
export const OrgMemberUpdateSchema = z.strictObject({ role: OrgRoleSchema });
export const OrgKeyCreateSchema = z.strictObject({
  name, description: z.string().max(2000).optional(), expiresAt: z.iso.datetime().optional(),
});
export const OrgSiteTransferSchema = z.strictObject({ toOrganizationId: z.string().min(1) });
