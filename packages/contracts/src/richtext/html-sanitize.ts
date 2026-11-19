import { tokenizeHtml } from './html-tokenizer';
import { escapeHtml, safeHref, safeSrc } from './url';

/**
 * Allowlist HTML sanitiser (#700) — the last step before rich-text HTML is
 * delivered or injected into a page.
 *
 * Output is rebuilt from tokens: only allowlisted elements and attributes
 * survive, every text node and attribute value is re-escaped, URL attributes
 * pass the scheme allowlist, open elements are closed, and stray end tags are
 * dropped. It never emits `style`, event handlers, `<script>`, `<iframe>`,
 * forms or `srcdoc`, so the result is safe under a CSP without
 * `'unsafe-inline'`.
 */

export interface HtmlSanitizePolicy {
  /** Element → allowed attributes (besides the global ones). */
  elements: Readonly<Record<string, readonly string[]>>;
  /** Attributes allowed on every allowlisted element. */
  globalAttributes: readonly string[];
  /** Attribute name prefixes allowed on every element (e.g. `data-ref-`). */
  globalAttributePrefixes: readonly string[];
  /** Elements removed together with everything inside them. */
  dropContent: readonly string[];
}

const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col']);

/** The allowlist rich-text rendering needs; extend a copy rather than mutating it. */
export const DEFAULT_HTML_POLICY: HtmlSanitizePolicy = {
  elements: {
    p: [],
    br: [],
    hr: [],
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    s: [],
    del: [],
    ins: [],
    mark: [],
    small: [],
    code: ['class'],
    pre: [],
    kbd: [],
    sup: ['id'],
    sub: [],
    blockquote: ['cite'],
    ul: [],
    ol: ['start', 'reversed'],
    li: ['id'],
    a: ['href', 'title', 'id', 'rel', 'aria-label'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    figure: [],
    figcaption: [],
    table: [],
    caption: [],
    colgroup: [],
    col: ['span'],
    thead: [],
    tbody: [],
    tfoot: [],
    tr: [],
    th: ['scope', 'colspan', 'rowspan', 'headers', 'abbr'],
    td: ['colspan', 'rowspan', 'headers'],
    section: ['id', 'role', 'aria-label'],
    div: [],
    span: [],
    aside: [],
    dl: [],
    dt: [],
    dd: [],
    abbr: ['title'],
    cite: [],
    q: ['cite'],
    time: ['datetime'],
  },
  globalAttributes: ['lang', 'dir', 'class', 'data-block', 'data-align', 'aria-describedby', 'aria-hidden'],
  globalAttributePrefixes: ['data-ref-', 'data-lb-'],
  dropContent: ['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'noembed', 'noframes', 'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math', 'select', 'button', 'head'],
};

const URL_ATTRS: Record<string, (v: string) => string | null> = {
  href: safeHref,
  cite: safeHref,
  src: safeSrc,
};

const CLASS_TOKEN = /^(language-[A-Za-z0-9_+#.-]{1,32}|lb-[A-Za-z0-9_-]{1,64}|footnotes?|footnote-ref|footnote-backref)$/;

function cleanAttr(name: string, value: string): string | null {
  const url = URL_ATTRS[name];
  if (url) return url(value);
  switch (name) {
    case 'class': {
      const kept = value.split(/\s+/).filter((t) => CLASS_TOKEN.test(t));
      return kept.length ? kept.join(' ') : null;
    }
    case 'scope':
      return ['row', 'col', 'rowgroup', 'colgroup'].includes(value.toLowerCase()) ? value.toLowerCase() : null;
    case 'colspan':
    case 'rowspan':
    case 'span':
    case 'start':
    case 'width':
    case 'height':
      return /^\d{1,4}$/.test(value.trim()) ? value.trim() : null;
    case 'dir':
      return ['ltr', 'rtl', 'auto'].includes(value.toLowerCase()) ? value.toLowerCase() : null;
    case 'loading':
      return value === 'lazy' || value === 'eager' ? value : null;
    case 'rel':
      return value
        .split(/\s+/)
        .filter((t) => ['nofollow', 'noopener', 'noreferrer', 'ugc', 'sponsored'].includes(t.toLowerCase()))
        .join(' ') || null;
    case 'role':
      return value === 'doc-endnotes' || value === 'note' ? value : null;
    case 'reversed':
      return '';
    case 'data-align':
      return ['left', 'center', 'right'].includes(value) ? value : null;
    default:
      return value;
  }
}

function allowedAttr(policy: HtmlSanitizePolicy, el: string, name: string): boolean {
  if (name.startsWith('on')) return false;
  if (name === 'style' || name === 'srcdoc' || name === 'srcset' || name === 'formaction') return false;
  return (
    (Object.hasOwn(policy.elements, el) ? policy.elements[el]! : []).includes(name) ||
    policy.globalAttributes.includes(name) ||
    policy.globalAttributePrefixes.some((p) => name.startsWith(p) && /^[a-z0-9-]+$/.test(name))
  );
}

/** Sanitise an HTML fragment against `policy` (default: {@link DEFAULT_HTML_POLICY}). */
export function sanitizeHtml(html: string, policy: HtmlSanitizePolicy = DEFAULT_HTML_POLICY): string {
  const tokens = tokenizeHtml(html);
  const out: string[] = [];
  const stack: string[] = [];
  let dropDepth = 0;
  const dropStack: string[] = [];

  for (const t of tokens) {
    if (dropDepth > 0) {
      if (t.kind === 'start' && dropStack[dropStack.length - 1] === t.name && !t.selfClosing) {
        dropDepth++;
        dropStack.push(t.name);
      } else if (t.kind === 'end' && dropStack[dropStack.length - 1] === t.name) {
        dropDepth--;
        dropStack.pop();
      }
      continue;
    }
    if (t.kind === 'text') {
      out.push(escapeHtml(t.text));
      continue;
    }
    if (t.kind === 'start') {
      if (policy.dropContent.includes(t.name)) {
        if (!t.selfClosing && !VOID.has(t.name)) {
          dropDepth = 1;
          dropStack.push(t.name);
        }
        continue;
      }
      if (!Object.hasOwn(policy.elements, t.name)) continue; // unwrap: keep the children
      let attrs = '';
      for (const [name, raw] of t.attrs) {
        if (!allowedAttr(policy, t.name, name)) continue;
        const value = cleanAttr(name, raw);
        if (value === null) continue;
        attrs += value === '' && name === 'reversed' ? ' reversed' : ` ${name}="${escapeHtml(value)}"`;
      }
      out.push(`<${t.name}${attrs}>`);
      if (!VOID.has(t.name)) stack.push(t.name);
      continue;
    }
    // End tag: close up to the matching open element; ignore strays.
    if (VOID.has(t.name)) continue;
    const at = stack.lastIndexOf(t.name);
    if (at === -1) continue;
    while (stack.length > at) out.push(`</${stack.pop()}>`);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

