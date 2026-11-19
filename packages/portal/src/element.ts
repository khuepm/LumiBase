/**
 * `<lumi-portal>` custom element.
 *
 *   <lumi-portal api="https://cms.example.com" site="site_1" locale="vi"
 *                mode="auto" redirect-uri="https://blog.example.com/welcome"
 *                newsletters="weekly,product" collect-name layout="card"
 *                copy='{"button":{"vi":"Theo dõi"}}'></lumi-portal>
 *
 * A malformed `copy` / `newsletters` attribute is ignored, not thrown.
 */

import type { LocalizedOverride, SignupCopyKey } from '@lumibase/contracts/members';
import { mountPortal, type PortalHandle, type PortalOptions } from './mount';

export const PORTAL_TAG = 'lumi-portal';
const OBSERVED = ['api', 'site', 'locale', 'mode', 'redirect-uri', 'newsletters', 'collect-name', 'layout', 'copy'];

function parseCopy(raw: string | null): Partial<Record<SignupCopyKey, LocalizedOverride>> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<Record<SignupCopyKey, LocalizedOverride>>) : undefined;
  } catch {
    return undefined;
  }
}

export function optionsFromAttributes(node: Element): Partial<PortalOptions> {
  const attr = (n: string) => node.getAttribute(n) ?? node.getAttribute(`data-${n}`);
  const mode = attr('mode');
  const layout = attr('layout');
  const newsletters = (attr('newsletters') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
  return {
    url: attr('api') ?? '',
    siteId: attr('site') ?? '',
    ...(attr('locale') ? { locale: attr('locale')! } : {}),
    ...(mode === 'signup' || mode === 'account' || mode === 'auto' ? { mode } : {}),
    ...(layout === 'card' || layout === 'inline' || layout === 'minimal' ? { layout } : {}),
    ...(attr('redirect-uri') ? { redirectUri: attr('redirect-uri')! } : {}),
    ...(newsletters.length ? { newsletters } : {}),
    collectName: node.hasAttribute('collect-name') || node.hasAttribute('data-collect-name'),
    ...(parseCopy(attr('copy')) ? { copy: parseCopy(attr('copy'))! } : {}),
  };
}

export function definePortalElement(registry: CustomElementRegistry | undefined = globalThis.customElements): void {
  if (!registry || registry.get(PORTAL_TAG)) return;
  class LumiPortalElement extends HTMLElement {
    static get observedAttributes() {
      return OBSERVED;
    }
    private handle: PortalHandle | null = null;
    connectedCallback() {
      this.mount();
    }
    disconnectedCallback() {
      this.handle?.destroy();
      this.handle = null;
    }
    attributeChangedCallback() {
      if (this.isConnected) this.mount();
    }
    private mount() {
      this.handle?.destroy();
      this.handle = mountPortal(this, optionsFromAttributes(this));
    }
  }
  registry.define(PORTAL_TAG, LumiPortalElement);
}
