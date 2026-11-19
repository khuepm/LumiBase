import { TEMPLATE_LIMITS } from './limits';
import { templateError, type TemplateError } from './errors';

/**
 * Strict JSON ingestion for template documents (#901, BT01-W2).
 *
 * `JSON.parse` silently keeps the LAST of two duplicate keys, so a document
 * reviewed as `{"storageMode":"jsonb", …, "storageMode":"physical"}` would be
 * installed as `physical`. The authoring path parses the raw text itself and
 * refuses duplicates with their JSON path. It also enforces the byte and
 * nesting limits on the text before any object exists, so an oversized or
 * deeply nested document is refused without being materialised.
 *
 * Standard JSON only (RFC 8259): no comments, trailing commas, NaN or BOM.
 */

export type IngestResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: TemplateError[] };

class Fail extends Error {
  constructor(readonly error: TemplateError) {
    super(error.message);
  }
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

const pathOf = (segments: ReadonlyArray<string | number>): string =>
  segments.reduce<string>(
    (acc, seg) =>
      typeof seg === 'number' ? `${acc}[${seg}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg) ? `${acc}.${seg}` : `${acc}[${JSON.stringify(seg)}]`,
    '$',
  );

export { pathOf as jsonPath };

/** Parses `text` as a template document, refusing duplicates and limit breaches. */
export function ingestTemplateJson(text: string): IngestResult {
  const bytes = utf8ByteLength(text);
  if (bytes > TEMPLATE_LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      errors: [templateError('LIMIT_EXCEEDED', '$', `Document is ${bytes} bytes; the limit is ${TEMPLATE_LIMITS.maxDocumentBytes}.`)],
    };
  }
  let i = 0;
  const path: Array<string | number> = [];

  const fail = (message: string, code: TemplateError['code'] = 'INVALID_TEMPLATE'): never => {
    throw new Fail(templateError(code, pathOf(path), message));
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };
  const parseString = (): string => {
    // text[i] === '"'
    let out = '';
    i += 1;
    for (;;) {
      if (i >= text.length) fail(`Unterminated string at offset ${i}.`);
      const c = text[i]!;
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e !== undefined && e in map) {
          out += map[e];
          i += 2;
        } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          fail(`Invalid escape at offset ${i}.`);
        }
      } else if (c.charCodeAt(0) < 0x20) {
        fail(`Control character in string at offset ${i}.`);
      } else {
        out += c;
        i += 1;
      }
    }
  };
  const parseNumber = (): number => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail(`Invalid number at offset ${i}.`);
    i += m![0].length;
    const n = Number(m![0]);
    if (!Number.isFinite(n)) fail(`Number out of range at offset ${i}.`);
    return n;
  };
  const parseValue = (depth: number): unknown => {
    ws();
    const c = text[i];
    // `depth` containers enclose this value; opening one more must stay within the limit.
    if ((c === '{' || c === '[') && depth + 1 > TEMPLATE_LIMITS.maxDepth) {
      fail(`Nesting deeper than ${TEMPLATE_LIMITS.maxDepth} levels.`, 'LIMIT_EXCEEDED');
    }
    if (c === '{') {
      i += 1;
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i += 1;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(`Expected a property name at offset ${i}.`);
        const key = parseString();
        path.push(key);
        if (seen.has(key)) fail(`Duplicate key "${key}".`);
        seen.add(key);
        ws();
        if (text[i] !== ':') fail(`Expected ":" at offset ${i}.`);
        i += 1;
        const value = parseValue(depth + 1);
        // `__proto__` must stay data, never become the prototype.
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
        path.pop();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return obj;
        }
        fail(`Expected "," or "}" at offset ${i}.`);
      }
    }
    if (c === '[') {
      i += 1;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return arr;
      }
      for (;;) {
        path.push(arr.length);
        arr.push(parseValue(depth + 1));
        path.pop();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return arr;
        }
        fail(`Expected "," or "]" at offset ${i}.`);
      }
    }
    if (c === '"') return parseString();
    if (c === 't' && text.startsWith('true', i)) { i += 4; return true; }
    if (c === 'f' && text.startsWith('false', i)) { i += 5; return false; }
    if (c === 'n' && text.startsWith('null', i)) { i += 4; return null; }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return parseNumber();
    return fail(c === undefined ? 'Unexpected end of document.' : `Unexpected "${c}" at offset ${i}.`);
  };

  try {
    // Depth counts containers: the top-level object is depth 1.
    const value = parseValue(0);
    ws();
    if (i !== text.length) fail(`Unexpected content after the document at offset ${i}.`);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof Fail) return { ok: false, errors: [err.error] };
    throw err;
  }
}

/** Container nesting depth of an already-parsed value (top-level object = 1). */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((max, v) => Math.max(max, jsonDepth(v)), 0);
  if (value !== null && typeof value === 'object') {
    return 1 + Object.values(value as Record<string, unknown>).reduce<number>((max, v) => Math.max(max, jsonDepth(v)), 0);
  }
  return 0;
}
