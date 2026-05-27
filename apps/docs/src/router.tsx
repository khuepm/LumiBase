import { createBrowserRouter, Navigate, useParams, useLocation } from 'react-router-dom';
import { locales, defaultLocale } from 'virtual:docs-registry';
import { Layout } from './components/Layout';
import { DocPage } from './pages/DocPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { pathFor } from './lib/url';

/**
 * LocaleGuard — validates that the :locale param is a known locale.
 * Renders children (Outlet via Layout) if valid, otherwise renders NotFoundPage.
 * Preserves URL so user can see the invalid path.
 *
 * Will be properly implemented in task 3.4.
 * Requirements: 2.4
 */
function LocaleGuard({ children }: { children: React.ReactNode }) {
  const { locale } = useParams<{ locale: string }>();

  if (!locale || !locales.includes(locale)) {
    return <NotFoundPage />;
  }

  return <>{children}</>;
}

/**
 * LegacyRedirect — redirects legacy prefix-less URLs (/docs/{slug})
 * to the locale-prefixed equivalent (/{defaultLocale}/docs/{slug}).
 *
 * Will be properly implemented in task 3.5.
 * Requirements: 2.3
 */
function LegacyRedirect() {
  const location = useLocation();

  // Extract slug from /docs/* pattern
  const slug = location.pathname.replace(/^\/docs\/?/, '') || 'README';

  return <Navigate to={pathFor(defaultLocale, slug)} replace />;
}

/**
 * Application router using React Router v7 (library mode).
 * Uses HTML5 History API (createBrowserRouter) — no hash fragments.
 *
 * Routes:
 * - /                    → Redirect to /{defaultLocale}/docs/README
 * - /docs/*              → LegacyRedirect to /{defaultLocale}/docs/{slug}
 * - /:locale             → LocaleGuard validates locale; child routes:
 *   - index              → Redirect to docs/README
 *   - docs/*             → DocPage
 * - *                    → NotFoundPage (404)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.6
 */
export const router = createBrowserRouter([
  // Root → default locale README
  {
    path: '/',
    element: <Navigate to={pathFor(defaultLocale, 'README')} replace />,
  },

  // Legacy prefix-less URL → redirect to default locale
  {
    path: '/docs/*',
    element: <LegacyRedirect />,
  },

  // Locale-prefixed routes
  {
    path: '/:locale',
    element: (
      <LocaleGuard>
        <Layout />
      </LocaleGuard>
    ),
    children: [
      { index: true, element: <Navigate to="docs/README" replace /> },
      { path: 'docs/*', element: <DocPage /> },
    ],
  },

  // Catch-all 404
  {
    path: '*',
    element: <NotFoundPage />,
  },
]);
