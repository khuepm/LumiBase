import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { router } from './router';
import { initI18n } from './lib/i18n';
import { SiteThemeStyle } from './components/site-theme';
import { getApiBaseUrl } from './lib/api-base';
import { isDesktopShell } from './lib/shell';
import { ServerConnection } from './components/server-connection';

/**
 * Root component. Hands off to TanStack Router; AppShell + active module
 * detection live inside the router tree.
 *
 * Inside the desktop/mobile shell the bundled SPA has no backend until the
 * user picks a server, so we gate on a resolved API base first.
 */
export function App() {
  const [i18nReady, setI18nReady] = useState(false);
  const [connected, setConnected] = useState(() => !isDesktopShell() || Boolean(getApiBaseUrl()));

  useEffect(() => {
    initI18n().finally(() => setI18nReady(true));
  }, []);

  if (!i18nReady) {
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
