import { Navigate, type RouteObject } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LegacyRedirect } from './components/LegacyRedirect';
import { LocaleGuard } from './components/LocaleGuard';
import { DocPage } from './pages/DocPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { pathFor } from './lib/url';
import { getPreferredLocale } from './lib/locale-storage';

/**
 * Root → previously chosen locale's README (defaultLocale on first visit,
 * during SSR, or when no preference is stored).
 */
function RootRedirect() {
  return <Navigate to={pathFor(getPreferredLocale(), 'README')} replace />;
}

/**
 * Shared route configuration used by both the client (createBrowserRouter)
 * and the prerender/SSR pipeline (createStaticHandler + createStaticRouter).
 *
 * Keeping a single source of truth guarantees the prerendered HTML and the
 * hydrated client app resolve identical route trees.
 */
export const routes: RouteObject[] = [
  // Root → default locale README
  {
    path: '/',
    element: <RootRedirect />,
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
];