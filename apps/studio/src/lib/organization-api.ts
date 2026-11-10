import type { LumiClient } from '@lumibase/sdk';
import type { OrgRole } from '@lumibase/contracts';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}
export interface OrganizationSite {
  id: string;
  name: string;
  organizationId: string;
}
export interface OrganizationMember {
  userId: string;
  email: string;
  role: OrgRole;
}
export interface OrganizationKey {
  id: string;
  name: string;
  prefix: string;
  description?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
}
export interface OrganizationApproval {
  id: string;
  organizationId: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  requester: unknown;
  createdAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
  result?: unknown;
}
export function createOrganizationApi(client: Pick<LumiClient, 'rawRequest'>) {
  const root = '/api/v1/orgs';
  const at = (id: string) => `${root}/${encodeURIComponent(id)}`;
  const request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    headers?: HeadersInit,
  ): Promise<T> =>
    (
      await client.rawRequest<T>(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).data;
  return {
    list: () => request<Organization[]>(root),
    get: (id: string) => request<Organization>(at(id)),
    update: (
      id: string,
      body: {
        name?: string;
        slug?: string;
        settings?: Record<string, unknown>;
      },
    ) => request<Organization>(at(id), 'PATCH', body),
    remove: (id: string) =>
      request(at(id), 'DELETE', undefined, { 'X-Confirm-Delete': id }),
    sites: {
      list: (id: string) => request<OrganizationSite[]>(`${at(id)}/sites`),
      create: (id: string, body: { name: string; id?: string }) =>
        request<OrganizationSite>(`${at(id)}/sites`, 'POST', body),
      remove: (id: string, site: string) =>
        request(
          `${at(id)}/sites/${encodeURIComponent(site)}`,
          'DELETE',
          undefined,
          { 'X-Confirm-Delete': site },
        ),
      transfer: (id: string, site: string, destination: string) =>
        request<OrganizationSite>(
          `${at(id)}/sites/${encodeURIComponent(site)}/transfer`,
          'POST',
          { toOrganizationId: destination },
        ),
    },
    members: {
      list: (id: string) => request<OrganizationMember[]>(`${at(id)}/members`),
      invite: (id: string, email: string, role: OrgRole) =>
        request(`${at(id)}/members`, 'POST', { email, role }),
      update: (id: string, user: string, role: OrgRole) =>
        request(`${at(id)}/members/${encodeURIComponent(user)}`, 'PATCH', {
          role,
        }),
      remove: (id: string, user: string) =>
        request(`${at(id)}/members/${encodeURIComponent(user)}`, 'DELETE'),
    },
    keys: {
      list: (id: string) => request<OrganizationKey[]>(`${at(id)}/keys`),
      create: (id: string, name: string, expiresAt?: string) =>
        request<OrganizationKey & { token: string }>(`${at(id)}/keys`, 'POST', {
          name,
          expiresAt,
        }),
      revoke: (id: string, key: string) =>
        request(`${at(id)}/keys/${encodeURIComponent(key)}`, 'DELETE'),
      rotate: (id: string, key: string) =>
        request<OrganizationKey & { token: string }>(
          `${at(id)}/keys/${encodeURIComponent(key)}/rotate`,
          'POST',
        ),
    },
    approvals: {
      list: (id: string) =>
        request<OrganizationApproval[]>(`${at(id)}/approvals`),
      get: (id: string, approval: string) =>
        request<OrganizationApproval>(
          `${at(id)}/approvals/${encodeURIComponent(approval)}`,
        ),
      decide: (
        id: string,
        approval: string,
        decision: 'approved' | 'rejected',
      ) =>
        request<OrganizationApproval>(
          `${at(id)}/approvals/${encodeURIComponent(approval)}/decide`,
          'POST',
          { decision },
        ),
    },
  };
}
