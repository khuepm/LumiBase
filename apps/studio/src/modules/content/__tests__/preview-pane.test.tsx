// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { previewMessage } from '@lumibase/visual-editing/protocol';
import {
  changedFields,
  clampSplit,
  decideFrame,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  splitFromKey,
  splitFromPointer,
  topLevelField,
} from '../preview-pane-state';

/**
 * Live preview pane (epic #667 — V02 #680, V05 #683).
 */

const mintToken = vi.fn();
const getSettings = vi.fn();
const rawRequest = vi.fn(async (_path: string): Promise<{ data: unknown[] }> => ({ data: [] }));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ preview: { mintToken, getSettings }, rawRequest }),
}));

import { PreviewPane, PreviewSplit } from '../preview-pane';

const FRONT = 'https://front.example';
const TEMPLATE = `${FRONT}/api/preview?token={token}&id={id}`;

afterEach(() => {
  cleanup();
  mintToken.mockReset();
  getSettings.mockReset();
  vi.useRealTimers();
});

describe('preview-pane-state', () => {
  it('clamps the split and maps keys like a window splitter', () => {
    expect(clampSplit(5)).toBe(SPLIT_MIN);
    expect(clampSplit(99)).toBe(SPLIT_MAX);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
    expect(splitFromKey('ArrowLeft', 50)).toBe(45);
    expect(splitFromKey('ArrowRight', 50)).toBe(55);
    expect(splitFromKey('Home', 50)).toBe(SPLIT_MIN);
    expect(splitFromKey('End', 50)).toBe(SPLIT_MAX);
    expect(splitFromKey('Enter', 30)).toBe(SPLIT_DEFAULT);
    expect(splitFromKey('a', 50)).toBeNull();
    expect(splitFromPointer(300, 100, 400)).toBe(50);
    expect(splitFromPointer(300, 0, 0)).toBe(SPLIT_DEFAULT);
    // RTL: the editor is on the right, so the maths and the arrows mirror.
    expect(splitFromPointer(400, 100, 400, true)).toBe(SPLIT_MIN + 0); // 25 % from the right edge
    expect(splitFromKey('ArrowLeft', 50, true)).toBe(55);
    expect(splitFromKey('ArrowRight', 50, true)).toBe(45);
  });

  it('frames only the template origin or an allowlisted origin, never the Studio itself', () => {
    const base = { template: TEMPLATE, allowedOrigins: ['https://other.example'], studioOrigin: 'https://studio.example' };
    expect(decideFrame({ ...base, url: `${FRONT}/x` })).toMatchObject({ ok: true, origin: FRONT });
    expect(decideFrame({ ...base, url: 'https://other.example/x' })).toMatchObject({ ok: true });
    expect(decideFrame({ ...base, url: 'https://evil.example/x' })).toEqual({ ok: false, reason: 'not_allowed' });
    expect(decideFrame({ ...base, url: 'javascript:alert(1)' })).toEqual({ ok: false, reason: 'invalid_url' });
    expect(
      decideFrame({ ...base, template: 'https://studio.example/p?t={token}', url: 'https://studio.example/p' }),
    ).toEqual({ ok: false, reason: 'same_origin' });
    expect(decideFrame({ ...base, allowedOrigins: ['*'], url: 'https://evil.example/x' }).ok).toBe(false);
  });

  it('diffs top-level fields and keeps only safe names', () => {
    expect(changedFields(null, { a: 1 })).toEqual({ a: 1 });
    expect(changedFields({ a: 1, b: [1] }, { a: 1, b: [2] })).toEqual({ b: [2] });
    expect(changedFields({}, { 'bad-name': 1, ok: 2 })).toEqual({ ok: 2 });
    expect(topLevelField('body.0.text')).toBe('body');
  });
});

describe('PreviewSplit', () => {
  it('exposes a keyboard-accessible separator', () => {
    render(<PreviewSplit editor={<p>form</p>} preview={<p>frame</p>} />);
    const separator = screen.getByRole('separator', { name: 'Resize preview' });
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(separator.getAttribute('aria-valuenow')).toBe(String(SPLIT_DEFAULT));
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe(String(SPLIT_DEFAULT + 5));
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe(String(SPLIT_MIN));
  });
});

function renderPane(overrides: Partial<Parameters<typeof PreviewPane>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    collection: 'posts',
    itemId: 'itm_1',
    template: TEMPLATE,
    draft: { title: 'Hello' },
    savedMarker: 't1',
    onFocusField: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <QueryClientProvider client={client}>
      <PreviewPane {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, props, client };
}

function minted(url: string) {
  return { data: { token: 'tok', url, locale: null, versionKey: null, expiresAt: new Date(Date.now() + 900_000).toISOString() } };
}

describe('PreviewPane', () => {
  it('renders a sandboxed, no-referrer frame for an allowed origin', async () => {
    getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900 } });
    mintToken.mockResolvedValue(minted(`${FRONT}/api/preview?token=tok&id=itm_1`));
    renderPane({ locale: 'vi' });
    const frame = (await screen.findByTitle('Preview of posts itm_1')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toBe(`${FRONT}/api/preview?token=tok&id=itm_1`);
    expect(mintToken).toHaveBeenCalledWith({ collection: 'posts', itemId: 'itm_1', locale: 'vi' });
  });

  it('refuses to frame a URL outside the allowlist', async () => {
    getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900 } });
    mintToken.mockResolvedValue(minted('https://evil.example/x'));
    renderPane();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTitle('Preview of posts itm_1')).toBeNull();
  });

  it('shows mint errors inline', async () => {
    getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900 } });
    mintToken.mockRejectedValue(new Error('Forbidden'));
    renderPane();
    expect((await screen.findByRole('alert')).textContent).toContain('Forbidden');
  });

  it('handshakes, streams patches, focuses fields and drops foreign messages', async () => {
    getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900 } });
    mintToken.mockResolvedValue(minted(`${FRONT}/p?token=tok`));
    const { props, rerender, client } = renderPane();
    const frame = (await screen.findByTitle('Preview of posts itm_1')) as HTMLIFrameElement;
    const frameWindow = frame.contentWindow!;
    const posted: Array<{ message: unknown; origin: string }> = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation(((message: unknown, origin: string) => {
      posted.push({ message, origin });
    }) as typeof frameWindow.postMessage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const dispatch = (data: unknown, origin = FRONT, source: MessageEventSource | null = frameWindow) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
      });

    // A foreign origin is ignored, even from the frame.
    dispatch(previewMessage({ type: 'ready' as const, path: '/p' }), 'https://evil.example');
    expect(posted).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    dispatch(previewMessage({ type: 'ready' as const, path: '/p' }));
    await waitFor(() => expect(posted.some((p) => (p.message as { type: string }).type === 'hello')).toBe(true));
    expect(posted.every((p) => p.origin === FRONT)).toBe(true);

    // Field edit → debounced patch with only the changed field.
    posted.length = 0;
    rerender(
      <QueryClientProvider client={client}>
        <PreviewPane {...props} draft={{ title: 'Hello world' }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(posted.some((p) => (p.message as { type: string }).type === 'patch')).toBe(true), {
      timeout: 1000,
    });
    const patch = posted.find((p) => (p.message as { type: string }).type === 'patch')!.message as { fields: Record<string, unknown> };
    expect(patch.fields).toEqual({ title: 'Hello world' });

    // Click in the frame → focus that field here.
    dispatch(previewMessage({ type: 'focus' as const, target: { collection: 'posts', itemId: 'itm_1', field: 'title' } }));
    expect(props.onFocusField).toHaveBeenCalledWith('title');
    // Another item's focus is ignored; a malformed message too.
    dispatch(previewMessage({ type: 'focus' as const, target: { collection: 'posts', itemId: 'other', field: 'title' } }));
    dispatch({ type: 'focus', target: 'title' });
    expect(props.onFocusField).toHaveBeenCalledTimes(1);

    // Save → reload message.
    posted.length = 0;
    rerender(
      <QueryClientProvider client={client}>
        <PreviewPane {...props} draft={{ title: 'Hello world' }} savedMarker="t2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(posted.some((p) => (p.message as { type: string }).type === 'reload')).toBe(true), {
      timeout: 1000,
    });
    warn.mockRestore();
  });

  it('previews a selected content version and stops streaming form edits over it (V04 #682)', async () => {
    getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900 } });
    rawRequest.mockResolvedValue({ data: [{ key: 'redesign', name: 'Redesign' }] });
    mintToken.mockResolvedValue(minted(`${FRONT}/p?token=tok`));
    const { props, rerender, client } = renderPane();
    const select = (await screen.findByRole('combobox', { name: 'Preview version' })) as HTMLSelectElement;
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/items/posts/itm_1/versions');
    fireEvent.change(select, { target: { value: 'redesign' } });
    await waitFor(() =>
      expect(mintToken).toHaveBeenLastCalledWith({ collection: 'posts', itemId: 'itm_1', versionKey: 'redesign' }),
    );

    const frame = (await screen.findByTitle('Preview of posts itm_1')) as HTMLIFrameElement;
    const frameWindow = frame.contentWindow!;
    const posted: Array<{ message: unknown }> = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation(((message: unknown) => {
      posted.push({ message });
    }) as typeof frameWindow.postMessage);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: previewMessage({ type: 'ready' as const, path: '/p' }), origin: FRONT, source: frameWindow }),
      );
    });
    await waitFor(() => expect(posted.some((p) => (p.message as { type: string }).type === 'hello')).toBe(true));
    rerender(
      <QueryClientProvider client={client}>
        <PreviewPane {...props} draft={{ title: 'Edited on main' }} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(posted.some((p) => (p.message as { type: string }).type === 'patch')).toBe(false);
  });
});
