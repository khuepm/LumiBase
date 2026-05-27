import { useParams } from 'react-router-dom';
import { locales } from 'virtual:docs-registry';
import { NotFoundPage } from '../pages/NotFoundPage';

/**
 * LocaleGuard — validates that the :locale param is a known locale.
 * Renders children (Outlet via Layout) if valid, otherwise renders NotFoundPage.
 * Preserves URL so user can see the invalid path (no redirect).
 *
 * Requirements: 2.4
 */
export function LocaleGuard({ children }: { children: React.ReactNode }) {
  const { locale } = useParams<{ locale: string }>();

  if (!locale || !locales.includes(locale)) {
    return <NotFoundPage />;
  }

  return <>{children}</>;
}
