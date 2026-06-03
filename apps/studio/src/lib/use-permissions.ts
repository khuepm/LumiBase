import { useQuery } from '@tanstack/react-query';
import type { CompiledPermission, PermissionAction, PermissionBundle } from '@lumibase/sdk';
import { getApiClient } from './api';

/**
 * Studio-wide permission hook. Fetches `/permissions/me` once per session
 * (cache TTL aligned with the server-side KV TTL of 60s) and exposes helpers
 * to gate UI surfaces (columns, fields, bulk actions) without each component
 * having to know the bundle shape.
 *
 * Server contract (see `apps/cms/src/services/permission-service.ts`):
 *   - `admin: true` → bypass everything (all actions on all collections allowed,
 *     all fields readable/writable).
 *   - Otherwise look up `byKey["${collection}::${action}"]`. Missing entry =
 *     denied. `fields: ["*"]` = all fields; `fields: ["-secret"]` = blacklist.
 */

export interface PermissionHelpers {
  bundle: PermissionBundle | undefined;
  isLoading: boolean;
  /** Admin bypass — all actions, all fields allowed. */
  isAdmin: boolean;
  /** True if the principal can perform `action` on `collection`. */
  can: (collection: string, action: PermissionAction) => boolean;
  /** Fetch the compiled permission for `(collection, action)`. */
  get: (collection: string, action: PermissionAction) => CompiledPermission | null;
  /**
   * Resolve whether `field` is readable/writable under `(collection, action)`.
   * Honours `["*"]` and the `-prefix` exclusion form.
   */
  fieldAllowed: (collection: string, action: PermissionAction, field: string) => boolean;
  /** Filter a list of field names down to the allowed ones. */
  filterFields: (collection: string, action: PermissionAction, fields: string[]) => string[];
}

const ALL = ['*'];

export function usePermissions(): PermissionHelpers {
  const client = getApiClient();
  const query = useQuery({
    queryKey: ['permissions-me'],
    queryFn: async () => (await client.permissions.me()).data,
    // Match KV TTL on the worker side; tweak if it drifts.
    staleTime: 60_000,
    retry: 0,
  });

  const bundle = query.data;
  const isAdmin = !!bundle?.admin;

  const get = (collection: string, action: PermissionAction): CompiledPermission | null => {
    if (!bundle) return null;
    if (bundle.admin) {
      return {
        collection,
        action,
        rule: null,
        fields: ALL,
        presets: {},
        validation: {},
        sources: [{ policyId: 'admin', policyName: 'Admin bypass' }],
      };
    }
    return bundle.byKey[`${collection}::${action}`] ?? null;
  };

  const can = (collection: string, action: PermissionAction): boolean => {
    return !!get(collection, action);
  };

  const fieldAllowed = (
    collection: string,
    action: PermissionAction,
    field: string,
  ): boolean => {
    const perm = get(collection, action);
    if (!perm) return false;
    return matchField(perm.fields, field);
  };

  const filterFields = (
    collection: string,
    action: PermissionAction,
    fields: string[],
  ): string[] => {
    const perm = get(collection, action);
    if (!perm) return [];
    if (perm.fields.includes('*')) {
      const excludes = perm.fields.filter((f) => f.startsWith('-')).map((f) => f.slice(1));
      return fields.filter((f) => !excludes.includes(f));
    }
    const excludes = perm.fields.filter((f) => f.startsWith('-')).map((f) => f.slice(1));
    const includes = perm.fields.filter((f) => !f.startsWith('-'));
    return fields.filter((f) => includes.includes(f) && !excludes.includes(f));
  };

  return {
    bundle,
    isLoading: query.isLoading,
    isAdmin,
    can,
    get,
    fieldAllowed,
    filterFields,
  };
}

function matchField(whitelist: string[], field: string): boolean {
  const excludes = whitelist.filter((f) => f.startsWith('-')).map((f) => f.slice(1));
  if (excludes.includes(field)) return false;
  if (whitelist.includes('*')) return true;
  return whitelist.includes(field);
}
