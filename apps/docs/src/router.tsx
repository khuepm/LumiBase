import { createBrowserRouter, Navigate } from 'react-router-dom';
import { defaultLocale } from 'virtual:docs-registry';
import { Layout } from './components/Layout';
import { LegacyRedirect } from './components/LegacyRedirect';
import { LocaleGuard } from './components/LocaleGuard';
import { DocPage } from './pages/DocPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { pathFor } from './lib/url';

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
