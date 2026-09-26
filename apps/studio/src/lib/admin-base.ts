import type { LocationRewrite } from '@tanstack/react-router';
import {
  ADMIN_PATH_REGEX,
  DEFAULT_ADMIN_PATHS_BLACKLIST,
  RESERVED_PATH_PREFIXES,
} from '@/modules/setup/schemas/admin-path';

/**
 * Top-level Studio module segments that the router also registers under
 * `/$adminPath`. Several ('files', 'settings', 'mission-control', …) match
 * ADMIN_PATH_REGEX, so the regex alone cannot tell `/mission-control` (a
 * module at root) from `/{adminPath}`.
 */
const PREFIXABLE_SEGMENTS = new Set([
  'content',
  'files',
  'users',
  'access',
  'data-model',
  'automation',
  'mission-control',
  'insights',
  'cdc',
  'settings',
  'recovery',
]);

/** Segments that are never an admin prefix (modules + root-only routes). */
const NON_PREFIX_SEGMENTS = new Set([...PREFIXABLE_SEGMENTS, 'teams']);

const BLACKLIST = new Set(DEFAULT_ADMIN_PATHS_BLACKLIST);

/** Optional `/{adminPath}` prefix of a Studio pathname ('' when absent). */
export function getAdminBase(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || NON_PREFIX_SEGMENTS.has(first)) return '';
  const candidate = `/${first}`;
  if (BLACKLIST.has(candidate) || RESERVED_PATH_PREFIXES.includes(candidate)) return '';
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : '';
}

/**
 * Re-applies `adminBase` to an app-internal pathname. Links written as
 * `/content/...` would otherwise drop the private prefix, which works on
 * client-side navigation but 404s on reload behind the CMS.
 */
export function withAdminPrefix(pathname: string, adminBase: string): string {
  if (!adminBase) return pathname;
  if (pathname === '/' || pathname === '') return adminBase;
  const first = pathname.split('/').filter(Boolean)[0];
  return first && PREFIXABLE_SEGMENTS.has(first) ? `${adminBase}${pathname}` : pathname;
}

export const adminBaseRewrite: LocationRewrite = {
  output: ({ url }) => {
    if (typeof window === 'undefined') return undefined;
    const next = withAdminPrefix(url.pathname, getAdminBase(window.location.pathname));
    if (next === url.pathname) return undefined;
    const out = new URL(url.href);
    out.pathname = next;
    return out;
  },
};
