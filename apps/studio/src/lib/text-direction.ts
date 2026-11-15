/**
 * Text direction for UI and content locales (#761, RTL layout support).
 *
 * Two directions are resolved independently:
 *
 *  - the **UI direction** follows the active Studio language and is written to
 *    `<html dir>` (see `applyDocumentLanguage`), so the whole shell mirrors;
 *  - the **content direction** follows the locale of the value being edited
 *    (`contentDirProps`), so an Arabic field in an English UI is still typed
 *    right-to-left, and an English field in an Arabic UI stays left-to-right.
 *
 * Resolution is a fixed table rather than `Intl.Locale#getTextInfo()`, which
 * is missing from Firefox and older WebKit (the Tauri shell on macOS/Linux):
 * the same tag must give the same direction in every runtime. Matching order:
 * an explicit script subtag wins (`az-Arab` is RTL, `ks-Deva` is LTR), then
 * the base language (`ar-EG` → `ar`). Anything unknown is LTR.
 */

export type TextDirection = 'ltr' | 'rtl';

/** Languages written right-to-left in their default script. */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar', // Arabic
  'arc', // Aramaic
  'ckb', // Central Kurdish (Sorani)
  'dv', // Dhivehi
  'fa', // Persian / Farsi
  'he', // Hebrew
  'iw', // Hebrew (legacy tag)
  'ks', // Kashmiri
  'mzn', // Mazanderani
  'pnb', // Western Punjabi (Shahmukhi)
  'ps', // Pashto
  'sd', // Sindhi
  'syr', // Syriac
  'ug', // Uyghur
  'ur', // Urdu
  'yi', // Yiddish
]);

/** ISO 15924 scripts written right-to-left. */
export const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  'adlm',
  'arab',
  'hebr',
  'mand',
  'nkoo',
  'rohg',
  'samr',
  'syrc',
  'thaa',
]);

/** Parse `ar`, `ar-EG`, `az_Arab_IR`, `AR` into lower-cased subtags. */
function subtags(tag: string): string[] {
  return tag.trim().toLowerCase().split(/[-_]/).filter(Boolean);
}

/** Direction a BCP 47 tag is written in. Non-strings and unknown tags → `ltr`. */
export function directionOf(tag: unknown): TextDirection {
  if (typeof tag !== 'string') return 'ltr';
  const [language, ...rest] = subtags(tag);
  if (!language) return 'ltr';
  // The script subtag is the first 4-letter subtag after the language.
  const script = rest.find((part) => /^[a-z]{4}$/.test(part));
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

export function isRtl(tag: unknown): boolean {
  return directionOf(tag) === 'rtl';
}

/**
 * Write the active UI language to the document root: `lang` for screen
 * readers / hyphenation / font selection, `dir` so the layout mirrors.
 * Safe to call with no DOM (tests, SSR) — it is then a no-op.
 */
export function applyDocumentLanguage(lang: string, root?: HTMLElement | null): TextDirection {
  const dir = directionOf(lang);
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (el) {
    if (el.getAttribute('lang') !== lang) el.setAttribute('lang', lang);
    if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
  }
  return dir;
}

/**
 * Attributes for an input/textarea that edits content in a specific locale.
 *
 * With a known locale the field gets that locale's `dir` and `lang` (an Arabic
 * translation stays RTL inside an English UI). Without one — a plain text
 * field whose language is not declared — `dir="auto"` lets the browser pick
 * the direction from the first strong character the editor types.
 */
export function contentDirProps(locale?: string | null): { dir: TextDirection | 'auto'; lang?: string } {
  if (typeof locale === 'string' && locale.trim() !== '') {
    return { dir: directionOf(locale), lang: locale.trim() };
  }
  return { dir: 'auto' };
}
