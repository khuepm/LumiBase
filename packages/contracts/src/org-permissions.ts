/** Organization roles are fixed; site policies cannot grant organization actions. */
export const ORG_ACTIONS = [
  'org:read', 'org:sites:create', 'org:sites:delete', 'org:sites:transfer',
  'org:members:manage', 'org:keys:manage', 'org:billing:manage',
  'org:settings:write', 'org:delete',
] as const;
export type OrgAction = typeof ORG_ACTIONS[number];
export type OrgRole = 'owner' | 'admin' | 'billing' | 'member';
const grants: Record<OrgRole, readonly OrgAction[]> = {
  owner: ORG_ACTIONS,
  admin: ['org:read', 'org:sites:create', 'org:members:manage', 'org:keys:manage', 'org:settings:write'],
  billing: ['org:read', 'org:billing:manage'],
  member: ['org:read'],
};
export function canOrg(role: OrgRole, action: OrgAction): boolean {
  return Object.hasOwn(grants, role) && grants[role].includes(action);
}
