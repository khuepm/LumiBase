import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { siteConfig } from './lib/site-config';
import './index.css';

// Apply the configured color mode (docs.config.json → themeConfig.colorMode).
// index.html ships with class="dark" to avoid a flash of light theme; this
// keeps the class in sync with the config so a "light" default still works.
document.documentElement.classList.toggle(
  'dark',
  siteConfig.themeConfig?.colorMode?.defaultMode === 'dark',
);

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