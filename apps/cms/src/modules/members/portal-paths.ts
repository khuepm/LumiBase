/**
 * Paths of the member Portal (epic #672), shared by the router and the
 * middleware that must let the public ones through without a session — kept
 * dependency-free so `withAuth` does not import the router.
 */

export const PORTAL_PREFIX = '/api/v1/portal';

const PUBLIC_PATHS = new Set([
  `${PORTAL_PREFIX}/config`,
  `${PORTAL_PREFIX}/signup-card`,
  `${PORTAL_PREFIX}/magic-link`,
  `${PORTAL_PREFIX}/magic-link/verify`,
]);

/** Paths `withAuth` lets through without a session. Exact match only. */
export function isPortalPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path.length > 1 ? path.replace(/\/+$/, '') : path);
}
