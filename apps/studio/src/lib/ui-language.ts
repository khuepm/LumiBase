/**
 * Studio UI language (backlog B112).
 *
 * The Studio ships translated copy for a fixed set of languages (today the
 * draft review panel's `content` namespace, `locales/{en,vi}`). The language
 * is chosen explicitly, never guessed from the browser, because most of the
 * Studio is not translated yet:
 *
 *   1. the signed-in user's preference (`users.preferences.language`,
 *      `GET /api/v1/me/preferences`), then
 *   2. the site's default language (Settings → Site, `site.defaultLanguage`), then
 *   3. English.
 *
 * Tags match on their base language, so `vi-VN` selects `vi`. A tag the
 * Studio does not ship falls through to the next source.
 */
export const UI_LANGUAGES = ['en', 'vi'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** `vi-VN` → `vi`; an unsupported or empty tag → `null`. */
export function supportedUiLanguage(tag: unknown): UiLanguage | null {
  if (typeof tag !== 'string') return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (UI_LANGUAGES as readonly string[]).includes(base ?? '') ? (base as UiLanguage) : null;
}

export function resolveUiLanguage(sources: { preference?: unknown; siteDefault?: unknown }): UiLanguage {
  return supportedUiLanguage(sources.preference) ?? supportedUiLanguage(sources.siteDefault) ?? 'en';
}
