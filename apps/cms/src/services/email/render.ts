/**
 * Email template render engine.
 *
 * Deliberately dependency-free: a small, safe `{{var}}` substitution rather
 * than a full templating library. This keeps the Workers bundle lean and
 * avoids handing template authors arbitrary code execution.
 *
 * Substitution rules:
 *   - `{{ name }}`   → HTML-escaped value (default; safe for untrusted vars).
 *   - `{{{ name }}}` → raw value, NOT escaped (use only for trusted HTML,
 *                      e.g. a pre-rendered button block).
 *   - Unknown variables render as an empty string and are collected in
 *     `missing` so the caller (preview UI / send path) can warn — we never
 *     leave a literal `{{x}}` in delivered mail.
 *
 * Layout composition: a template's `bodyHtml` is injected into the layout's
 * `{{content}}` slot. The text body is never wrapped in a layout (layouts are
 * HTML shells only); when a template has no `bodyText`, the engine derives a
 * plain-text fallback by stripping tags from the rendered HTML so every email
 * carries a text/plain part for clients that need it.
 */

// ── Public shapes ───────────────────────────────────────────────────────

export interface RenderTemplateInput {
  readonly subject: string;
  readonly bodyHtml: string;
  /** Optional explicit text body; derived from HTML when absent. */
  readonly bodyText?: string | null;
}

export interface RenderLayoutInput {
  /** HTML shell containing a `{{content}}` slot. */
  readonly html: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Variable names referenced by the template but absent from `vars`. */
  readonly missing: string[];
}

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

// ── Engine ────────────────────────────────────────────────────────────

const TRIPLE_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}/g;
const DOUBLE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Render a template (optionally wrapped in a layout) against `vars`.
 *
 * The `content` slot in the layout is filled with the rendered template body
 * *before* the layout itself is substituted, so a layout may also reference
 * shared variables (e.g. `{{siteName}}`) from the same `vars` map.
 */
export function renderTemplate(
  template: RenderTemplateInput,
  layout: RenderLayoutInput | null,
  vars: TemplateVars,
): RenderedEmail {
  const missing = new Set<string>();

  const subject = substitute(template.subject, vars, missing);
  const renderedBody = substitute(template.bodyHtml, vars, missing);

  let html: string;
  if (layout) {
    // Inject the rendered body into the layout's content slot first, then
    // substitute the layout's own variables. `{{content}}` is treated as raw
    // (the body is already escaped/trusted at this point).
    const composed = layout.html.replace(/\{\{\{?\s*content\s*\}?\}\}/g, () => renderedBody);
    html = substitute(composed, vars, missing);
  } else {
    html = renderedBody;
  }

  const text = template.bodyText
    ? substitute(template.bodyText, vars, missing)
    : htmlToText(html);

  return { subject, html, text, missing: [...missing] };
}

/**
 * Apply triple-brace (raw) then double-brace (escaped) substitution. Records
 * any referenced variable not present in `vars` into `missing`.
 */
function substitute(input: string, vars: TemplateVars, missing: Set<string>): string {
  const withRaw = input.replace(TRIPLE_RE, (_m, name: string) => {
    if (name === 'content') return _m; // handled separately by the layout pass
    if (!(name in vars)) {
      missing.add(name);
      return '';
    }
    return stringify(vars[name]);
  });
  return withRaw.replace(DOUBLE_RE, (_m, name: string) => {
    if (name === 'content') return _m;
    if (!(name in vars)) {
      missing.add(name);
      return '';
    }
    return escapeHtml(stringify(vars[name]));
  });
}

function stringify(value: TemplateVars[string]): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Extract the variable names a template references (for UI hints / validation). */
export function extractVariables(...sources: string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    for (const re of [TRIPLE_RE, DOUBLE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const name = m[1];
        if (name && name !== 'content') found.add(name);
      }
    }
  }
  return [...found];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Crude HTML → text fallback for the text/plain alternative part. Drops
 * `<style>`/`<script>` blocks, turns block boundaries into newlines, strips
 * remaining tags, and decodes the handful of entities `escapeHtml` produces.
 * Not a full HTML renderer — and NOT a sanitizer: its output is plain text,
 * never re-inserted into an HTML context.
 *
 * Two correctness details:
 *   1. Tag stripping is done by an explicit single-pass character scan
 *      ({@link stripTags}) rather than regex tag-matching. The scanner copies
 *      only text that sits outside a `<…>` span and discards everything from a
 *      `<` to the next `>` (or to end-of-input for an unclosed `<`). Because it
 *      removes by the structural `<`/`>` delimiters — not by recognising a tag
 *      shape — no residual `<…>` can survive, even for overlapping or
 *      malformed markup like `<scr<script>ipt>`.
 *   2. Entity decoding is a single combined pass over a fixed map (with
 *      `&amp;` handled in the same pass, not afterwards), so an input like
 *      `&amp;lt;` decodes to the literal `&lt;` and is NOT double-unescaped
 *      into `<`.
 */
const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

/**
 * Tag names whose *closing* tag (or, for `br`, the self-closing tag) becomes a
 * newline in the text output. Only the close is mapped so a `<p>…</p>` pair
 * yields a single boundary, not two.
 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'tr', 'table', 'section', 'header', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * Strip HTML tags by scanning characters, not by matching tag patterns.
 *
 * Single forward pass:
 *   - text outside `<…>` is copied verbatim;
 *   - on `<`, skip to the next `>` (the whole tag is dropped); an unclosed `<`
 *     at end-of-input drops the remainder;
 *   - `<script>`/`<style>` open the corresponding raw-text mode, in which all
 *     content is discarded until the matching close tag;
 *   - a recognised block/`br` tag emits a `\n`.
 *
 * The result provably contains no `<` or `>` from a tag, so it needs no
 * follow-up bracket cleanup and no fixed-point loop.
 */
function stripTags(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch !== '<') {
      out += ch;
      i += 1;
      continue;
    }
    // At a '<': read up to the next '>' as the tag body.
    const close = input.indexOf('>', i + 1);
    const end = close === -1 ? n : close;
    const tagBody = input.slice(i + 1, end);
    const isClosing = /^\s*\//.test(tagBody);
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tagBody);
    const name = nameMatch ? nameMatch[1]!.toLowerCase() : '';

    if (name === 'script' || name === 'style') {
      // Discard everything until the matching close tag (case-insensitive),
      // or to end-of-input if it never closes.
      const closeTag = `</${name}`;
      const lower = input.toLowerCase();
      const rawEnd = lower.indexOf(closeTag, end + 1);
      if (rawEnd === -1) {
        i = n; // unterminated raw block — drop the rest
      } else {
        const afterClose = input.indexOf('>', rawEnd);
        i = afterClose === -1 ? n : afterClose + 1;
      }
      continue;
    }

    // Emit one boundary per block element: on its closing tag, or on a `br`
    // (which has no close). Avoids the double newline a `<p>…</p>` pair would
    // otherwise produce.
    if (name === 'br' || (isClosing && BLOCK_TAGS.has(name))) out += '\n';
    i = close === -1 ? n : close + 1; // skip the whole tag
  }
  // A lone `>` with no preceding `<` is harmless literal text in the
  // text/plain output, but strip any such residue so the result carries no
  // stray angle brackets at all.
  return out.replace(/[<>]/g, '');
}

export function htmlToText(html: string): string {
  const stripped = stripTags(html);
  // Single combined entity decode: each match maps once, so `&amp;lt;` →
  // `&lt;` (not `<`). `&amp;` is part of the same alternation, never a
  // separate later pass.
  const decoded = stripped.replace(
    /&nbsp;|&lt;|&gt;|&quot;|&#39;|&amp;/g,
    (m) => HTML_ENTITY_MAP[m] ?? m,
  );
  return decoded
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}
