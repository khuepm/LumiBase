import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getActiveSite, getApiClient } from '@/lib/api';

/**
 * Release flags in Studio (#895, epic #869).
 *
 * `GET /api/v1/release-flags` answers members with `{ key, enabled }` for
 * released flags only, and site admins with every flag and how it was decided.
 * Studio reads it once per session and site (`staleTime: Infinity`) and hides
 * the UI of a feature whose flag is off. The server still enforces every flag
 * (gated routes answer 404), so hiding is a convenience, not a guard.
 *
 * Calls go through `getApiClient()` so the base URL and bearer token follow
 * the desktop/mobile shell contract (DoD §2d).
 */

export const RELEASE_FLAGS_PATH = '/api/v1/release-flags';
export const RELEASE_FLAGS_SITE_PATH = '/api/v1/release-flags/site';

export type ReleaseStage = 'dark' | 'beta' | 'ga';
export type ReleasedBy = 'env' | 'manifest' | 'stage';
export type EnabledBy = 'release' | 'site' | 'site-default';

/** What every member receives. */
export interface ReleaseFlagSummary {
  key: string;
  enabled: boolean;
}

/** What a site admin receives. */
export interface ReleaseFlagDetail extends ReleaseFlagSummary {
  stage: ReleaseStage;
  released: boolean;
  releasedBy: ReleasedBy;
  enabledBy: EnabledBy;
  siteValue: boolean | null;
  description: string;
  siteToggle: boolean;
  siteDefault: boolean;
  owner: string;
  removeBy: string;
}

export type ReleaseFlagEntry = ReleaseFlagSummary | ReleaseFlagDetail;

export function isReleaseFlagDetail(entry: ReleaseFlagEntry): entry is ReleaseFlagDetail {
  return 'stage' in entry && 'released' in entry;
}

export const releaseFlagsQueryKey = (siteId: string) => ['release-flags', siteId] as const;

export async function fetchReleaseFlags(): Promise<ReleaseFlagEntry[]> {
  const res = await getApiClient().rawRequest<ReleaseFlagEntry[]>(RELEASE_FLAGS_PATH);
  return Array.isArray(res.data) ? res.data : [];
}

/** `null` clears the site's choice (back to the flag's site default). */
export async function saveSiteReleaseFlags(
  flags: Record<string, boolean | null>,
): Promise<{ stored: Record<string, boolean> }> {
  const res = await getApiClient().rawRequest<{ stored: Record<string, boolean> }>(RELEASE_FLAGS_SITE_PATH, {
    method: 'PUT',
    body: JSON.stringify({ flags }),
  });
  return res.data;
}

/** Every flag visible to the caller for the active site, fetched once per session. */
export function useReleaseFlags() {
  const siteId = getActiveSite();
  return useQuery({
    queryKey: releaseFlagsQueryKey(siteId),
    queryFn: fetchReleaseFlags,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Whether a flagged feature's UI should show. `undefined` while loading;
 * `false` when the flag is off, unreleased (members do not even see the key)
 * or the list could not be read — a dark feature stays hidden on error.
 */
export function useReleaseFlag(key: string): boolean | undefined {
  const query = useReleaseFlags();
  if (query.isLoading) return undefined;
  return query.data?.some((flag) => flag.key === key && flag.enabled) ?? false;
}

/**
 * Render `children` only while `flag` is on for the active site; `fallback`
 * (default nothing) while loading or off.
 *
 *   <ReleaseFlagGate flag="content-environments"><EnvironmentsMenu /></ReleaseFlagGate>
 */
export function ReleaseFlagGate({
  flag,
  children,
  fallback = null,
}: {
  flag: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <>{useReleaseFlag(flag) === true ? children : fallback}</>;
}
