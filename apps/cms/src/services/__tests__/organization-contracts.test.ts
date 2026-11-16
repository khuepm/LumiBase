import { describe, expect, it } from 'vitest';
import { canOrg, ORG_ACTIONS, classifyTokenPrefix, ORGANIZATION_TOKEN_PREFIX, type OrgRole } from '@lumibase/contracts';

describe('fixed organization permissions', () => {
  const expected = {
    owner: [...ORG_ACTIONS],
    admin: ['org:read', 'org:sites:create', 'org:members:manage', 'org:keys:manage', 'org:settings:write'],
    billing: ['org:read', 'org:billing:manage'],
    member: ['org:read'],
  };
  for (const role of Object.keys(expected) as OrgRole[]) {
    for (const action of ORG_ACTIONS) {
      it(`${role} → ${action}`, () => expect(canOrg(role, action)).toBe(expected[role].includes(action)));
    }
  }
  it('fails closed for an unknown role', () => {
    expect(canOrg('toString' as OrgRole, 'org:read')).toBe(false);
  });
});

it.each([
  ['lbk_secret', 'site'], ['lbk_pub_public', 'publishable'],
  ['lbo_secret', 'organization'], ['', 'unknown'], ['dev:user', 'unknown'],
  ['LBO_secret', 'unknown'], ['Bearer lbo_secret', 'unknown'],
])('classifies %s as %s', (token, kind) => expect(classifyTokenPrefix(token)).toBe(kind));
it('exports the organization prefix', () => expect(ORGANIZATION_TOKEN_PREFIX).toBe('lbo_'));
