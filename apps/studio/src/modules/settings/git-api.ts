/**
 * Thin REST client for the Git-integration endpoints.
 *
 * The Studio SDK doesn't (yet) expose a `gitIntegrations` module, so this page
 * talks to `/api/v1/integrations/git/*` with raw fetch — same base-URL + auth
 * header pattern the SDK uses (`getApiBaseUrl()`, Bearer token, `X-Lumi-Site`).
 */
import { getApiBaseUrl } from '@/lib/api-base';
import { getActiveSite, getActiveToken } from '@/lib/api';
import type {
  CiRunResource,
  GitIntegrationResource,
  PullRequestResource,
} from '@lumibase/shared/schemas';

const PREFIX = '/api/v1/integrations/git';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBaseUrl()}${PREFIX}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      'X-Lumi-Site': getActiveSite(),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as
    | { data?: T; errors?: { code: string; message?: string }[] }
    | null;
  if (!res.ok || !body) {
    const code = body?.errors?.[0]?.code ?? `HTTP_${res.status}`;
    const message = body?.errors?.[0]?.message ?? 'Request failed';
    throw new Error(`${code}: ${message}`);
  }
  return body.data as T;
}

export interface CreateIntegrationPayload {
  provider: 'github' | 'gitlab';
  repoFullName: string;
  displayName: string;
  authMethod: 'app' | 'pat';
  token?: string;
  installationId?: string;
}

export const gitApi = {
  list: () => request<GitIntegrationResource[]>(''),
  create: (payload: CreateIntegrationPayload) =>
    request<GitIntegrationResource>('', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  remove: (id: string) =>
    request<{ id: string }>(`/${id}`, { method: 'DELETE' }),
  rotateSecret: (id: string) =>
    request<GitIntegrationResource>(`/${id}/rotate-secret`, { method: 'POST' }),
  authorize: (id: string) =>
    request<{ authorizeUrl: string }>(`/${id}/oauth/authorize`),
  listPullRequests: (id: string) =>
    request<PullRequestResource[]>(`/${id}/pull-requests`),
  refreshPullRequests: (id: string) =>
    request<PullRequestResource[]>(`/${id}/pull-requests/refresh`, {
      method: 'POST',
    }),
  listCi: (id: string, number: number) =>
    request<CiRunResource[]>(`/${id}/pull-requests/${number}/ci`),
  fetchLog: (id: string, runId: string) =>
    request<{ log: string }>(`/${id}/ci-runs/${runId}/logs`),
  validate: (id: string, number: number) =>
    request<{ state: string; summary: string; statusPosted: boolean }>(
      `/${id}/pull-requests/${number}/validate`,
      { method: 'POST' },
    ),
};
