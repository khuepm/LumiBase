import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Singleton collections open straight in the form (#694). A singleton holds
 * one item (site settings, a home page), so its list view is a detour: the
 * list route redirects to that item, or to the create form while it does not
 * exist yet. `?list=1` keeps the list (e.g. to clean up duplicates).
 *
 * Returns true while the redirect is in flight, so the caller can render a
 * placeholder instead of an empty table.
 */
export function useSingletonRedirect(
  collection: string,
  singleton: boolean | undefined,
  enabled: boolean,
  forceList: boolean,
): boolean {
  const client = getApiClient();
  const navigate = useNavigate();
  const active = singleton === true && enabled && !forceList;
  const first = useQuery({
    queryKey: ['singleton-item', collection],
    queryFn: async () =>
      (await client.items(collection as never).list({ limit: 1, sort: ['created_at'] })).data as Array<{ id: string }>,
    enabled: active,
  });
  useEffect(() => {
    if (!active || !first.data) return;
    const id = first.data[0]?.id ?? 'new';
    void navigate({ to: '/content/$collection/$id', params: { collection, id }, replace: true });
  }, [active, first.data, collection, navigate]);
  return active && !first.error;
}

/** Whether the URL asks to keep the list view of a singleton. */
export function wantsListView(search: unknown): boolean {
  const v = (search as Record<string, unknown> | null | undefined)?.list;
  return v === 1 || v === '1' || v === true || v === 'true';
}
