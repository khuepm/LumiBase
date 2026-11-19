/**
 * URL scheme allowlist (#700). Everything that becomes an `href` / `src` in
 * rendered rich text goes through one of these.
 */

/** Schemes a link may use. */
export const RICHTEXT_LINK_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel'];
/** Schemes an image / media source may use. */
export const RICHTEXT_MEDIA_SCHEMES: readonly string[] = ['http', 'https'];

// Browsers drop ASCII whitespace and C0 controls anywhere in the scheme part
// (`java\tscript:`), so they are removed before the scheme is read.
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u0000-\u0020\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]+/g;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function allow(url: string, schemes: readonly string[]): string | null {
  if (typeof url !== 'string') return null;
  const cleaned = url.replace(STRIPPED, '');
  if (!cleaned) return null;
  // A backslash is read as `/` by browsers: `\\evil.com` would be protocol-relative.
  if (cleaned.startsWith('\\')) return null;
  const m = SCHEME.exec(cleaned);
  if (m) return schemes.includes(m[1]!.toLowerCase()) ? url.trim() : null;
  // `&#106;avascript:` style entity tricks only matter once the value is
  // decoded; values reach here decoded, but an encoded colon is refused too.
  if (/&#|%3a/i.test(cleaned.split(/[/?#]/)[0]!)) return null;
  // Relative URL (`/a`, `./a`, `a/b`, `#x`, `?q`, `//host/x`).
  return url.trim();
}

/**
 * Keep http(s), mailto, tel and relative URLs; drop everything else
 * (`javascript:`, `data:`, `vbscript:`, `file:`…). Control characters and
 * whitespace that browsers strip before parsing the scheme are removed first,
 * so `java\tscript:` is caught too. Returns the trimmed URL or `null`.
 */
export function safeHref(href: string): string | null {
  return allow(href, RICHTEXT_LINK_SCHEMES);
}

/** Like {@link safeHref} for `src`: http(s) and relative URLs only (no `data:`). */
export function safeSrc(src: string): string | null {
  return allow(src, RICHTEXT_MEDIA_SCHEMES);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
