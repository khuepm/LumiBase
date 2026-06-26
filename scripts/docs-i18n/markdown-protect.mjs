// Protect language-neutral markdown segments (code, link targets, images, html,
// inline code) before sending prose to a machine-translation engine, then restore
// them afterwards. Placeholders use Unicode Private Use Area markers that MT
// engines pass through far more reliably than plain ASCII tokens.

// Form: <OPEN><numeric id><CLOSE>, e.g. "0".
const OPEN = '\uE000LBP\uE001';
const CLOSE = '\uE002';

/** Patterns are tried in order; earlier matches win to avoid nested double-capture. */
const PATTERNS = [
  { name: 'fenced', re: /```[\s\S]*?```|~~~[\s\S]*?~~~/g },
  { name: 'inlineCode', re: /`[^`\n]+`/g },
  { name: 'image', re: /!\[[^\]]*\]\([^)]*\)/g },
  { name: 'linkTarget', re: /\]\(([^)]*)\)/g }, // keep link text, hide the URL
  { name: 'autolink', re: /<https?:\/\/[^>]+>/g },
  { name: 'html', re: /<[^>]+>/g },
];

/**
 * @param {string} text raw markdown body (front matter already removed)
 * @returns {{ masked: string, tokens: string[] }}
 */
export function protectMarkdown(text) {
  const tokens = [];
  let masked = text;

  const mask = (re, getValue) => {
    masked = masked.replace(re, (...args) => {
      const value = getValue(...args);
      const id = tokens.length;
      tokens.push(value);
      return OPEN + id + CLOSE;
    });
  };

  for (const { name, re } of PATTERNS) {
    if (name === 'linkTarget') {
      mask(re, (_full, url) => `](${url})`);
    } else {
      mask(re, (full) => full);
    }
  }

  return { masked, tokens };
}

/**
 * Restore protected segments. If any placeholder is missing from the translated
 * text it is reported so callers can fall back to the untranslated source.
 * @returns {{ text: string, missing: number[] }}
 */
export function restoreMarkdown(masked, tokens) {
  const missing = [];
  let out = masked;
  for (let id = 0; id < tokens.length; id += 1) {
    const token = OPEN + id + CLOSE;
    if (!out.includes(token)) {
      missing.push(id);
      continue;
    }
    out = out.split(token).join(tokens[id]);
  }
  return { text: out, missing };
}

export const PLACEHOLDER_MARKERS = { OPEN, CLOSE };
