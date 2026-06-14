import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { router } from './router';
import { initI18n } from './lib/i18n';
import { SiteThemeStyle } from './components/site-theme';

/**
 * Root component. Hands off to TanStack Router; AppShell + active module
 * detection live inside the router tree.
 */
export function App() {
  const [i18nReady, setI18nReady] = useState(false);

  useEffect(() => {
    initI18n().finally(() => setI18nReady(true));
  }, []);

  if (!i18nReady) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading Studio…</div>;
  }

  return (
    <>
      <SiteThemeStyle />
      <RouterProvider router={router} />
    </>
  );
}
