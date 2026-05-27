import { useLocation } from 'react-router-dom';
import { parseUrl } from '../lib/url';

/**
 * Extract the current doc slug from the URL pathname.
 * Returns empty string if the URL doesn't match the expected pattern.
 */
export function useCurrentSlug(): string {
  const { pathname } = useLocation();
  const parsed = parseUrl(pathname);
  return parsed?.slug ?? '';
}
