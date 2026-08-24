import { Navigate, type RouteObject } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LegacyRedirect } from './components/LegacyRedirect';
import { LocaleGuard } from './components/LocaleGuard';
import { DocPage } from './pages/DocPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { getPreferredLocale } from './lib/locale-storage';

/**
 * Root (`/`) → the previously chosen locale's landing page (defaultLocale on
 * first visit, during SSR, or when no preference is stored).
 *
 * Only the bare locale prefix is redirected, never a doc slug: `/` and `/en/`
 * both resolve to a real, styled LandingPage rather than bouncing on to
 * docs/README. The prerenderer renders that same page through this route tree,
 * so the static HTML and the hydrated app agree and nothing flashes.
 */
function RootRedirect() {
  return <Navigate to={`/${getPreferredLocale()}/`} replace />;
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
      { index: true, element: <LandingPage /> },
      { path: 'docs/*', element: <DocPage /> },
    ],
  },

  // Catch-all 404
  {
    path: '*',
    element: <NotFoundPage />,
  },
];