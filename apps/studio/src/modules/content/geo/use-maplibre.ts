import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { hasWebgl, loadMaplibre, type MapLibreModule } from './load-maplibre';
import { WORLD_VIEW } from './map-config';

export type MapStatus = 'loading' | 'ready' | 'unavailable';

export interface MapHandle {
  status: MapStatus;
  map: MapLibreMap | null;
  lib: MapLibreModule | null;
}

/**
 * Mount a MapLibre map into `container` once it is in the DOM. Resolves to
 * `unavailable` (never throws) when WebGL is missing, the chunk fails to load
 * or the map constructor throws — callers keep their non-map fallback.
 */
export function useMaplibre(
  container: RefObject<HTMLDivElement | null>,
  styleUrl: string,
  initial: { center: [number, number]; zoom: number } = WORLD_VIEW,
): MapHandle {
  const [handle, setHandle] = useState<MapHandle>({ status: 'loading', map: null, lib: null });
  const initialRef = useRef(initial);

  useEffect(() => {
    if (!hasWebgl()) {
      setHandle({ status: 'unavailable', map: null, lib: null });
      return;
    }
    let cancelled = false;
    let map: MapLibreMap | null = null;
    loadMaplibre()
      .then((lib) => {
        if (cancelled || !container.current) return;
        map = new lib.Map({
          container: container.current,
          style: styleUrl,
          center: initialRef.current.center,
          zoom: initialRef.current.zoom,
          attributionControl: { compact: true },
        });
        map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        setHandle({ status: 'ready', map, lib });
      })
      .catch(() => {
        if (!cancelled) setHandle({ status: 'unavailable', map: null, lib: null });
      });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [container, styleUrl]);

  return handle;
}
