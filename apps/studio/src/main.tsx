import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { applyDocumentLanguage } from './lib/text-direction';
import { readStoredUiLanguage } from './lib/ui-language';
import { createResilientQueryClient } from './lib/request-resilience';

// Set `<html lang dir>` before the first paint so an RTL user does not see the
// loading screen flash left-to-right (#761). `initI18n` keeps it in sync after.
applyDocumentLanguage(readStoredUiLanguage() ?? 'en');

// Transient failures (offline, 429, 502–504) retry with backoff and surface a
// "Try again" dialog instead of blanking the page (#694).
const queryClient = createResilientQueryClient();

// Extension hot reload (#754): dev server only — the branch is removed from
// production builds, and the client itself refuses outside `import.meta.env.DEV`.
if (import.meta.env.DEV) {
  void import('./lib/extension-dev-client').then((m) => m.startExtensionDevClient());
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
