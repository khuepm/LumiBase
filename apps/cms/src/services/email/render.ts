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
 * Two correctness details (flagged by CodeQL):
 *   1. Tag/block stripping is applied in a fixed-point loop rather than a
 *      single pass, so overlapping or nested constructs (e.g. `<scr<script>`
 *      `ipt>`) can't leave a residual tag after one rewrite.
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

function stripTags(input: string): string {
  let prev: string;
  let out = input;
  // Loop to a fixed point so a tag revealed by removing another tag is also
  // removed (defends against overlapping/malformed markup like `<scr<b>ipt>`).
  do {
    prev = out;
    out = out
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|section|header|footer)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^<>]*>/g, '');
  } while (out !== prev);
  // Drop any stray angle brackets left by truncated/unclosed tags so the
  // text/plain output never contains a residual `<` or `>` fragment. We strip
  // only the bracket characters (not the surrounding text) to avoid eating
  // legitimate content after an unclosed `<`.
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
