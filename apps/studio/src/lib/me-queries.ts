import { queryOptions } from '@tanstack/react-query';
import type { PermissionBundle, UserPreferencesPayload } from '@lumibase/sdk';
import { getApiClient } from './api';

/**
 * Shared React Query definitions for the per-user reads every Studio boot
 * makes (#757 — "batch permission checks on boot").
 *
 * Before, the compiled permission bundle (`GET /permissions/me`) was cached
 * under two different keys (`['me','permissions']` in the shell and
 * `['permissions-me']` in `usePermissions`), and the preferences blob
 * (`GET /me/preferences`) under two more (`['me','preferences']`,
 * `['me-preferences']`) with two different data shapes. React Query only
 * de-duplicates identical keys, so a cold boot onto a content page fired each
 * endpoint twice. Every caller now goes through these options, so boot makes
 * exactly one request per endpoint — two in total — no matter how many
 * components ask.
 *
 * Keep the keys stable: mutations invalidate them (`invalidateQueries`).
 */

export const PERMISSIONS_QUERY_KEY = ['permissions-me'] as const;
export const ME_PREFERENCES_QUERY_KEY = ['me-preferences'] as const;

/** Compiled permission bundle for the signed-in principal. */
export function permissionsQueryOptions() {
  return queryOptions({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: async (): Promise<PermissionBundle> => (await getApiClient().permissions.me()).data,
    // Match the server-side KV TTL of the compiled bundle.
    staleTime: 60_000,
  });
}

/** The user's preferences blob (keybindings, navigation, language, save action). */
export function mePreferencesQueryOptions() {
  return queryOptions({
    queryKey: ME_PREFERENCES_QUERY_KEY,
    // `rawRequest` (not `me.getPreferences`) so every caller hits the identical
    // request shape the existing component tests stub.
    queryFn: async (): Promise<UserPreferencesPayload> =>
      (await getApiClient().rawRequest<UserPreferencesPayload>('/api/v1/me/preferences')).data ?? {},
    staleTime: 5 * 60_000,
  });
}
