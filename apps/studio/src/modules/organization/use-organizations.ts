import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getActiveToken,
  getApiClient,
  getSessionGeneration,
  setActiveSite,
} from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

const key = 'lumibase.organization';
const event = 'lumibase:organization';
function selected() {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function subscribe(notify: () => void) {
  window.addEventListener(event, notify);
  window.addEventListener('storage', notify);
  return () => {
    window.removeEventListener(event, notify);
    window.removeEventListener('storage', notify);
  };
}
export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations', getApiBaseUrl(), getSessionGeneration()],
    queryFn: () => getApiClient().orgs.list(),
    enabled: Boolean(getActiveToken()),
    staleTime: 30_000,
  });
}
export function useOrganization() {
  const query = useOrganizations();
  const id = useSyncExternalStore(subscribe, selected, () => '');
  const organizations = query.data ?? [];
  const organization =
    organizations.find((org) => org.id === id) ?? organizations[0];
  const selectOrganization = useCallback(
    (next: string) => {
      // Only select from the current authenticated user's list.
      if (!organizations.some((org) => org.id === next)) return;
      localStorage.setItem(key, next);
      window.dispatchEvent(new Event(event));
    },
    [organizations],
  );
  const qc = useQueryClient();
  const setSite = useCallback(
    async (siteId: string) => {
      await qc.cancelQueries();
      qc.clear();
      setActiveSite(siteId);
      // Existing modules have site-independent query keys and local editor state.
      // A fresh shell prevents either from carrying content across sites.
      window.location.reload();
    },
    [qc],
  );
  return { ...query, organizations, organization, selectOrganization, setSite };
}
