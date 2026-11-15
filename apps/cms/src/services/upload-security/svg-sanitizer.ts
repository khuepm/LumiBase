/**
 * SVG sanitiser (#740, epic #674 S11).
 *
 * A small, dependency-free, single-pass tokenizer — Workers-safe (no DOM, no
 * jsdom). Elements are kept only if they are on an allow-list of SVG
 * presentation elements; attributes and URL-bearing values are filtered:
 *
 *  - removed as ACTIVE content (an upload carrying any of these is rejected):
 *    `<script>`, `<foreignObject>`, embedded browsing contexts, XHTML-namespace
 *    content, `on*` handlers, `javascript:` / `vbscript:` / `data:text/html`
 *    values (entity-obfuscated too), `<set>`/`<animate>` retargeting `href`,
 *    DOCTYPE / entity declarations, and non-`xml` processing instructions
 *    (`<?xml-stylesheet?>` can load XSLT);
 *  - removed as EXTERNAL references (neutralised when served): `href` /
 *    `xlink:href` / `src` that are not same-document fragments (`#id`) or
 *    inline raster `data:image/...;base64`, and CSS `url(...)` / `@import`
 *    that leave the document;
 *  - removed as UNKNOWN: elements outside the allow-list (dropped with their
 *    subtree).
 *
 * When nothing is removed the input string is returned unchanged (byte
 * identical), so clean SVGs round-trip exactly. When something is removed the
 * remaining markup is emitted from the original source slices, so formatting
 * of what survives is preserved.
 */

export type SvgFindingKind = 'active' | 'external' | 'unknown';

export interface SvgFinding {
  kind: SvgFindingKind;
  /** Short, non-sensitive description, e.g. `element:script`, `attr:onload`. */
  what: string;
}

export interface SvgSanitizeResult {
  /** The sanitised document (=== input when `changed` is false). */
  output: string;
  changed: boolean;
  findings: SvgFinding[];
}

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata', 'switch', 'view', 'a',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'tref', 'image',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
  'style', 'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'set', 'mpath',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
  'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood',
  'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge',
  'femergenode', 'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight',
  'fetile', 'feturbulence',
  'font', 'font-face', 'font-face-src', 'font-face-name', 'glyph', 'missing-glyph', 'hkern', 'vkern',
]);

/** Elements that execute or host executable/HTML content. */
const ACTIVE_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'foreignobject', 'iframe', 'frame', 'frameset', 'embed', 'object', 'applet',
  'handler', 'listener', 'meta', 'link', 'base', 'form', 'input', 'button', 'textarea',
  'font-face-uri', 'cursor',
]);

/** Elements whose content is raw text to the HTML parser. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/** Editor metadata namespaces kept verbatim (Inkscape, Sodipodi, RDF/Dublin Core). */
const ALLOWED_PREFIXES: ReadonlySet<string> = new Set(['svg', 'sodipodi', 'inkscape', 'rdf', 'dc', 'cc', 'xml']);

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const MATHML_NS = 'http://www.w3.org/1998/math/mathml';

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src']);
const ACTIVE_ATTRIBUTES: ReadonlySet<string> = new Set(['srcdoc', 'formaction', 'action']);
const SAFE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;

interface Attr {
  raw: string; // leading whitespace + name[=value]
  name: string; // lowercase qualified name
  value: string;
}

/** Sanitise an SVG document. Never throws. */
export function sanitizeSvg(input: string): SvgSanitizeResult {
  const findings: SvgFinding[] = [];
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = input.length;

  const drop = (kind: SvgFindingKind, what: string) => findings.push({ kind, what });

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      out.push(input.slice(i));
      break;
    }
    if (lt > i) out.push(input.slice(i, lt));
    i = lt;

    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      out.push(input.slice(i, stop));
      i = stop;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      const stop = end < 0 ? n : end + 3;
      out.push(input.slice(i, stop));
      i = stop;
      continue;
    }
    if (startsWithCI(input, i, '<!doctype') || startsWithCI(input, i, '<!entity') || input.startsWith('<!', i)) {
      drop('active', 'doctype');
      i = skipDeclaration(input, i);
      continue;
    }
    if (input.startsWith('<?', i)) {
      const end = input.indexOf('?>', i + 2);
      const stop = end < 0 ? n : end + 2;
      const target = /^<\?([^\s?]+)/.exec(input.slice(i, Math.min(stop, i + 64)))?.[1]?.toLowerCase();
      if (target === 'xml') out.push(input.slice(i, stop));
      else drop('active', `pi:${target ?? '?'}`);
      i = stop;
      continue;
    }
    if (input.startsWith('</', i)) {
      const end = input.indexOf('>', i + 2);
      const stop = end < 0 ? n : end + 1;
      const name = input.slice(i + 2, end < 0 ? n : end).trim().toLowerCase();
      // Emit only end tags that close an element we emitted.
      if (stack.length > 0 && stack[stack.length - 1] === name) {
        stack.pop();
        out.push(input.slice(i, stop));
      }
      i = stop;
      continue;
    }

    const tag = parseStartTag(input, i);
    if (!tag) {
      // A bare `<` that is not markup (malformed) — escape it so it cannot
      // start a tag in a lenient parser.
      out.push('&lt;');
      i += 1;
      continue;
    }

    const local = localName(tag.name);
    const prefix = tag.name.includes(':') ? tag.name.slice(0, tag.name.indexOf(':')) : null;
    const declaresForeignNs = tag.attrs.some(
      (a) => (a.name === 'xmlns' || a.name.startsWith('xmlns:')) && isForeignNamespace(a.value),
    );
    const retargetsHref =
      (local === 'set' || local.startsWith('animate')) &&
      tag.attrs.some((a) => a.name === 'attributename' && /^(?:xlink:)?href$/i.test(a.value.trim()));

    let elementVerdict: SvgFindingKind | null = null;
    if (ACTIVE_ELEMENTS.has(local) || declaresForeignNs || retargetsHref) elementVerdict = 'active';
    else if (prefix !== null && !ALLOWED_PREFIXES.has(prefix)) elementVerdict = 'unknown';
    else if (prefix === null || prefix === 'svg') {
      if (!ALLOWED_ELEMENTS.has(local)) elementVerdict = 'unknown';
    }

    if (elementVerdict) {
      drop(elementVerdict, `element:${local}`);
      i = tag.selfClosing ? tag.end : skipElement(input, tag.end, tag.name, RAW_TEXT_ELEMENTS.has(local));
      continue;
    }

    if (local === 'style' && !tag.selfClosing) {
      const close = indexOfCI(input, `</${tag.name}`, tag.end);
      const css = input.slice(tag.end, close < 0 ? n : close);
      const verdict = cssVerdict(css);
      if (verdict) {
        drop(verdict, 'element:style');
        i = skipElement(input, tag.end, tag.name, true);
        continue;
      }
    }

    // Filter attributes.
    const kept: Attr[] = [];
    let attrsChanged = false;
    for (const attr of tag.attrs) {
      const verdict = attributeVerdict(attr);
      if (verdict) {
        drop(verdict, `attr:${attr.name}`);
        attrsChanged = true;
      } else {
        kept.push(attr);
      }
    }
    out.push(
      attrsChanged
        ? `<${tag.rawName}${kept.map((a) => a.raw).join('')}${tag.selfClosing ? '/>' : '>'}`
        : input.slice(i, tag.end),
    );
    if (!tag.selfClosing) stack.push(tag.name);
    i = tag.end;
  }

  if (findings.length === 0) return { output: input, changed: false, findings };
  return { output: out.join(''), changed: true, findings };
}

/** True when the SVG carries any script-capable content. */
export function svgSanitizerFindsActiveContent(input: string): boolean {
  return sanitizeSvg(input).findings.some((f) => f.kind === 'active');
}

function attributeVerdict(attr: Attr): SvgFindingKind | null {
  const local = localName(attr.name);
  if (local.startsWith('on')) return 'active';
  if (ACTIVE_ATTRIBUTES.has(local)) return 'active';
  if ((attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) && isForeignNamespace(attr.value)) return 'active';

  const squashed = squash(decodeEntities(attr.value));
  if (squashed.includes('javascript:') || squashed.includes('vbscript:') || squashed.includes('data:text/html')) {
    return 'active';
  }

  if (URL_ATTRIBUTES.has(local) && !attr.name.startsWith('xmlns')) {
    const value = decodeEntities(attr.value).trim();
    if (value.startsWith('#')) return null;
    if (SAFE_DATA_URL.test(value)) return null;
    return 'external';
  }
  if (local === 'style') return cssVerdict(attr.value);
  return null;
}

/** CSS that executes (`expression(`, `javascript:`) or leaves the document. */
function cssVerdict(css: string): SvgFindingKind | null {
  const squashed = squash(decodeEntities(css));
  if (squashed.includes('expression(') || squashed.includes('javascript:') || squashed.includes('-moz-binding')) {
    return 'active';
  }
  if (squashed.includes('@import')) return 'external';
  const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  const decoded = decodeEntities(css);
  while ((match = urlRe.exec(decoded)) !== null) {
    const target = (match[2] ?? '').trim();
    if (target.startsWith('#') || SAFE_DATA_URL.test(target)) continue;
    return 'external';
  }
  return null;
}

function isForeignNamespace(value: string): boolean {
  const ns = value.trim().toLowerCase();
  return ns === XHTML_NS || ns === MATHML_NS;
}

interface StartTag {
  name: string; // lowercase qualified name
  rawName: string;
  attrs: Attr[];
  selfClosing: boolean;
  end: number; // index after `>`
}

function parseStartTag(input: string, start: number): StartTag | null {
  const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(input.slice(start, start + 256));
  if (!nameMatch) return null;
  const rawName = nameMatch[1]!;
  let i = start + nameMatch[0].length;
  const attrs: Attr[] = [];
  const n = input.length;
  for (;;) {
    const wsStart = i;
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) return { name: rawName.toLowerCase(), rawName, attrs, selfClosing: false, end: n };
    if (input[i] === '>') return { name: rawName.toLowerCase(), rawName, attrs, selfClosing: false, end: i + 1 };
    if (input.startsWith('/>', i)) return { name: rawName.toLowerCase(), rawName, attrs, selfClosing: true, end: i + 2 };
    if (input[i] === '/') {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && !/[\s=/>"']/.test(input[i]!)) i++;
    if (i === nameStart) {
      // Stray quote or `=`: skip it; it is not re-emitted unless the tag is
      // emitted verbatim (no findings), where the browser sees the same bytes.
      i++;
      continue;
    }
    const name = input.slice(nameStart, i);
    let j = i;
    while (j < n && /\s/.test(input[j]!)) j++;
    let value = '';
    if (input[j] === '=') {
      j++;
      while (j < n && /\s/.test(input[j]!)) j++;
      const quote = input[j];
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, j + 1);
        const stop = close < 0 ? n : close;
        value = input.slice(j + 1, stop);
        j = close < 0 ? n : close + 1;
      } else {
        const valueStart = j;
        while (j < n && input[j] !== '>' && !/\s/.test(input[j]!)) j++;
        value = input.slice(valueStart, j);
      }
      i = j;
    }
    attrs.push({ raw: input.slice(wsStart, i), name: name.toLowerCase(), value });
  }
}

/** Skip past the end of an element whose start tag ended at `from`. */
function skipElement(input: string, from: number, name: string, rawText: boolean): number {
  if (rawText) {
    const close = indexOfCI(input, `</${name}`, from);
    if (close < 0) return input.length;
    const gt = input.indexOf('>', close);
    return gt < 0 ? input.length : gt + 1;
  }
  let depth = 1;
  let i = from;
  while (i < input.length && depth > 0) {
    const lt = input.indexOf('<', i);
    if (lt < 0) return input.length;
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('</', lt)) {
      const gt = input.indexOf('>', lt);
      if (input.slice(lt + 2, gt < 0 ? input.length : gt).trim().toLowerCase() === name) depth--;
      i = gt < 0 ? input.length : gt + 1;
      continue;
    }
    const tag = parseStartTag(input, lt);
    if (tag) {
      if (!tag.selfClosing && tag.name === name) depth++;
      i = tag.end;
    } else {
      i = lt + 1;
    }
  }
  return i;
}

/** Skip a `<!...>` declaration, including a bracketed internal subset. */
function skipDeclaration(input: string, start: number): number {
  let i = start + 2;
  let bracket = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '>' && bracket === 0) return i + 1;
    else if (ch === '"' || ch === "'") {
      const close = input.indexOf(ch, i + 1);
      i = close < 0 ? input.length : close;
    }
    i++;
  }
  return input.length;
}

function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return (colon >= 0 ? qualified.slice(colon + 1) : qualified).toLowerCase();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')',
};

/** Decode numeric and the security-relevant named character references. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Lowercase and drop whitespace/control chars (`java\tscript:` → `javascript:`). */
function squash(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) out += ch;
  }
  return out.toLowerCase();
}

function startsWithCI(input: string, at: number, needle: string): boolean {
  return input.slice(at, at + needle.length).toLowerCase() === needle;
}

/**
 * Case-insensitive (ASCII) indexOf without lowercasing the whole document —
 * full-string lowercasing per call would be quadratic on SVGs with many
 * `<style>` blocks, and Unicode lowercasing can change string length.
 */
function indexOfCI(input: string, needle: string, from: number): number {
  const lowerNeedle = needle.toLowerCase();
  const first = lowerNeedle.charCodeAt(0);
  for (let i = Math.max(0, from); i <= input.length - lowerNeedle.length; i++) {
    if (asciiLower(input.charCodeAt(i)) !== first) continue;
    let matched = true;
    for (let j = 1; j < lowerNeedle.length; j++) {
      if (asciiLower(input.charCodeAt(i + j)) !== lowerNeedle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}
