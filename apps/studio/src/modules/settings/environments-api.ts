import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '@/lib/api';

/** Content Environments (#853) — Studio side of `/api/v1/environments`. */
export const ENVIRONMENTS_BASE = '/api/v1/environments';
export const RELEASE_FLAG = 'content-environments';

export type ContentScope = { mode: 'none' } | { mode: 'all' } | { mode: 'collections'; collections: string[] };

export interface EnvironmentView {
  id: string;
  key: string;
  name: string;
  status: 'forking' | 'ready' | 'merging' | 'failed' | 'archived';
  statusReason: string | null;
  /** The child site Studio switches to. */
  siteId: string;
  originSiteId: string;
  contentScope: ContentScope;
  progress: { phase: string; counts: Record<string, number> };
  forkedAt: string | null;
  mergedAt: string | null;
  createdAt: string;
  originChanged?: boolean;
  changedItems?: number | null;
  truncated?: boolean;
}

export interface SchemaPlanEntry {
  kind: 'collection' | 'field' | 'relation';
  key: string;
  collection: string;
  action: 'unchanged' | 'origin-only' | 'create' | 'update' | 'rename' | 'delete' | 'conflict' | 'blocked';
  renameFrom?: string;
  changes?: string[];
  risk: 'low' | 'medium' | 'high';
  requires?: Array<'confirmRiskyChange' | 'migrationPlan'>;
  reason?: string;
}

export interface SchemaPlan {
  entries: SchemaPlanEntry[];
  counts: Record<string, number>;
  pendingCollections: string[];
  clean: boolean;
}

export interface ContentPlanItem {
  collection: string;
  itemId: string;
  action: 'unchanged' | 'promote' | 'origin-only' | 'conflict' | 'create' | 'delete' | 'skip' | 'blocked';
  reason?: string;
  changedFields?: string[];
}

export interface ContentPlan {
  items: ContentPlanItem[];
  counts: Record<string, number>;
  truncated: boolean;
}

/** Whether the release flag is on for the active site (members only see released flags). */
export function useEnvironmentsEnabled(): boolean {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['release-flags'],
    queryFn: async () => (await client.rawRequest<Array<{ key: string; enabled: boolean }>>('/api/v1/release-flags')).data,
    staleTime: 60_000,
    retry: false,
  });
  return (query.data ?? []).some((f) => f.key === RELEASE_FLAG && f.enabled);
}

/** The marker of an environment's child site, or null on an ordinary site. */
export function useEnvironmentMarker(): { originSiteId: string; key: string } | null {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['environment-marker'],
    queryFn: async () => {
      try {
        const res = await client.rawRequest<{ value?: { originSiteId?: string; key?: string } }>('/api/v1/settings/environment.origin');
        const v = res.data?.value;
        return v && typeof v.originSiteId === 'string' ? { originSiteId: v.originSiteId, key: String(v.key ?? '') } : null;
      } catch {
        return null;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
  return query.data ?? null;
}
