import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';

// Theme is bootstrapped by the inline no-flash script in index.html (runs
// before paint) and then kept in sync by the useTheme hook after hydration.

const rootEl = document.getElementById('root')!;

// Prerendered pages ship server-rendered markup inside #root → hydrate it.
// The SPA-fallback shell (dist/index.html) has an empty #root → mount fresh.
if (rootEl.hasChildNodes()) {
  ReactDOM.hydrateRoot(
    rootEl,
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}