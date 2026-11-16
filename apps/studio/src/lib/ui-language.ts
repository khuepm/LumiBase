/**
 * Studio UI language (backlog B112, RTL #761).
 *
 * The Studio ships translated copy for a fixed set of languages (today the
 * draft review panel's `content` namespace, `locales/{en,vi}`); the `ui`
 * namespace is managed in the CMS (Settings → Translations) and can hold any
 * language. The language is chosen explicitly, never guessed from the
 * browser, because most of the Studio is not translated yet:
 *
 *   1. the signed-in user's preference (`users.preferences.language`,
 *      `GET /api/v1/me/preferences`), then
 *   2. the site's default language (Settings → Site, `site.defaultLanguage`), then
 *   3. English.
 *
 * Tags match on their base language, so `vi-VN` selects `vi`. A tag the
 * Studio does not support falls through to the next source.
 *
 * `ar`, `he` and `fa` are supported for **layout** (#761): selecting one sets
 * `<html dir="rtl">` and mirrors the shell. They ship no bundled copy, so any
 * string without a CMS-managed translation falls back to English.
 */
export const UI_LANGUAGES = ['en', 'vi', 'ar', 'he', 'fa'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Languages with a bundled translation of the Studio's own copy. */
export const BUNDLED_UI_LANGUAGES: readonly UiLanguage[] = ['en', 'vi'];

/** `vi-VN` → `vi`; an unsupported or empty tag → `null`. */
export function supportedUiLanguage(tag: unknown): UiLanguage | null {
  if (typeof tag !== 'string') return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  // `iw` is the pre-1989 code for Hebrew; some OS locale pickers still emit it.
  const normalized = base === 'iw' ? 'he' : base;
  return (UI_LANGUAGES as readonly string[]).includes(normalized ?? '') ? (normalized as UiLanguage) : null;
}

export function resolveUiLanguage(sources: { preference?: unknown; siteDefault?: unknown }): UiLanguage {
  return supportedUiLanguage(sources.preference) ?? supportedUiLanguage(sources.siteDefault) ?? 'en';
}

/**
 * localStorage key remembering the last resolved UI language, so the pages
 * shown before a session exists (login, recovery) and the first paint after a
 * reload already have the right language and direction instead of flashing
 * LTR English. A cache only: the signed-in sources above always win.
 */
export const UI_LANGUAGE_STORAGE_KEY = 'lumibase.ui-language';

export function readStoredUiLanguage(storage: Pick<Storage, 'getItem'> | null | undefined = safeStorage()): UiLanguage | null {
  try {
    return supportedUiLanguage(storage?.getItem(UI_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeUiLanguage(lang: UiLanguage, storage: Pick<Storage, 'setItem'> | null | undefined = safeStorage()): void {
  try {
    storage?.setItem(UI_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Private mode / quota: the remembered language is a convenience only.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
