import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { router } from './router';
import { initI18n } from './lib/i18n';
import { SiteThemeStyle } from './components/site-theme';
import { getApiBaseUrl } from './lib/api-base';
import { isDesktopShell } from './lib/shell';
import { ServerConnection } from './components/server-connection';
import { hydrateTokens } from './lib/token-store';

/**
 * Root component. Hands off to TanStack Router; AppShell + active module
 * detection live inside the router tree.
 *
 * Inside the desktop/mobile shell the bundled SPA has no backend until the
 * user picks a server, so we gate on a resolved API base first.
 */
export function App() {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(() => !isDesktopShell() || Boolean(getApiBaseUrl()));

  useEffect(() => {
    // Hydrate persisted tokens (OS keychain in the shell) before the router
    // reads them, in parallel with i18n init.
    Promise.all([initI18n(), hydrateTokens()]).finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Studio…</div>;
  }

  if (!connected) {
    return <ServerConnection onConnected={() => setConnected(true)} />;
  }

  return (
    <>
      <SiteThemeStyle />
      <RouterProvider router={router} />
    </>
  );
}
