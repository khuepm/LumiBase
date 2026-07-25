import { Navigate, useLocation } from 'react-router-dom';
import { pathFor } from '../lib/url';
import { getPreferredLocale } from '../lib/locale-storage';

/**
 * LegacyRedirect — redirects legacy prefix-less URLs (/docs/{slug})
 * to the locale-prefixed equivalent, using the visitor's previously
 * chosen locale (see useLocale) when one is stored, otherwise
 * defaultLocale.
 *
 * Requirements: 2.3
 */
export function LegacyRedirect() {
  const location = useLocation();

  // Extract slug from /docs/* pattern
  const slug = location.pathname.replace(/^\/docs\/?/, '') || 'README';

  return <Navigate to={pathFor(getPreferredLocale(), slug)} replace />;
}
