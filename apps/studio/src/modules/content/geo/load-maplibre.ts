/**
 * Lazy MapLibre loader (#746). `maplibre-gl` (~1 MB + a ~0.5 MB worker) is
 * only fetched the first time a map is shown, as its own chunk — the main
 * Studio bundle does not grow.
 *
 * The worker is served as a same-origin file (Vite `?url` asset) and set with
 * `setWorkerUrl`, rather than MapLibre's default of a worker next to its own
 * module URL. That keeps it working under the CMS's `script-src 'self'` CSP
 * (Docker serves the Studio from the CMS), under `tauri://localhost` in the
 * desktop/mobile shell (where the default URL resolves to nothing), and on
 * any CDN host.
 */
import type * as MapLibre from 'maplibre-gl';

export type MapLibreModule = typeof MapLibre;

let pending: Promise<MapLibreModule> | null = null;

export function loadMaplibre(): Promise<MapLibreModule> {
  if (!pending) {
    pending = Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
      .then(([lib, worker]) => {
        lib.setWorkerUrl(worker.default);
        return lib;
      })
      .catch((err: unknown) => {
        // Let a later mount retry (e.g. a chunk that failed on a flaky network).
        pending = null;
        throw err;
      });
  }
  return pending;
}

/**
 * WebGL is required by MapLibre. Some webviews (and every test runner) lack
 * it; callers then show the manual lat/lng entry only (shell contract C5:
 * degrade, never throw).
 */
export function hasWebgl(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
