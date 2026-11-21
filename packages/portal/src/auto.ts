/**
 * Script-tag entry (`portal.min.js`): defines `<lumi-portal>` and mounts
 * every `[data-lumi-portal]` element (`data-api`, `data-site`, …).
 */

import { definePortalElement, optionsFromAttributes } from './element';
import { mountPortal } from './mount';

function boot(): void {
  try {
    definePortalElement();
    for (const node of Array.from(document.querySelectorAll('[data-lumi-portal]'))) {
      mountPortal(node, optionsFromAttributes(node));
    }
  } catch (err) {
    console.warn('[lumibase-portal] failed to start', err);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
