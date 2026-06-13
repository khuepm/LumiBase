import { createBrowserRouter } from 'react-router-dom';
import { routes } from './routes';

/**
 * Application router using React Router v7 (library mode).
 * Uses HTML5 History API (createBrowserRouter) — no hash fragments.
 *
 * Route configuration lives in ./routes so the same tree can be reused by
 * the prerender/SSR pipeline (createStaticHandler) in entry-server.tsx.
 */
export const router = createBrowserRouter(routes);