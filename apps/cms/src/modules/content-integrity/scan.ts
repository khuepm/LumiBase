/**
 * Content-integrity scan (#989) — pure, no I/O.
 *
 * Looks inside the content a write leaves live for the two signals FBI FLASH
 * CC-111626-MW describes on compromised sites, that the site owner's usual
 * checks miss:
 *
 *   - `download_link`: a link to an executable or archive (`.zip`, `.js`,
 *     `.exe`, …) on a host that is not the site's own. Gootloader's lure pages
 *     hand the visitor a ZIP holding a JavaScript file.
 *   - `offsite_seo_url`: a canonical / Open Graph URL that points at another
 *     host, which hands the page's search ranking to someone else.
 *
 * Strings are searched wherever they are — plain fields, nested JSON, rich
 * text documents, HTML fragments — so the scan does not depend on the schema.
 * Only the URL's host and file extension are reported, never the content.
 */

export type ContentIntegritySignalKind = 'download_link' | 'offsite_seo_url' | 'publish_burst' | 'first_publish_by_principal';

export interface ContentIntegritySignal {
  kind: ContentIntegritySignalKind;
  /** Dotted path of the field that carried it (`body.content.3.attrs.href`). */
  field?: string;
  /** Host of the offending URL. */
  host?: string;
  /** File extension of a download link (`zip`). */
  extension?: string;
  /** Publish count in the window, for `publish_burst`. */
  count?: number;
  /** Account that published for the first time, for `first_publish_by_principal`. */
  userId?: string;
}

/** Extensions that run code or wrap code on a visitor's machine. */
export const RISKY_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  '7z', 'apk', 'appx', 'bat', 'cab', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe', 'gz', 'hta', 'img',
  'iso', 'jar', 'js', 'jse', 'lnk', 'msi', 'msix', 'pif', 'ps1', 'rar', 'reg', 'scr', 'sh', 'tar',
  'tgz', 'vbe', 'vbs', 'wsf', 'xz', 'zip',
]);

/** Keys whose value is a canonical / social URL (case-insensitive). */
const SEO_URL_KEY = /^(canonical(_?url)?|seo_?canonical|og_?url|og:url|opengraph_?url|twitter_?url)$/i;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()\\]+/gi;
const MAX_STRINGS = 5000;
const MAX_SIGNALS = 20;

/**
 * Registrable-domain approximation: the last two labels, or three when the
 * second-level label is a common public suffix part (`co.uk`, `com.au`). Good
 * enough to treat `cms.acme.com` and `www.acme.com` as one site; operators add
 * anything else with `contentIntegrity.allowedHosts`.
 */
export function siteKey(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2]!;
  const take = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(second) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

export interface ScanOptions {
  /** Hosts that belong to the site (CMS domains, frontend, CDN). */
  siteHosts: readonly string[];
}

export function scanContent(content: unknown, options: ScanOptions): ContentIntegritySignal[] {
  const own = new Set(options.siteHosts.map(siteKey));
  const isOwn = (host: string) => own.has(siteKey(host));
  const knowsOwnHosts = own.size > 0;
  const signals: ContentIntegritySignal[] = [];
  const seen = new Set<string>();
  let budget = MAX_STRINGS;

  const push = (signal: ContentIntegritySignal) => {
    const key = `${signal.kind}|${signal.field ?? ''}|${signal.host ?? ''}|${signal.extension ?? ''}`;
    if (seen.has(key) || signals.length >= MAX_SIGNALS) return;
    seen.add(key);
    signals.push(signal);
  };

  const visitString = (value: string, path: string, key: string | null) => {
    if (budget-- <= 0) return;
    for (const match of value.matchAll(URL_PATTERN)) {
      const url = parseUrl(match[0]);
      if (!url) continue;
      const host = url.hostname.toLowerCase();
      const extension = extensionOf(url.pathname);
      if (extension && RISKY_DOWNLOAD_EXTENSIONS.has(extension) && !isOwn(host)) {
        push({ kind: 'download_link', field: path, host, extension });
      }
      if (key && SEO_URL_KEY.test(key) && knowsOwnHosts && !isOwn(host)) {
        push({ kind: 'offsite_seo_url', field: path, host });
      }
    }
  };

  const visit = (value: unknown, path: string, key: string | null, depth: number) => {
    if (depth > 32 || budget <= 0) return;
    if (typeof value === 'string') {
      visitString(value, path, key);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, path ? `${path}.${index}` : String(index), key, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? `${path}.${childKey}` : childKey, childKey, depth + 1);
      }
    }
  };

  visit(content, '', null, 0);
  return signals;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.replace(/[.,;:!?]+$/, ''));
  } catch {
    return null;
  }
}

function extensionOf(pathname: string): string | null {
  let last: string;
  try {
    last = decodeURIComponent(pathname.split('/').pop() ?? '');
  } catch {
    last = pathname.split('/').pop() ?? '';
  }
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return null;
  return last.slice(dot + 1).toLowerCase();
}
