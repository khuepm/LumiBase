/**
 * `mountPortal(target, options)` — render the member Portal into an element.
 *
 *   - signed out: a signup / sign-in form (the signup card) whose labels come
 *     from the site copy for the page locale, with per-card overrides;
 *   - signed in: the member's name, newsletter toggles, tier switch,
 *     "unsubscribe from everything", sign out.
 *
 * Robustness rules (Ghost portal.min.js #27415/#26399 lessons):
 *   - missing or malformed options render nothing and warn once — never throw
 *     into the host page;
 *   - a malformed landing URL or query string is ignored;
 *   - every server string is set with `textContent`, never parsed as HTML.
 */

import { resolveSignupCopy, normalizeLocale, type LocalizedOverride, type ResolvedSignupCopy, type SignupCopyKey } from '@lumibase/contracts/members';
import { PortalApi, normalizeBaseUrl, type PortalConfig, type PortalMember } from './api';
import { loadSession, saveSession, takeTokenFromUrl } from './session';
import { PORTAL_CSS } from './styles';

export interface PortalOptions {
  url: string;
  siteId: string;
  locale?: string;
  /** `auto` (default): account when signed in, signup otherwise. */
  mode?: 'auto' | 'signup' | 'account';
  /** Landing URI for the magic link; must be registered in member settings. */
  redirectUri?: string;
  /** Newsletter keys to subscribe on signup (signup card `newsletters`). */
  newsletters?: string[];
  collectName?: boolean;
  layout?: 'card' | 'inline' | 'minimal';
  /** Per-card copy overrides (strings or `{ [locale]: string }`). */
  copy?: Partial<Record<SignupCopyKey, LocalizedOverride>>;
  fetcher?: typeof fetch;
  /** Injected for tests; defaults to `window.location` / `history`. */
  location?: { href: string };
  replaceUrl?: (url: string) => void;
  onSignedIn?: (member: PortalMember) => void;
}

export interface PortalHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

const NOOP: PortalHandle = { refresh: async () => undefined, destroy: () => undefined };

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function validOptions(options: Partial<PortalOptions> | null | undefined): options is PortalOptions {
  return !!options && !!normalizeBaseUrl(options.url) && typeof options.siteId === 'string' && options.siteId.length > 0;
}

export function mountPortal(target: Element | null | undefined, options: Partial<PortalOptions> | null | undefined): PortalHandle {
  if (!target || !validOptions(options)) {
    if (typeof console !== 'undefined') console.warn('[lumibase-portal] not mounted: a target element, "url" and "siteId" are required.');
    return NOOP;
  }
  const opts = options;
  const doc = target.ownerDocument;
  let root: ShadowRoot | Element = target;
  try {
    root = (target as HTMLElement).shadowRoot ?? (target as HTMLElement).attachShadow({ mode: 'open' });
  } catch {
    root = target; // elements that cannot host a shadow root render in light DOM
  }
  const style = el(doc, 'style', {}, PORTAL_CSS);
  const box = el(doc, 'div', { class: 'lumi-portal', 'data-layout': opts.layout ?? 'card', part: 'portal' });
  root.replaceChildren(style, box);

  const locale = normalizeLocale(opts.locale ?? doc.documentElement.lang);
  let session = loadSession(opts.siteId);
  const api = new PortalApi({ url: opts.url, siteId: opts.siteId, fetcher: opts.fetcher, getToken: () => session?.token ?? null });
  let destroyed = false;
  let config: PortalConfig | null = null;

  const copy = (): ResolvedSignupCopy => resolveSignupCopy(locale, config ? { [locale]: config.copy } : {}, opts.copy);

  function status(message: string, tone: 'info' | 'error' = 'info') {
    let node = box.querySelector('[role="status"]');
    if (!node) {
      node = el(doc, 'p', { role: 'status', 'aria-live': 'polite' });
      box.append(node);
    }
    node.setAttribute('data-tone', tone);
    node.textContent = message;
  }

  function renderSignup() {
    const c = copy();
    box.replaceChildren(el(doc, 'h2', {}, c.heading), el(doc, 'p', {}, c.description));
    const form = el(doc, 'form', { novalidate: '' });
    let nameInput: HTMLInputElement | null = null;
    if (opts.collectName) {
      nameInput = el(doc, 'input', { type: 'text', name: 'name', autocomplete: 'name', placeholder: c.nameLabel, 'aria-label': c.nameLabel });
      form.append(nameInput);
    }
    const email = el(doc, 'input', { type: 'email', name: 'email', required: '', autocomplete: 'email', placeholder: c.placeholder, 'aria-label': c.placeholder });
    const button = el(doc, 'button', { type: 'submit' }, c.button);
    form.append(email, button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        status(c.error, 'error');
        return;
      }
      button.disabled = true;
      void api
        .requestLink({
          email: value,
          ...(nameInput?.value.trim() ? { name: nameInput.value.trim() } : {}),
          ...(opts.newsletters?.length ? { newsletters: opts.newsletters } : {}),
          ...(opts.redirectUri ? { redirectUri: opts.redirectUri } : {}),
          intent: 'signup',
          locale,
        })
        .then((res) => {
          button.disabled = false;
          if (res.ok) status(c.success);
          else status(res.status === 429 ? res.message : c.error, 'error');
        });
    });
    box.append(form);
  }

  function renderAccount(member: PortalMember) {
    box.replaceChildren(el(doc, 'h2', {}, member.name || member.email));
    if (member.tier) box.append(el(doc, 'p', {}, member.tier.name));
    const subscribed = new Set(member.newsletters.map((n) => n.id));
    const list = el(doc, 'ul');
    for (const n of config?.newsletters ?? []) {
      if (n.audience === 'paid' && member.status === 'free') continue;
      const id = `lumi-nl-${n.id}`;
      const li = el(doc, 'li');
      const box2 = el(doc, 'input', { type: 'checkbox', id });
      box2.checked = subscribed.has(n.id);
      box2.addEventListener('change', () => {
        void api.update({ newsletters: { [n.id]: box2.checked } }).then((r) => (r.ok ? undefined : status(r.message, 'error')));
      });
      li.append(box2, el(doc, 'label', { for: id }, n.name));
      list.append(li);
    }
    box.append(list);

    const otherTiers = (config?.tiers ?? []).filter((t) => t.key !== member.tier?.key);
    for (const t of otherTiers) {
      const b = el(doc, 'button', { type: 'button', 'data-tier': t.key }, t.name);
      b.addEventListener('click', () => {
        b.disabled = true;
        void api.switchTier({ tier: t.key }).then((r) => {
          b.disabled = false;
          if (!r.ok) return status(r.message, 'error');
          if (r.data.status === 'checkout') {
            const target = normalizeBaseUrl(r.data.checkoutUrl) ? r.data.checkoutUrl : null;
            if (target && typeof window !== 'undefined') window.location.assign(target);
            return;
          }
          void refresh();
        });
      });
      box.append(b);
    }

    const unsub = el(doc, 'button', { type: 'button', 'data-variant': 'ghost', 'data-action': 'unsubscribe-all' }, 'Unsubscribe from all emails');
    unsub.addEventListener('click', () => void api.update({ unsubscribeAll: true }).then(() => refresh()));
    const out = el(doc, 'button', { type: 'button', 'data-variant': 'ghost', 'data-action': 'sign-out' }, 'Sign out');
    out.addEventListener('click', () => {
      session = null;
      saveSession(opts.siteId, null);
      renderSignup();
    });
    box.append(unsub, out);
  }

  async function landFromLink(): Promise<void> {
    const href = opts.location?.href ?? (typeof window !== 'undefined' ? window.location?.href : undefined);
    const taken = takeTokenFromUrl(href);
    if (!taken) return;
    const replace =
      opts.replaceUrl ??
      ((u: string) => {
        try {
          window.history.replaceState(window.history.state, '', u);
        } catch {
          /* sandboxed */
        }
      });
    replace(taken.cleanUrl);
    const res = await api.verify(taken.token);
    if (res.ok && res.data?.token) {
      session = { token: res.data.token, ...(res.data.refreshToken ? { refreshToken: res.data.refreshToken } : {}) };
      saveSession(opts.siteId, session);
    } else if (!res.ok) {
      status(res.message, 'error');
    }
  }

  async function refresh(): Promise<void> {
    const cfg = await api.config(locale);
    if (destroyed) return;
    if (!cfg.ok) {
      // Portal disabled or unreachable: render nothing rather than a broken form.
      box.replaceChildren();
      return;
    }
    config = cfg.data;
    await landFromLink();
    if (destroyed) return;
    if (session && opts.mode !== 'signup') {
      const me = await api.me();
      if (destroyed) return;
      if (me.ok && me.data) {
        renderAccount(me.data);
        opts.onSignedIn?.(me.data);
        return;
      }
      if (!me.ok && me.status === 401) {
        session = null;
        saveSession(opts.siteId, null);
      }
    }
    if (opts.mode === 'account') {
      box.replaceChildren();
      return;
    }
    renderSignup();
  }

  void refresh().catch(() => box.replaceChildren());
  return {
    refresh,
    destroy() {
      destroyed = true;
      root.replaceChildren();
    },
  };
}
