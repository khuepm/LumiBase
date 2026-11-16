import { z } from 'zod';
import { OrgSiteCreateSchema, OrgMemberUpsertSchema, OrgKeyCreateSchema } from './organizations';
const organizationId = z.string().min(1).max(64);
const base = z.strictObject({ organizationId });
export const OrganizationToolSchemas = {
  'org:get_organization': base,
  'org:list_sites': base,
  'org:create_site': OrgSiteCreateSchema.safeExtend({ organizationId }),
  'org:delete_site': base.extend({ siteId: z.string().min(1).max(64) }),
  'org:transfer_site': base.extend({ siteId: z.string().min(1).max(64), toOrganizationId: organizationId }),
  'org:list_org_members': base,
  'org:invite_org_member': OrgMemberUpsertSchema.safeExtend({ organizationId }),
  'org:create_org_key': OrgKeyCreateSchema.extend({ organizationId }),
} as const;
export type OrganizationToolName = keyof typeof OrganizationToolSchemas;
