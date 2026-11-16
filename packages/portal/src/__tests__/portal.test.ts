import { beforeEach, describe, expect, it, vi } from 'vitest';
import { definePortalElement, mountPortal, optionsFromAttributes, PortalApi, takeTokenFromUrl, loadSession, saveSession } from '../index';

type Handler = (url: URL, init: RequestInit) => { status: number; body?: unknown };

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const CONFIG = {
  allowSelfSignup: true,
  newsletters: [{ id: 'nl1', key: 'weekly', name: 'Weekly', description: null, audience: 'members' }],
  tiers: [
    { key: 'free', name: 'Free', description: null, kind: 'free', monthlyPriceCents: null, yearlyPriceCents: null, currency: null, benefits: [] },
    { key: 'gold', name: 'Gold', description: null, kind: 'paid', monthlyPriceCents: 500, yearlyPriceCents: null, currency: 'USD', benefits: [] },
  ],
  copy: { heading: 'Đăng ký nhận tin', description: 'd', placeholder: 'ban@example.com', nameLabel: 'Tên', button: 'Đăng ký', success: 'Kiểm tra hộp thư', error: 'Lỗi' },
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const shadow = (host: Element) => (host as HTMLElement).shadowRoot!;

describe('takeTokenFromUrl', () => {
  it('extracts once and strips the param; ignores malformed input', () => {
    const token = 'a'.repeat(43);
    expect(takeTokenFromUrl(`https://x.test/welcome?lumi_member_token=${token}&utm=1`)).toEqual({ token, cleanUrl: 'https://x.test/welcome?utm=1' });
    expect(takeTokenFromUrl('not a url')).toBeNull();
    expect(takeTokenFromUrl(42)).toBeNull();
    expect(takeTokenFromUrl('https://x.test/?lumi_member_token=%ZZ')).toBeNull();
    expect(takeTokenFromUrl(`https://x.test/?lumi_member_token=${token}&lumi_member_token=${token}`)).toBeNull();
    expect(takeTokenFromUrl('https://x.test/?lumi_member_token=<script>')).toBeNull();
  });
});

describe('PortalApi', () => {
  it('never throws on network errors or non-JSON bodies', async () => {
    const api = new PortalApi({ url: 'https://cms.test', siteId: 's', fetcher: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(await api.config()).toMatchObject({ ok: false, code: 'NETWORK' });
    const html = new PortalApi({ url: 'https://cms.test', siteId: 's', fetcher: fakeFetch(() => ({ status: 502, body: '<html>bad gateway</html>' })).fn });
    expect(await html.config()).toMatchObject({ ok: false, status: 502, code: 'HTTP_ERROR' });
  });

  it('rejects a non-http base URL', () => {
    expect(() => new PortalApi({ url: 'javascript:alert(1)', siteId: 's' })).toThrow();
  });
});

describe('mountPortal', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    saveSession('s', null);
  });

  it('renders nothing and does not throw on missing config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = document.createElement('div');
    expect(() => mountPortal(host, { url: '', siteId: '' })).not.toThrow();
    expect(() => mountPortal(null, null)).not.toThrow();
    expect(host.childNodes).toHaveLength(0);
    warn.mockRestore();
  });

  it('renders the localized signup card with per-card overrides and requests a link', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.pathname === '/api/v1/portal/config') return { status: 200, body: { data: CONFIG } };
      if (url.pathname === '/api/v1/portal/magic-link') return { status: 202, body: { data: { status: 'pending' } } };
      return { status: 404 };
    });
    const host = document.createElement('div');
    document.body.append(host);
    mountPortal(host, { url: 'https://cms.test', siteId: 's', locale: 'vi', fetcher: fn, newsletters: ['weekly'], copy: { button: { vi: 'Theo dõi', en: 'Follow' } }, location: { href: 'https://blog.test/' } });
    await flush();
    await flush();
    const root = shadow(host);
    expect(root.querySelector('h2')!.textContent).toBe('Đăng ký nhận tin');
    expect(root.querySelector('button')!.textContent).toBe('Theo dõi');
    const input = root.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input.placeholder).toBe('ban@example.com');

    input.value = 'reader@example.test';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();
    const req = calls.find((c) => c.url.endsWith('/magic-link'))!;
    expect(JSON.parse(String(req.init.body))).toMatchObject({ email: 'reader@example.test', newsletters: ['weekly'], intent: 'signup', locale: 'vi' });
    expect((req.init.headers as Record<string, string>)['x-lumi-site']).toBe('s');
    expect(root.querySelector('[role="status"]')!.textContent).toBe('Kiểm tra hộp thư');
  });

  it('lands from a magic link, stores the session, strips the URL and shows the account', async () => {
    const token = 'b'.repeat(43);
    const replaced: string[] = [];
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.pathname === '/api/v1/portal/config') return { status: 200, body: { data: CONFIG } };
      if (url.pathname === '/api/v1/portal/magic-link/verify') return { status: 200, body: { data: { token: 'session-jwt', refreshToken: 'r1' } } };
      if (url.pathname === '/api/v1/portal/me' && (!init.method || init.method === 'GET')) {
        return { status: 200, body: { data: { id: 'm1', email: 'reader@example.test', name: '<img src=x onerror=alert(1)>', status: 'free', tier: { key: 'free', name: 'Free', kind: 'free' }, newsletters: [{ id: 'nl1', key: 'weekly', name: 'Weekly' }] } } };
      }
      return { status: 200, body: { data: null } };
    });
    const host = document.createElement('div');
    mountPortal(host, { url: 'https://cms.test', siteId: 's', fetcher: fn, location: { href: `https://blog.test/welcome?lumi_member_token=${token}` }, replaceUrl: (u) => replaced.push(u) });
    for (let i = 0; i < 6; i += 1) await flush();
    expect(replaced).toEqual(['https://blog.test/welcome']);
    expect(loadSession('s')).toEqual({ token: 'session-jwt', refreshToken: 'r1' });
    const root = shadow(host);
    // Server strings are text, never markup.
    expect(root.querySelector('h2')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    expect((root.querySelector('#lumi-nl-nl1') as HTMLInputElement).checked).toBe(true);
    const me = calls.find((c) => c.url.endsWith('/api/v1/portal/me'))!;
    expect((me.init.headers as Record<string, string>).authorization).toBe('Bearer session-jwt');
    expect(root.querySelector('[data-tier="gold"]')).not.toBeNull();
  });

  it('renders nothing when the portal is disabled', async () => {
    const { fn } = fakeFetch(() => ({ status: 404, body: { errors: [{ code: 'PORTAL_DISABLED' }] } }));
    const host = document.createElement('div');
    mountPortal(host, { url: 'https://cms.test', siteId: 's', fetcher: fn });
    await flush();
    await flush();
    expect(shadow(host).querySelector('.lumi-portal')!.childNodes).toHaveLength(0);
  });
});

describe('<lumi-portal>', () => {
  it('reads attributes and ignores malformed JSON', () => {
    const node = document.createElement('div');
    node.setAttribute('data-api', 'https://cms.test');
    node.setAttribute('data-site', 's');
    node.setAttribute('data-newsletters', 'weekly, bad key!, product');
    node.setAttribute('data-copy', '{not json');
    node.setAttribute('data-mode', 'nonsense');
    expect(optionsFromAttributes(node)).toEqual({ url: 'https://cms.test', siteId: 's', newsletters: ['weekly', 'product'], collectName: false });
  });

  it('defines the element once', () => {
    definePortalElement();
    definePortalElement();
    expect(customElements.get('lumi-portal')).toBeDefined();
  });
});
