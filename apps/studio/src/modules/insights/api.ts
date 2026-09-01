import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import type { GridPosition, PanelQuery, PanelResult, PanelType } from '@lumibase/contracts';

/**
 * Insights API access. Thin typed fetchers over `/api/v1/dashboards`, same
 * auth-header convention as Mission Control. See `.kiro/specs/insights-dashboard`.
 */

async function rawFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** For endpoints that wrap their payload in `{ data }`. */
async function insightsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { ok, status, json } = await rawFetch(path, init);
  if (!ok) {
    const errors = json.errors as Array<{ message: string }> | undefined;
    throw new Error(errors?.[0]?.message ?? `Request failed: ${status}`);
  }
  return json.data as T;
}

/** Panel run/preview return the result object directly (already `{ data, meta }`). */
async function resultFetch(path: string, init?: RequestInit): Promise<PanelResult> {
  const { ok, status, json } = await rawFetch(path, init);
  if (!ok) {
    const errors = json.errors as Array<{ message: string }> | undefined;
    throw new Error(errors?.[0]?.message ?? `Request failed: ${status}`);
  }
  return json as unknown as PanelResult;
}

export interface Dashboard {
  id: string;
  siteId: string;
  name: string;
  icon: string | null;
  color: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Panel {
  id: string;
  siteId: string;
  dashboardId: string;
  name: string;
  type: PanelType;
  position: GridPosition;
  query: PanelQuery;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const insightsApi = {
  listDashboards: () => insightsFetch<Dashboard[]>('/api/v1/dashboards'),
  getDashboard: (id: string) => insightsFetch<Dashboard>(`/api/v1/dashboards/${id}`),
  createDashboard: (input: { name: string; icon?: string; color?: string; note?: string }) =>
    insightsFetch<Dashboard>('/api/v1/dashboards', { method: 'POST', body: JSON.stringify(input) }),
  updateDashboard: (id: string, patch: Partial<Pick<Dashboard, 'name' | 'icon' | 'color' | 'note'>>) =>
    insightsFetch<Dashboard>(`/api/v1/dashboards/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteDashboard: (id: string) =>
    insightsFetch<null>(`/api/v1/dashboards/${id}`, { method: 'DELETE' }),

  listPanels: (dashboardId: string) =>
    insightsFetch<Panel[]>(`/api/v1/dashboards/${dashboardId}/panels`),
  createPanel: (
    dashboardId: string,
    input: { name: string; type: PanelType; position: GridPosition; query: PanelQuery; options?: Record<string, unknown> },
  ) =>
    insightsFetch<Panel>(`/api/v1/dashboards/${dashboardId}/panels`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updatePanel: (dashboardId: string, panelId: string, patch: Partial<Pick<Panel, 'name' | 'type' | 'position' | 'query' | 'options'>>) =>
    insightsFetch<Panel>(`/api/v1/dashboards/${dashboardId}/panels/${panelId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePanel: (dashboardId: string, panelId: string) =>
    insightsFetch<null>(`/api/v1/dashboards/${dashboardId}/panels/${panelId}`, { method: 'DELETE' }),

  runPanel: (dashboardId: string, panelId: string, override?: { filter?: unknown; dateRange?: unknown }) =>
    resultFetch(`/api/v1/dashboards/${dashboardId}/panels/${panelId}/data`, {
      method: 'POST',
      body: JSON.stringify(override ?? {}),
    }),
  previewPanel: (dashboardId: string, query: PanelQuery) =>
    resultFetch(`/api/v1/dashboards/${dashboardId}/panels/preview`, {
      method: 'POST',
      body: JSON.stringify(query),
    }),
};
