import { Navigate, useLocation } from 'react-router-dom';
import { defaultLocale } from 'virtual:docs-registry';
import { pathFor } from '../lib/url';

/**
 * LegacyRedirect — redirects legacy prefix-less URLs (/docs/{slug})
 * to the locale-prefixed equivalent (/{defaultLocale}/docs/{slug}).
 *
 * Requirements: 2.3
 */
export function LegacyRedirect() {
  const location = useLocation();

  // Extract slug from /docs/* pattern
  const slug = location.pathname.replace(/^\/docs\/?/, '') || 'README';

  return <Navigate to={pathFor(defaultLocale, slug)} replace />;
}
