import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';

/**
 * Top-level Studio module segments. These are valid first path segments on
 * an instance served WITHOUT an admin-path prefix, and several of them
 * ('files', 'settings', 'mission-control', …) also match ADMIN_PATH_REGEX —
 * so the regex alone cannot tell `/mission-control` (a module at root) from
 * `/{adminPath}`. Anything in this set is never treated as an admin prefix.
 */
const MODULE_SEGMENTS = new Set([
  'content',
  'files',
  'users',
  'access',
  'data-model',
  'automation',
  'mission-control',
  'cdc',
  'settings',
  'recovery',
]);

/** Optional `/{adminPath}` prefix of a Studio pathname ('' when absent). */
export function getAdminBase(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || MODULE_SEGMENTS.has(first)) return '';
  const candidate = `/${first}`;
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : '';
}
