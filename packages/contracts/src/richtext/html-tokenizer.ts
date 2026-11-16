/**
 * A small, dependency-free HTML tokenizer used by the rich-text sanitiser and
 * the HTML → document importer (#700). It runs unchanged on Workers, Node and
 * in the browser (no DOM).
 *
 * It is deliberately forgiving rather than spec-complete: its output is never
 * trusted. The sanitiser rebuilds HTML only from allowlisted tag names and
 * attributes and escapes every text and attribute value it emits, so a
 * tokenizer mistake can lose content but cannot smuggle markup through.
 */

export type HtmlToken =
  | { kind: 'text'; text: string }
  | { kind: 'start'; name: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { kind: 'end'; name: string };

/** Elements whose content is raw text up to the matching end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200C',
  zwj: '\u200D',
  shy: '\u00AD',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  colon: ':',
  Tab: '\t',
  NewLine: '\n',
};

/** Decode character references (`&amp;`, `&#58;`, `&#x3A;`, common named ones). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,9}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref];
    return named ?? whole;
  });
}

const NAME_CHAR = /[^\s/>]/;

/** Tokenize an HTML string. Comments, doctypes, CDATA and processing instructions are dropped. */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const len = html.length;
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) tokens.push({ kind: 'text', text: decodeEntities(text) });
    text = '';
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    const next = html[i + 1];

    // Comment / conditional comment / doctype / CDATA.
    if (next === '!') {
      flush();
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end === -1 ? len : end + 3;
      } else {
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? len : end + 1;
      }
      continue;
    }
    if (next === '?') {
      flush();
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // End tag.
    if (next === '/') {
      const m = /^<\/([A-Za-z][^\s/>]*)[^>]*>?/.exec(html.slice(i, i + 512));
      if (m) {
        flush();
        tokens.push({ kind: 'end', name: m[1]!.toLowerCase() });
        // Skip to the closing `>` (attributes on end tags are ignored).
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? len : end + 1;
      } else {
        // `</` not followed by a name: a bogus comment up to `>`.
        flush();
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? len : end + 1;
      }
      continue;
    }

    // Start tag.
    if (next !== undefined && /[A-Za-z]/.test(next)) {
      flush();
      let j = i + 1;
      while (j < len && NAME_CHAR.test(html[j]!)) j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const attrs: Array<[string, string]> = [];
      let selfClosing = false;
      // Attributes.
      for (;;) {
        while (j < len && /\s/.test(html[j]!)) j++;
        if (j >= len) break;
        const c = html[j]!;
        if (c === '>') {
          j++;
          break;
        }
        if (c === '/') {
          j++;
          if (html[j] === '>') {
            selfClosing = true;
            j++;
            break;
          }
          continue;
        }
        let k = j;
        // An attribute name may start with `=`, but never contains whitespace, `/`, `>` or `=` after the first char.
        k++;
        while (k < len && !/[\s/>=]/.test(html[k]!)) k++;
        const attrName = html.slice(j, k).toLowerCase();
        j = k;
        while (j < len && /\s/.test(html[j]!)) j++;
        let value = '';
        if (html[j] === '=') {
          j++;
          while (j < len && /\s/.test(html[j]!)) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end === -1 ? len : end);
            j = end === -1 ? len : end + 1;
          } else {
            let e = j;
            while (e < len && !/[\s>]/.test(html[e]!)) e++;
            value = html.slice(j, e);
            j = e;
          }
        }
        if (!attrs.some(([n]) => n === attrName)) attrs.push([attrName, decodeEntities(value)]);
      }
      i = j;
      tokens.push({ kind: 'start', name, attrs, selfClosing });

      if (RAW_TEXT.has(name) && !selfClosing) {
        const close = new RegExp(`</${name}[\\s/>]`, 'i');
        const rest = html.slice(i);
        const m = close.exec(rest);
        const end = m ? i + m.index : len;
        const raw = html.slice(i, end);
        if (raw) tokens.push({ kind: 'text', text: name === 'textarea' || name === 'title' ? decodeEntities(raw) : raw });
        if (m) {
          tokens.push({ kind: 'end', name });
          const gt = html.indexOf('>', end);
          i = gt === -1 ? len : gt + 1;
        } else {
          i = len;
        }
      }
      continue;
    }

    // A lone `<` is text.
    text += '<';
    i += 1;
  }
  flush();
  return tokens;
}
