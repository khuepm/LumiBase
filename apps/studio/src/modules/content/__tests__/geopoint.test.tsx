// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';

// ── Fake MapLibre: enough surface for the input and the layout ──────────────
type Handler = (e: unknown) => void;
class FakeEvented {
  handlers = new Map<string, Set<Handler>>();
  on(type: string, fn: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return this;
  }
  off(type: string, fn: Handler) {
    this.handlers.get(type)?.delete(fn);
    return this;
  }
  fire(type: string, e: unknown = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}
const maps: FakeMap[] = [];
const markers: FakeMarker[] = [];
class FakeMap extends FakeEvented {
  options: Record<string, unknown>;
  bounds = { west: 100, south: 10, east: 110, north: 20 };
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    maps.push(this);
  }
  addControl() {
    return this;
  }
  remove() {}
  easeTo = vi.fn();
  fitBounds = vi.fn();
  getZoom() {
    return 5;
  }
  getBounds() {
    const b = this.bounds;
    return { getWest: () => b.west, getSouth: () => b.south, getEast: () => b.east, getNorth: () => b.north };
  }
}
class FakeMarker extends FakeEvented {
  lngLat: [number, number] | null = null;
  el = document.createElement('div');
  draggable: boolean;
  removed = false;
  constructor(opts: { draggable?: boolean } = {}) {
    super();
    this.draggable = Boolean(opts.draggable);
    markers.push(this);
  }
  setLngLat(ll: [number, number]) {
    this.lngLat = ll;
    return this;
  }
  getLngLat() {
    return { lng: this.lngLat![0], lat: this.lngLat![1] };
  }
  addTo() {
    return this;
  }
  remove() {
    this.removed = true;
    return this;
  }
  setDraggable(d: boolean) {
    this.draggable = d;
    return this;
  }
  getElement() {
    return this.el;
  }
}
class FakeBounds {
  points: Array<[number, number]> = [];
  extend(p: [number, number]) {
    this.points.push(p);
    return this;
  }
}
const fakeLib = { Map: FakeMap, Marker: FakeMarker, NavigationControl: class {}, LngLatBounds: FakeBounds };

const geo = vi.hoisted(() => ({ webgl: true, fail: false }));
vi.mock('../geo/load-maplibre', () => ({
  hasWebgl: () => geo.webgl,
  loadMaplibre: () => (geo.fail ? Promise.reject(new Error('chunk failed')) : Promise.resolve(fakeLib)),
}));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, params }: { children: ReactNode; params: { id: string } }) => <a href={`/item/${params.id}`}>{children}</a>,
}));

const list = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ items: () => ({ list }) }) }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined, useExtensionUpdates: () => 0 }));

import { GeopointInterface } from '../interfaces/geopoint';
import { GeopointDisplay } from '../displays/geopoint';
import { resolveInterface } from '../interfaces/registry';
import { resolveDisplay } from '../displays/registry';
import { findInterfaceCatalogueItem } from '../interfaces/catalogue';
import { MapLayout, boundsToBBox, buildMapFilter, geopointFields } from '../geo/map-layout';
import { ListLayoutToggle } from '../geo/list-layout-toggle';
import {
  DEFAULT_MAP_STYLE_URL,
  parseCoordinate,
  resolveMapStyleUrl,
  roundPoint,
  sanitizeStyleUrl,
  wrapLongitude,
} from '../geo/map-config';

const field = (name: string, extra: Partial<FieldResource> = {}) =>
  ({ id: name, name, type: 'geopoint', interface: 'geopoint', required: false, hidden: false, ...extra }) as FieldResource;

beforeEach(() => {
  geo.webgl = true;
  geo.fail = false;
  maps.length = 0;
  markers.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('map config', () => {
  it('accepts https / localhost / same-origin style URLs only', () => {
    expect(sanitizeStyleUrl('https://tiles.example.com/style.json')).toBe('https://tiles.example.com/style.json');
    expect(sanitizeStyleUrl('/tiles/style.json')).toBe('/tiles/style.json');
    expect(sanitizeStyleUrl('http://localhost:8080/style.json')).toBe('http://localhost:8080/style.json');
    for (const bad of ['javascript:alert(1)', 'data:application/json,{}', 'http://evil.example/style.json', '//evil.example/x', '', 42, null]) {
      expect(sanitizeStyleUrl(bad)).toBeNull();
    }
  });

  it('resolves field option → VITE_MAP_STYLE_URL → keyless default', () => {
    expect(resolveMapStyleUrl(null, {})).toBe(DEFAULT_MAP_STYLE_URL);
    expect(resolveMapStyleUrl(null, { VITE_MAP_STYLE_URL: 'https://env.example/s.json' })).toBe('https://env.example/s.json');
    expect(
      resolveMapStyleUrl(field('loc', { options: { mapStyleUrl: 'https://field.example/s.json' } }), {
        VITE_MAP_STYLE_URL: 'https://env.example/s.json',
      }),
    ).toBe('https://field.example/s.json');
    expect(resolveMapStyleUrl(field('loc', { options: { mapStyleUrl: 'javascript:x' } }), {})).toBe(DEFAULT_MAP_STYLE_URL);
  });

  it('parses typed coordinates strictly and wraps longitudes', () => {
    expect(parseCoordinate(' 21.5 ', 90)).toBe(21.5);
    expect(parseCoordinate('-180', 180)).toBe(-180);
    for (const bad of ['', '91', '1e2', 'abc', '12,5', 'Infinity']) expect(parseCoordinate(bad, 90)).toBeNull();
    expect(wrapLongitude(190)).toBe(-170);
    expect(wrapLongitude(-190)).toBe(170);
    expect(roundPoint({ lat: 1.123456789, lng: 361.5 })).toEqual({ lat: 1.1234568, lng: 1.5 });
  });
});

describe('registry wiring', () => {
  it('resolves the geopoint interface and display by interface and by type', () => {
    expect(resolveInterface(field('loc'))).toBe(GeopointInterface);
    expect(resolveInterface(field('loc', { interface: 'unknown-x' }))).toBe(GeopointInterface);
    expect(resolveDisplay(field('loc'))).toBe(GeopointDisplay);
    expect(findInterfaceCatalogueItem('geopoint')).toMatchObject({ type: 'geopoint', defaultDisplay: 'geopoint' });
  });

  it('displays a point, and a dash for anything else', () => {
    const { container, rerender } = render(<GeopointDisplay field={field('loc')} value={{ lat: 21.0285, lng: 105.8542 }} />);
    expect(container.textContent).toContain('21.02850, 105.85420');
    rerender(<GeopointDisplay field={field('loc')} value={{ lat: 500, lng: 0 }} />);
    expect(container.textContent).toBe('—');
  });
});

describe('GeopointInterface', () => {
  it('commits typed coordinates and refuses out-of-range input', () => {
    geo.webgl = false;
    const onChange = vi.fn();
    render(<GeopointInterface field={field('loc')} value={null} onChange={onChange} />);
    expect(screen.getByTestId('geopoint-map-unavailable')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '21.0285' } });
    expect(onChange).not.toHaveBeenCalled(); // lng still empty
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '105.8542' } });
    expect(onChange).toHaveBeenLastCalledWith({ lat: 21.0285, lng: 105.8542 });
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '95' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Latitude must be between -90 and 90/)).toBeTruthy();
    expect(screen.getByLabelText('Latitude').getAttribute('aria-invalid')).toBe('true');
  });

  it('clears the value', () => {
    geo.webgl = false;
    const onChange = vi.fn();
    render(<GeopointInterface field={field('loc')} value={{ lat: 1, lng: 2 }} onChange={onChange} />);
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('1');
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('falls back to manual entry when the map chunk fails to load', async () => {
    geo.fail = true;
    render(<GeopointInterface field={field('loc')} value={null} onChange={vi.fn()} />);
    await screen.findByTestId('geopoint-map-unavailable');
    expect(screen.getByLabelText('Latitude')).toBeTruthy();
  });

  it('places a marker, and map clicks / marker drags set the point (lazy map, default style)', async () => {
    const onChange = vi.fn();
    render(<GeopointInterface field={field('loc')} value={{ lat: 21, lng: 105 }} onChange={onChange} />);
    await waitFor(() => expect(maps).toHaveLength(1));
    expect(maps[0]!.options.style).toBe(DEFAULT_MAP_STYLE_URL);
    expect(maps[0]!.options.center).toEqual([105, 21]);
    await waitFor(() => expect(markers[0]?.lngLat).toEqual([105, 21]));
    expect(markers[0]!.draggable).toBe(true);

    act(() => maps[0]!.fire('click', { lngLat: { lat: 10.123456789, lng: 200 } }));
    expect(onChange).toHaveBeenLastCalledWith({ lat: 10.1234568, lng: -160 });

    markers[0]!.setLngLat([1, 2]);
    act(() => markers[0]!.fire('dragend'));
    expect(onChange).toHaveBeenLastCalledWith({ lat: 2, lng: 1 });
  });

  it('ignores map clicks when disabled', async () => {
    const onChange = vi.fn();
    render(<GeopointInterface field={field('loc')} value={{ lat: 21, lng: 105 }} onChange={onChange} disabled />);
    await waitFor(() => expect(markers[0]?.lngLat).toEqual([105, 21]));
    expect(markers[0]!.draggable).toBe(false);
    act(() => maps[0]!.fire('click', { lngLat: { lat: 1, lng: 1 } }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('"Use my location" fills the point, and reports a denied permission', async () => {
    geo.webgl = false;
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    const onChange = vi.fn();
    render(<GeopointInterface field={field('loc')} value={null} onChange={onChange} />);

    fireEvent.click(screen.getByText('Use my location'));
    act(() => getCurrentPosition.mock.calls[0]![0]({ coords: { latitude: 48.8584, longitude: 2.2945 } }));
    expect(onChange).toHaveBeenLastCalledWith({ lat: 48.8584, lng: 2.2945 });

    fireEvent.click(screen.getByText('Use my location'));
    act(() => getCurrentPosition.mock.calls[1]![1]({ code: 1 }));
    expect(screen.getByText('Location permission was denied.')).toBeTruthy();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
  });

  it('hides "Use my location" when the browser has no geolocation', () => {
    geo.webgl = false;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    render(<GeopointInterface field={field('loc')} value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Use my location')).toBeNull();
  });
});

describe('Map list layout', () => {
  const FIELDS = [
    { id: 'title', name: 'title', type: 'string', interface: 'input', required: false, hidden: false } as FieldResource,
    field('loc'),
  ];
  const ROWS = [
    { id: 'a1', status: 'published', data: { title: 'Hanoi', loc: { lat: 21.0285, lng: 105.8542 } } },
    { id: 'b2', status: 'published', data: { title: 'Saigon', loc: { lat: 10.8231, lng: 106.6297 } } },
    { id: 'c3', status: 'published', data: { title: 'Broken', loc: 'nope' } },
  ];

  function renderLayout(filter?: Record<string, unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MapLayout collection="places" fields={FIELDS} filter={filter as never} enabled />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    list.mockResolvedValue({ data: ROWS, meta: { total: 3 } });
  });

  it('helpers: geopoint fields, map filter and bounds → bbox (antimeridian, world)', () => {
    expect(geopointFields(FIELDS).map((f) => f.name)).toEqual(['loc']);
    expect(buildMapFilter(undefined, 'loc', null)).toEqual({ loc: { _nnull: true } });
    expect(buildMapFilter({ title: { _eq: 'x' } }, 'loc', [0, 0, 1, 1])).toEqual({
      _and: [{ title: { _eq: 'x' } }, { loc: { _nnull: true } }, { loc: { _within_bbox: [0, 0, 1, 1] } }],
    });
    expect(boundsToBBox(170, -10, 190, 10)).toEqual([170, -10, -170, 10]);
    expect(boundsToBBox(-400, -100, 400, 100)).toEqual([-180, -90, 180, 90]);
  });

  it('puts one marker per located item, frames them, and opens the item on click', async () => {
    renderLayout({ title: { _neq: 'zzz' } });
    await screen.findByText('Hanoi');
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { _and: [{ title: { _neq: 'zzz' } }, { loc: { _nnull: true } }] }, limit: 200 }),
    );
    expect(screen.getByText('Saigon')).toBeTruthy();
    expect(screen.queryByText('Broken')).toBeNull();
    await waitFor(() => expect(markers.filter((m) => !m.removed)).toHaveLength(2));
    expect(maps[0]!.fitBounds).toHaveBeenCalledTimes(1);
    const hanoi = markers.find((m) => m.lngLat?.[0] === 105.8542)!;
    expect(hanoi.el.getAttribute('aria-label')).toBe('Hanoi');
    fireEvent.click(hanoi.el);
    expect(navigate).toHaveBeenCalledWith({ to: '/content/$collection/$id', params: { collection: 'places', id: 'a1' } });
    expect(screen.getByText('Hanoi').closest('a')?.getAttribute('href')).toBe('/item/a1');
  });

  it('"Only this area" queries the visible bounds with _within_bbox', async () => {
    renderLayout();
    await screen.findByText('Only this area');
    fireEvent.click(screen.getByLabelText('Only this area'));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: { _and: [{ loc: { _nnull: true } }, { loc: { _within_bbox: [100, 10, 110, 20] } }] } }),
      ),
    );
    maps[0]!.bounds = { west: 170, south: -20, east: 200, north: -10 };
    act(() => maps[0]!.fire('moveend'));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: { _and: [{ loc: { _nnull: true } }, { loc: { _within_bbox: [170, -20, -160, -10] } }] } }),
      ),
    );
  });

  it('lists located items when the map cannot be shown', async () => {
    geo.webgl = false;
    renderLayout();
    await screen.findByTestId('map-layout-unavailable');
    expect(await screen.findByText('Hanoi')).toBeTruthy();
    expect(screen.queryByText('Only this area')).toBeNull();
  });

  it('layout toggle reports the chosen layout', () => {
    const onChange = vi.fn();
    render(<ListLayoutToggle value="table" onChange={onChange} />);
    expect(screen.getByText('Table').closest('button')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('Map'));
    expect(onChange).toHaveBeenCalledWith('map');
  });
});
