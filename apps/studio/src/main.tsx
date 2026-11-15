import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { applyDocumentLanguage } from './lib/text-direction';
import { readStoredUiLanguage } from './lib/ui-language';

// Set `<html lang dir>` before the first paint so an RTL user does not see the
// loading screen flash left-to-right (#761). `initI18n` keeps it in sync after.
applyDocumentLanguage(readStoredUiLanguage() ?? 'en');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
