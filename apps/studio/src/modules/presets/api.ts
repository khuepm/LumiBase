import { getActiveSite, getActiveToken } from '@/lib/api';

/**
 * View-preset API access. Thin typed fetchers over `/api/v1/presets`, same
 * auth-header convention as the rest of Studio. See
 * `.kiro/specs/presets-inheritance`.
 */

export type PresetScope = 'user' | 'role' | 'global';

export interface ViewPreset {
  id: string;
  bookmark: string | null;
  collection: string;
  userId: string | null;
  roleId: string | null;
  layout: string;
  layoutQuery: Record<string, unknown>;
  layoutOptions: Record<string, unknown>;
  search: string | null;
  filter: Record<string, unknown>;
  icon: string | null;
  color: string | null;
  refreshInterval: number;
}

export interface ScopedViewPreset extends ViewPreset {
  sourceScope: PresetScope;
  roleDistance?: number;
}

async function presetFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(`/api/v1/presets${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'x-site-id': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

export function getEffectivePreset(collection: string): Promise<ScopedViewPreset | null> {
  return presetFetch<ScopedViewPreset | null>(`/effective?collection=${encodeURIComponent(collection)}`);
}

export function listBookmarks(collection: string): Promise<ScopedViewPreset[]> {
  return presetFetch<ScopedViewPreset[]>(`/bookmarks?collection=${encodeURIComponent(collection)}`);
}

/** The user's default view for a collection (bookmark = null). */
export function saveUserView(input: Partial<ViewPreset> & { collection: string }): Promise<ViewPreset> {
  return presetFetch<ViewPreset>('', { method: 'POST', body: JSON.stringify({ ...input, bookmark: null }) });
}

export function createBookmark(
  input: Partial<ViewPreset> & { collection: string; bookmark: string; roleId?: string | null },
): Promise<ViewPreset> {
  return presetFetch<ViewPreset>('', { method: 'POST', body: JSON.stringify(input) });
}

export function updateBookmark(id: string, input: Partial<ViewPreset>): Promise<ViewPreset> {
  return presetFetch<ViewPreset>(`/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteBookmark(id: string): Promise<null> {
  return presetFetch<null>(`/${id}`, { method: 'DELETE' });
}

/** The shape of a collection view a preset captures. */
export interface ViewState {
  layout?: string;
  layoutQuery?: Record<string, unknown>;
  layoutOptions?: Record<string, unknown>;
  search?: string | null;
  filter?: Record<string, unknown>;
}

/** True when two view states differ (used to decide whether to persist). */
export function viewDiffers(a: ViewState, b: ViewState): boolean {
  return JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b));
}

function normalize(v: ViewState): ViewState {
  return {
    layout: v.layout ?? 'tabular',
    layoutQuery: v.layoutQuery ?? {},
    layoutOptions: v.layoutOptions ?? {},
    search: v.search ?? null,
    filter: v.filter ?? {},
  };
}
