import createDOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';

// The DOMPurify default export is a factory that must be bound to a `window`
// before `sanitize`/`addHook` exist. The Studio bundle only ever runs against
// a DOM (the browser, or jsdom under test), so we bind to `window` directly.
const DOMPurify: DOMPurifyInstance = createDOMPurify(window);

/**
 * Centralised HTML sanitiser for the Studio SPA.
 *
 * Any user- or extension-supplied HTML that ends up in `innerHTML` /
 * `dangerouslySetInnerHTML` MUST pass through here first. DOMPurify strips
 * scripts, event handlers (`onerror=…`), and dangerous URL schemes
 * (`javascript:`, `data:` on navigable elements), neutralising both Stored
 * and Reflected XSS while keeping the safe rich-text markup our editors emit.
 *
 * Centralising the config means one place to audit and one place to tighten.
 */

/** Tags allowed in rich-text content produced by the WYSIWYG / markdown editors. */
const ALLOWED_TAGS = [
  'a', 'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del',
  'p', 'br', 'hr', 'span', 'div', 'blockquote',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'pre', 'code', 'kbd', 'samp',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img',
];

const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'src', 'alt', 'class'];

/**
 * Sanitise an HTML string for safe insertion into the DOM.
 *
 * `target="_blank"` links are hardened with `rel="noopener noreferrer"` via the
 * hook below so sanitised output never opens a `window.opener` tabnabbing hole.
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Block javascript:/vbscript:/data: on navigable attributes; allow http(s),
    // mailto, tel, relative, and fragment links plus inline image data URIs.
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

// Force safe rel on any link that opens a new tab (defence-in-depth tabnabbing).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
