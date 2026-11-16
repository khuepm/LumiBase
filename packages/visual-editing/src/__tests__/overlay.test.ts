import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableVisualEditing, fieldAttributes, LIVE_ATTRIBUTE, previewMessage, type VisualEditingHandle } from '../index';

/**
 * Overlay + bridge behaviour (V03 #681) on a jsdom document with a stub
 * parent window: the page is "framed", the Studio is `STUDIO`.
 */

const STUDIO = 'https://studio.example';
type Listener = (event: MessageEvent) => void;

function framedWindow(href = 'https://front.example/posts/hello?__preview=tok') {
  const listeners = new Set<Listener>();
  const posted: Array<{ message: unknown; origin: string }> = [];
  const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
  const frames: Array<() => void> = [];
  const reload = vi.fn();
  const win = {
    document,
    parent,
    self: {},
    top: {},
    location: Object.assign(new URL(href), { reload }),
    addEventListener: (type: string, fn: Listener) => type === 'message' && listeners.add(fn),
    removeEventListener: (type: string, fn: Listener) => type === 'message' && listeners.delete(fn),
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    setTimeout: (cb: () => void) => frames.push(cb),
  };
  const send = (data: unknown, origin = STUDIO, source: unknown = parent) => {
    for (const fn of [...listeners]) fn({ data, origin, source } as unknown as MessageEvent);
  };
  const tick = () => frames.splice(0).forEach((cb) => cb());
  return { win: win as unknown as Window, posted, send, tick, reload, listeners };
}

let handle: VisualEditingHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.destroy();
  handle = null;
});

describe('enableVisualEditing', () => {
  it('is a no-op outside a frame, when disabled, or without origins', () => {
    const top = framedWindow();
    (top.win as unknown as { parent: unknown }).parent = top.win;
    expect(enableVisualEditing({ studioOrigins: [STUDIO], window: top.win }).active).toBe(false);
    const f = framedWindow();
    expect(enableVisualEditing({ studioOrigins: [STUDIO], window: f.win, enabled: false }).active).toBe(false);
    expect(enableVisualEditing({ studioOrigins: ['*'], window: f.win }).active).toBe(false);
    // Default detection needs the `__preview` marker in the URL.
    const plain = framedWindow('https://front.example/posts/hello');
    expect(enableVisualEditing({ studioOrigins: [STUDIO], window: plain.win }).active).toBe(false);
    expect(f.posted).toHaveLength(0);
  });

  it('announces itself to each allowed origin explicitly, never "*"', () => {
    const f = framedWindow();
    handle = enableVisualEditing({ studioOrigins: [STUDIO, 'http://localhost:2026'], window: f.win });
    expect(handle.active).toBe(true);
    expect(f.posted.map((p) => p.origin)).toEqual([STUDIO, 'http://localhost:2026']);
    expect(f.posted.every((p) => p.origin !== '*')).toBe(true);
  });

  it('locks to the origin that says hello and drops others (logged)', () => {
    const f = framedWindow();
    const onReject = vi.fn();
    handle = enableVisualEditing({ studioOrigins: [STUDIO, 'http://localhost:2026'], window: f.win, onReject });
    f.send(previewMessage({ type: 'hello' as const }));
    expect(handle.studioOrigin).toBe(STUDIO);
    f.posted.length = 0;
    f.send(previewMessage({ type: 'reload' as const }), 'https://evil.example');
    expect(onReject).toHaveBeenCalledWith('origin', 'https://evil.example');
    f.send(previewMessage({ type: 'reload' as const }), 'http://localhost:2026');
    expect(onReject).toHaveBeenCalledWith('origin', 'http://localhost:2026');
    expect(f.reload).not.toHaveBeenCalled();
    f.send({ type: 'reload' }, STUDIO);
    expect(onReject).toHaveBeenCalledWith('schema', STUDIO);
    f.send(previewMessage({ type: 'reload' as const }), STUDIO);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it('clicking an outlined element asks the Studio to focus that field', () => {
    const f = framedWindow();
    document.body.innerHTML = '<article><h1 id="t">Hello <em id="inner">world</em></h1></article>';
    const h1 = document.getElementById('t')!;
    for (const [k, v] of Object.entries(fieldAttributes({ collection: 'posts', itemId: 'itm_1', field: 'title' }))) h1.setAttribute(k, v);
    handle = enableVisualEditing({ studioOrigins: [STUDIO], window: f.win });
    f.send(previewMessage({ type: 'hello' as const }));
    f.posted.length = 0;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('inner')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(f.posted).toEqual([
      { message: previewMessage({ type: 'focus' as const, target: { collection: 'posts', itemId: 'itm_1', field: 'title' } }), origin: STUDIO },
    ]);
    // Hover draws the single outline element.
    document.getElementById('inner')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const overlay = document.querySelector('[data-lumibase-overlay]') as HTMLElement;
    expect(overlay.style.display).toBe('block');
  });

  it('coalesces patches per frame and writes text, never HTML', () => {
    const f = framedWindow();
    document.body.innerHTML = '<h1 id="t">Old</h1>';
    const h1 = document.getElementById('t')!;
    h1.setAttribute('data-lumibase-field', 'posts/itm_1/title');
    h1.setAttribute(LIVE_ATTRIBUTE, 'text');
    const onPatch = vi.fn();
    handle = enableVisualEditing({ studioOrigins: [STUDIO], window: f.win, onPatch });
    f.send(previewMessage({ type: 'hello' as const }));
    for (let seq = 1; seq <= 5; seq += 1) {
      f.send(previewMessage({ type: 'patch' as const, seq, collection: 'posts', itemId: 'itm_1', fields: { title: `v${seq}` } }));
    }
    f.send(
      previewMessage({ type: 'patch' as const, seq: 6, collection: 'posts', itemId: 'itm_1', fields: { title: '<img src=x onerror=alert(1)>' } }),
    );
    expect(onPatch).not.toHaveBeenCalled();
    f.tick();
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith({ collection: 'posts', itemId: 'itm_1', fields: { title: '<img src=x onerror=alert(1)>' } });
    expect(h1.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(h1.querySelector('img')).toBeNull();
  });

  it('applies backpressure: an unbounded backlog becomes one reload', () => {
    const f = framedWindow();
    const onPatch = vi.fn();
    const onReload = vi.fn();
    handle = enableVisualEditing({ studioOrigins: [STUDIO], window: f.win, onPatch, onReload, maxPendingFields: 10 });
    f.send(previewMessage({ type: 'hello' as const }));
    for (let i = 0; i < 3; i += 1) {
      const fields = Object.fromEntries(Array.from({ length: 5 }, (_, j) => [`f${i}_${j}`, j]));
      f.send(previewMessage({ type: 'patch' as const, seq: i, collection: 'posts', itemId: 'itm_1', fields }));
    }
    expect(onReload).toHaveBeenCalledTimes(1);
    f.tick();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('destroy removes listeners and the outline', () => {
    const f = framedWindow();
    handle = enableVisualEditing({ studioOrigins: [STUDIO], window: f.win });
    expect(f.listeners.size).toBe(1);
    handle.destroy();
    expect(f.listeners.size).toBe(0);
    expect(document.querySelector('[data-lumibase-overlay]')).toBeNull();
  });
});
