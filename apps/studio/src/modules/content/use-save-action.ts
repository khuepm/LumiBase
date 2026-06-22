import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveSaveAction, type SaveAction } from '@lumibase/shared/schemas';
import { getApiClient } from '@/lib/api';

/** Human label for a save action, e.g. for the save button + menu. */
export function saveActionLabel(action: SaveAction): string {
  switch (action) {
    case 'stay':
      return 'Save & stay';
    case 'return':
      return 'Save & return';
    case 'create_new':
      return 'Save & create new';
  }
}

/**
 * Resolve the effective Studio save action and expose a "set as default"
 * mutation. Reads the per-user preference from `/me` and the site default from
 * the site config, then applies the precedence
 * user → site → 'stay' (see resolveSaveAction). Save-default-preference Req 4–7.
 */
export function useSaveAction() {
  const client = getApiClient();
  const qc = useQueryClient();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await client.rawRequest<{ preferences?: { saveAction?: string } }>('/api/v1/auth/me')).data,
  });
  const siteQuery = useQuery({
    queryKey: ['site-config'],
    queryFn: async () => (await client.rawRequest<{ defaultSaveAction?: string }>('/api/v1/site')).data,
  });

  const userPref = meQuery.data?.preferences?.saveAction;
  const siteDefault = siteQuery.data?.defaultSaveAction;
  const effective = resolveSaveAction(userPref, siteDefault);

  const setDefaultMutation = useMutation({
    mutationFn: async (action: SaveAction | null) =>
      client.rawRequest('/api/v1/auth/me/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ saveAction: action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return {
    effective,
    userPref: userPref as SaveAction | undefined,
    siteDefault: siteDefault as SaveAction | undefined,
    setDefault: (action: SaveAction | null) => setDefaultMutation.mutate(action),
    isSettingDefault: setDefaultMutation.isPending,
  };
}
