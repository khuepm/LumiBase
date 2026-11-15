// @vitest-environment jsdom
import { act, render, screen, fireEvent } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXTENSION_DEV_PROTOCOL } from '@lumibase/contracts/extensions';

vi.mock('@/lib/api', () => ({ getApiClient: vi.fn() }));
vi.mock('virtual:lumibase-extensions', () => ({ devExtensions: [] }));

type DevClient = typeof import('../extension-dev-client');
type Loader = typeof import('../extension-loader');
let connectExtensionDevHub: DevClient['connectExtensionDevHub'];
let provideSharedModules: DevClient['provideSharedModules'];
let readDevSession: DevClient['readDevSession'];
let resolveUiComponent: DevClient['resolveUiComponent'];
let startExtensionDevClient: DevClient['startExtensionDevClient'];
let DEV_SESSION_KEY: string;
let clearExtensionCache: Loader['clearExtensionCache'];
let ExtensionComponent: Loader['ExtensionComponent'];
let getExtension: Loader['getExtension'];
let getHotExtensionVersion: Loader['getHotExtensionVersion'];

beforeAll(async () => {
  ({ connectExtensionDevHub, provideSharedModules, readDevSession, resolveUiComponent, startExtensionDevClient, DEV_SESSION_KEY } =
    await import('../extension-dev-client'));
  ({ clearExtensionCache, ExtensionComponent, getExtension, getHotExtensionVersion } = await import('../extension-loader'));
});

const TOKEN = 'f'.repeat(64);
const HUB = 'http://127.0.0.1:4790';

afterEach(() => {
  clearExtensionCache();
  vi.unstubAllEnvs();
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, l: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

function reload(name: string, version: number, type = 'interface') {
  return {
    protocol: EXTENSION_DEV_PROTOCOL,
    name,
    type,
    version,
    builtAt: new Date().toISOString(),
    sha256: createHash('sha256').update(`${name}${version}`).digest('hex'),
    capabilities: [],
    siteId: null,
  };
}

describe('readDevSession', () => {
  it('moves the fragment token to sessionStorage and strips it from the URL', () => {
    const storage = memoryStorage();
    const replace = vi.fn();
    const hash = `#${DEV_SESSION_KEY}=${encodeURIComponent(JSON.stringify({ url: `${HUB}/`, token: TOKEN }))}`;
    const session = readDevSession({ hash, pathname: '/content', search: '?q=1' }, storage, replace);
    expect(session).toEqual({ url: HUB, token: TOKEN });
    expect(replace).toHaveBeenCalledWith('/content?q=1');
    expect(readDevSession({ hash: '', pathname: '/', search: '' }, storage, replace)).toEqual(session);
  });

  it('rejects a non-loopback hub or a short token', () => {
    const replace = vi.fn();
    const bad = (url: string, token: string) =>
      readDevSession(
        { hash: `#${DEV_SESSION_KEY}=${encodeURIComponent(JSON.stringify({ url, token }))}`, pathname: '/', search: '' },
        memoryStorage(),
        replace,
      );
    expect(bad('https://evil.example', TOKEN)).toBeNull();
    expect(bad(HUB, 'short')).toBeNull();
  });
});

describe('resolveUiComponent', () => {
  it('accepts a default component, a definition object, or a named component', () => {
    const C = () => null;
    expect(resolveUiComponent({ default: C })).toBe(C);
    expect(resolveUiComponent({ default: { id: 'x', component: C } })).toBe(C);
    expect(resolveUiComponent({ component: C })).toBe(C);
    expect(resolveUiComponent({ default: 'nope' })).toBeNull();
  });
});

describe('Studio hot swap', () => {
  it('re-imports with a cache-busting version and swaps in place, keeping host state', async () => {
    const modules: Record<number, Record<string, unknown>> = {
      1: { default: ({ value }: { value: string }) => <span>v1:{value}</span> },
      2: { default: ({ value }: { value: string }) => <span>v2:{value}</span> },
    };
    const importModule = vi.fn(async (url: string) => modules[Number(new URL(url).searchParams.get('v'))]!);
    const stop = connectExtensionDevHub({
      session: { url: HUB, token: TOKEN },
      createEventSource: (u) => new FakeEventSource(u),
      importModule,
    });
    expect(FakeEventSource.last?.url).toBe(`${HUB}/events?token=${TOKEN}`);

    function Host() {
      const [count, setCount] = useState(0);
      return (
        <div>
          <button onClick={() => setCount((c) => c + 1)}>count {count}</button>
          <ExtensionComponent name="color-picker" value="red" />
        </div>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText('count 0')); // host state: 1

    await act(async () => {
      FakeEventSource.last!.emit('hello', { protocol: 1, extensions: [reload('color-picker', 1)] });
    });
    expect(await screen.findByText('v1:red')).toBeTruthy();
    expect(importModule).toHaveBeenLastCalledWith(`${HUB}/bundle/color-picker?v=1&token=${TOKEN}`);

    await act(async () => {
      FakeEventSource.last!.emit('reload', reload('color-picker', 2));
    });
    expect(await screen.findByText('v2:red')).toBeTruthy();
    expect(screen.getByText('count 1')).toBeTruthy(); // app state survived the swap
    expect(getExtension('color-picker')?.slot).toBe('interface');

    // A stale (older) version arriving late never rolls back.
    await act(async () => {
      FakeEventSource.last!.emit('reload', reload('color-picker', 1));
    });
    expect(getHotExtensionVersion('color-picker')).toBe(2);
    expect(screen.getByText('v2:red')).toBeTruthy();

    stop();
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it('ignores server-side (hook) reloads and keeps the old version on a build error', async () => {
    const importModule = vi.fn();
    const onError = vi.fn();
    connectExtensionDevHub({
      session: { url: HUB, token: TOKEN },
      createEventSource: (u) => new FakeEventSource(u),
      importModule,
      onError,
    });
    await act(async () => {
      FakeEventSource.last!.emit('reload', reload('audit-hook', 1, 'hook'));
      FakeEventSource.last!.emit('build-error', { protocol: 1, name: 'x', message: 'Unexpected ;' });
    });
    expect(importModule).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('keeping the previous version'));
  });

  it('publishes Studio React for the CLI react shim', () => {
    const target: Record<string, unknown> = {};
    provideSharedModules(target);
    const shared = target.__lumibaseShared as Record<string, { useState?: unknown; jsx?: unknown }>;
    expect(typeof shared.react?.useState).toBe('function');
    expect(typeof shared['react/jsx-runtime']?.jsx).toBe('function');
  });

  it('is a no-op outside the Vite dev server', () => {
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(window.sessionStorage, 'getItem');
    startExtensionDevClient()();
    expect(spy).not.toHaveBeenCalled();
  });
});
