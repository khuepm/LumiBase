/**
 * Slug charset policy (#751) — shared by the CMS (server-side enforcement on
 * item write) and the Studio (auto-format on blur + live hint).
 *
 * Pure functions, no zod: importable from `@lumibase/contracts/field` without
 * pulling a schema library into the bundle.
 *
 *  - `ascii`   — transliterate to `[a-z0-9]` (Vietnamese and other Latin
 *                diacritics fold to their base letter: "Tiếng Việt" → "tieng-viet",
 *                "Đà Nẵng" → "da-nang").
 *  - `unicode` — keep letters, numbers and combining marks of every script
 *                (Unicode classes `\p{L}`, `\p{N}`, `\p{M}`), NFC-normalised.
 *  - `custom`  — generate like `unicode`, validate against an admin-supplied
 *                pattern from a restricted, linear-time regex subset (see
 *                `compileSlugPattern`).
 *
 * Lengths everywhere are counted in Unicode code points, not UTF-16 units.
 */

export type SlugCharset = 'ascii' | 'unicode' | 'custom';
export type SlugSeparator = '-' | '_' | '.';

export interface SlugPolicy {
  charset: SlugCharset;
  /** Required for `custom`, rejected otherwise. Restricted regex subset. */
  pattern?: string;
  /** Lower-case the slug. Default `true`. */
  lowercase?: boolean;
  /** Word separator. Default `-`. */
  separator?: SlugSeparator;
}

export const SLUG_CHARSETS: readonly SlugCharset[] = ['ascii', 'unicode', 'custom'];
export const SLUG_SEPARATORS: readonly SlugSeparator[] = ['-', '_', '.'];
/** Maximum length (code points) of a custom slug pattern source. */
export const SLUG_PATTERN_MAX_LENGTH = 200;
/** Maximum number of NFA positions a custom pattern may expand to. */
export const SLUG_PATTERN_MAX_STATES = 512;
/** Largest `{n,m}` bound accepted in a custom pattern. */
export const SLUG_PATTERN_MAX_REPEAT = 100;

/** Policy applied when a field configures none (the historical Studio behaviour). */
export const DEFAULT_SLUG_POLICY: Readonly<Required<Omit<SlugPolicy, 'pattern'>>> = {
  charset: 'ascii',
  lowercase: true,
  separator: '-',
};

/** Count Unicode code points (a surrogate pair counts once). */
export function codePointLength(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const d = value.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Truncate to at most `max` code points without splitting a surrogate pair. */
export function truncateCodePoints(value: string, max: number): string {
  if (codePointLength(value) <= max) return value;
  return Array.from(value).slice(0, Math.max(0, max)).join('');
}

/**
 * Letters that Unicode decomposition (NFKD) does not split into base letter +
 * combining mark, so stripping marks alone would drop them.
 */
const ASCII_FOLD: Record<string, string> = {
  đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE',
  ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', þ: 'th', Þ: 'TH', ı: 'i', ħ: 'h', Ħ: 'H', ŧ: 't',
  Ŧ: 'T', ŋ: 'ng', Ŋ: 'NG', ſ: 's', ĸ: 'k',
};
const ASCII_FOLD_RE = new RegExp(`[${Object.keys(ASCII_FOLD).join('')}]`, 'gu');

/** Fold Latin diacritics to ASCII ("Tiếng Việt" → "Tieng Viet"). Other scripts pass through. */
export function transliterateToAscii(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(ASCII_FOLD_RE, (ch) => ASCII_FOLD[ch] ?? '');
}

/** Escape for use OUTSIDE a character class (valid under the `u` flag, which rejects `\-`). */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function resolve(policy?: SlugPolicy | null) {
  return {
    charset: policy?.charset ?? DEFAULT_SLUG_POLICY.charset,
    lowercase: policy?.lowercase ?? DEFAULT_SLUG_POLICY.lowercase,
    separator: policy?.separator ?? DEFAULT_SLUG_POLICY.separator,
    pattern: policy?.pattern,
  };
}

function joinTokens(value: string, separator: string): string {
  return value.split(separator).filter(Boolean).join(separator);
}

/**
 * Turn arbitrary text into a slug under `policy`. Idempotent:
 * `slugify(slugify(x, p), p) === slugify(x, p)`.
 *
 * `maxLength` truncates by code points (then drops a dangling separator).
 * For `custom` the result is generated like `unicode`; use `checkSlug` to
 * confirm it satisfies the pattern.
 */
export function slugify(
  input: string,
  policy?: SlugPolicy | null,
  opts: { maxLength?: number } = {},
): string {
  const p = resolve(policy);
  let s = input;
  if (p.charset === 'ascii') {
    if (p.lowercase) s = s.toLowerCase();
    s = transliterateToAscii(s);
    if (p.lowercase) s = s.toLowerCase();
    s = s.replace(p.lowercase ? /[^a-z0-9]+/g : /[^A-Za-z0-9]+/g, p.separator);
  } else {
    s = s.normalize('NFC');
    if (p.lowercase) s = s.toLowerCase().normalize('NFC');
    s = s.replace(/[^\p{L}\p{N}\p{M}]+/gu, p.separator);
  }
  s = joinTokens(s, p.separator);
  if (opts.maxLength !== undefined && opts.maxLength > 0) {
    s = joinTokens(truncateCodePoints(s, opts.maxLength), p.separator);
  }
  return s;
}

/**
 * Validate an existing slug against `policy`. Returns `null` when valid or a
 * human-readable reason. Built-in charsets use separator-anchored regexes that
 * cannot backtrack catastrophically (the separator is outside the token class);
 * `custom` uses the linear-time matcher from `compileSlugPattern`.
 */
export function checkSlug(value: string, policy?: SlugPolicy | null): string | null {
  const p = resolve(policy);
  const sep = escapeRegex(p.separator);
  if (p.charset === 'custom') {
    const compiled = compileSlugPattern(p.pattern ?? '');
    if (!compiled.ok) return `slug pattern is invalid: ${compiled.error}`;
    if (!compiled.test(value)) return `must match the slug pattern ${p.pattern}`;
    return null;
  }
  if (p.charset === 'ascii') {
    const cls = p.lowercase ? 'a-z0-9' : 'A-Za-z0-9';
    const re = new RegExp(`^[${cls}]+(?:${sep}[${cls}]+)*$`);
    if (!re.test(value)) {
      return `must be an ASCII slug of ${p.lowercase ? 'lowercase ' : ''}letters and digits separated by "${p.separator}"`;
    }
    return null;
  }
  const re = new RegExp(`^[\\p{L}\\p{N}\\p{M}]+(?:${sep}[\\p{L}\\p{N}\\p{M}]+)*$`, 'u');
  if (!re.test(value)) {
    return `must be a slug of Unicode letters and numbers separated by "${p.separator}"`;
  }
  if (value.normalize('NFC') !== value) return 'must be NFC-normalised';
  if (p.lowercase && value.toLowerCase() !== value) return 'must be lowercase';
  return null;
}

// ─── Custom pattern: restricted subset + linear-time matcher ────────────────

type Kind = 'one' | 'opt' | 'star';
interface Atom {
  test: RegExp;
  min: number;
  max: number;
}

export type CompiledSlugPattern =
  | { ok: true; test: (value: string) => boolean; states: number }
  | { ok: false; error: string };

const ALLOWED_LETTER_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S', 'n', 't', 'r', 'f', 'v']);

/**
 * Compile an admin-supplied slug pattern WITHOUT handing the whole pattern to
 * the backtracking regex engine (no ReDoS).
 *
 * Accepted subset: a sequence of atoms — literal characters, escaped
 * punctuation, `.`, `\d \w \s` (and negations), `\p{…}`/`\P{…}`, and
 * bracket classes `[…]` — each optionally followed by one quantifier
 * (`* + ? {n} {n,} {n,m}`, bounds ≤ 100). A leading `^` and trailing `$` are
 * accepted and implied anyway (the whole value must match).
 *
 * Rejected: groups `( )`, alternation `|`, backreferences, lookaround, word
 * boundaries, stacked quantifiers, sources longer than 200 code points, and
 * patterns expanding beyond 512 NFA positions.
 *
 * Each atom is compiled as its own single-character regex (O(1) per test);
 * the sequence is matched by Thompson-NFA simulation, O(value × positions).
 */
export function compileSlugPattern(source: string): CompiledSlugPattern {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, error: 'pattern is empty' };
  const chars = Array.from(source);
  if (chars.length > SLUG_PATTERN_MAX_LENGTH) {
    return { ok: false, error: `pattern exceeds ${SLUG_PATTERN_MAX_LENGTH} characters` };
  }
  let i = 0;
  let end = chars.length;
  if (chars[0] === '^') i = 1;
  if (end > i && chars[end - 1] === '$' && chars[end - 2] !== '\\') end -= 1;

  const atoms: Atom[] = [];
  while (i < end) {
    const ch = chars[i]!;
    let atomSrc: string;
    if (ch === '(' || ch === ')' || ch === '|') {
      return { ok: false, error: 'groups and alternation are not allowed' };
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      return { ok: false, error: `quantifier "${ch}" has nothing to repeat` };
    }
    if (ch === '^' || ch === '$') {
      return { ok: false, error: 'anchors are only allowed at the start (^) and end ($)' };
    }
    if (ch === ']' || ch === '}') {
      return { ok: false, error: `unbalanced "${ch}"` };
    }
    if (ch === '[') {
      let j = i + 1;
      if (chars[j] === '^') j++;
      if (chars[j] === ']') j++; // literal ] as first class member
      let closed = false;
      for (; j < end; j++) {
        const c = chars[j]!;
        if (c === '\\') {
          const nx = chars[j + 1];
          if (nx === undefined) break;
          if (/[0-9]/.test(nx) && nx !== '0') return { ok: false, error: 'backreferences are not allowed' };
          j++;
          continue;
        }
        if (c === '[') return { ok: false, error: 'nested character classes are not allowed' };
        if (c === ']') {
          closed = true;
          break;
        }
      }
      if (!closed) return { ok: false, error: 'unterminated character class' };
      atomSrc = chars.slice(i, j + 1).join('');
      i = j + 1;
    } else if (ch === '\\') {
      const nx = chars[i + 1];
      if (nx === undefined || i + 1 >= end) return { ok: false, error: 'dangling escape' };
      if (/[1-9]/.test(nx) || nx === 'k') return { ok: false, error: 'backreferences are not allowed' };
      if (nx === 'b' || nx === 'B') return { ok: false, error: 'word-boundary assertions are not allowed' };
      if (nx === 'p' || nx === 'P') {
        if (chars[i + 2] !== '{') return { ok: false, error: `\\${nx} needs a {Property}` };
        const close = chars.indexOf('}', i + 3);
        if (close < 0 || close >= end) return { ok: false, error: 'unterminated \\p{…}' };
        atomSrc = chars.slice(i, close + 1).join('');
        i = close + 1;
      } else if (nx === 'u' || nx === 'x') {
        const m = /^\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/.exec(chars.slice(i, end).join(''));
        if (!m) return { ok: false, error: 'invalid \\u/\\x escape' };
        atomSrc = m[0];
        i += Array.from(m[0]).length;
      } else if (/[A-Za-z0-9]/.test(nx) && !ALLOWED_LETTER_ESCAPES.has(nx) && nx !== '0') {
        return { ok: false, error: `escape \\${nx} is not supported` };
      } else {
        atomSrc = /[A-Za-z0-9]/.test(nx) ? `\\${nx}` : escapeRegex(nx);
        i += 2;
      }
    } else if (ch === '.') {
      atomSrc = '.';
      i += 1;
    } else {
      atomSrc = escapeRegex(ch);
      i += 1;
    }

    let test: RegExp;
    try {
      test = new RegExp(`^${atomSrc}$`, 'u');
    } catch {
      return { ok: false, error: `invalid atom ${atomSrc}` };
    }

    // Optional quantifier.
    let min = 1;
    let max = 1;
    const q = i < end ? chars[i] : undefined;
    if (q === '*') {
      min = 0; max = Infinity; i++;
    } else if (q === '+') {
      min = 1; max = Infinity; i++;
    } else if (q === '?') {
      min = 0; max = 1; i++;
    } else if (q === '{') {
      const close = chars.indexOf('}', i);
      if (close < 0 || close >= end) return { ok: false, error: 'unterminated {n,m} quantifier' };
      const body = chars.slice(i + 1, close).join('');
      const m = /^(\d{1,3})(?:(,)(\d{1,3})?)?$/.exec(body);
      if (!m) return { ok: false, error: `invalid quantifier {${body}}` };
      min = Number(m[1]);
      max = m[2] ? (m[3] !== undefined ? Number(m[3]) : Infinity) : min;
      if (min > max) return { ok: false, error: `quantifier {${body}} has min > max` };
      if (min > SLUG_PATTERN_MAX_REPEAT || (max !== Infinity && max > SLUG_PATTERN_MAX_REPEAT)) {
        return { ok: false, error: `quantifier bounds must be ≤ ${SLUG_PATTERN_MAX_REPEAT}` };
      }
      i = close + 1;
    }
    if (q === '*' || q === '+' || q === '?' || q === '{') {
      if (i < end && chars[i] === '?') i++; // lazy modifier: irrelevant for full-match
      const after = i < end ? chars[i] : undefined;
      if (after === '*' || after === '+' || after === '?' || after === '{') {
        return { ok: false, error: 'stacked quantifiers are not allowed' };
      }
    }
    atoms.push({ test, min, max });
  }
  if (atoms.length === 0) return { ok: false, error: 'pattern matches nothing' };

  // Expand to NFA positions: `min` × one, then `star` or (max-min) × opt.
  const kinds: Kind[] = [];
  const tests: RegExp[] = [];
  for (const a of atoms) {
    for (let k = 0; k < a.min; k++) { kinds.push('one'); tests.push(a.test); }
    if (a.max === Infinity) { kinds.push('star'); tests.push(a.test); }
    else for (let k = a.min; k < a.max; k++) { kinds.push('opt'); tests.push(a.test); }
    if (kinds.length > SLUG_PATTERN_MAX_STATES) {
      return { ok: false, error: `pattern is too complex (more than ${SLUG_PATTERN_MAX_STATES} positions)` };
    }
  }
  const K = kinds.length;

  const closure = (set: Uint8Array) => {
    for (let p = 0; p < K; p++) {
      if (set[p] && kinds[p] !== 'one') set[p + 1] = 1;
    }
  };

  const test = (value: string): boolean => {
    let cur = new Uint8Array(K + 1);
    cur[0] = 1;
    closure(cur);
    for (const c of value) {
      const next = new Uint8Array(K + 1);
      let any = false;
      for (let p = 0; p < K; p++) {
        if (!cur[p] || !tests[p]!.test(c)) continue;
        if (kinds[p] === 'star') next[p] = 1;
        else next[p + 1] = 1;
        any = true;
      }
      if (!any) return false;
      closure(next);
      cur = next;
    }
    return cur[K] === 1;
  };

  return { ok: true, test, states: K };
}
