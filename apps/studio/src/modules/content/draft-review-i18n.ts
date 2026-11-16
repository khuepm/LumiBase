import { useCallback } from 'react';
import type { i18n as I18n } from 'i18next';
import { useTranslation } from 'react-i18next';
import enContent from '@/locales/en/content.json';
import viContent from '@/locales/vi/content.json';

/**
 * Copy for the content module's draft review panel (Jev J08, #515).
 *
 * The Studio's `ui` namespace is fetched from the CMS, so a fresh instance
 * has no translations until an admin enters them. The draft review copy ships
 * with the bundle instead, as the `content` namespace in
 * `locales/{en,vi}/content.json`, registered by `initI18n`
 * (`registerContentBundles`). When no i18next instance is ready (component
 * tests that do not initialise one), the English bundle is used directly, so
 * the panel never renders raw keys.
 */

export const CONTENT_NS = 'content';

const BUNDLES = { en: enContent, vi: viContent } as const;

/** Adds the bundled `content` namespace for every shipped locale. Idempotent. */
export function registerContentBundles(i18n: I18n): void {
  for (const [lang, bundle] of Object.entries(BUNDLES)) {
    if (!i18n.hasResourceBundle(lang, CONTENT_NS)) i18n.addResourceBundle(lang, CONTENT_NS, bundle, true, false);
  }
}

type Vars = Record<string, string | number>;

function lookup(path: string): string | undefined {
  let node: unknown = enContent.draftReview;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars: Vars = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

export type DraftReviewT = (key: string, vars?: Vars) => string;

/** `t('states.stale')` → the `content:draftReview.states.stale` string in the active language. */
export function useDraftReviewT(): DraftReviewT {
  const { t, i18n } = useTranslation(CONTENT_NS);
  return useCallback(
    (key: string, vars?: Vars) => {
      const full = `draftReview.${key}`;
      if (i18n?.isInitialized && i18n.exists(full, { ns: CONTENT_NS })) {
        return t(full, { ...vars, ns: CONTENT_NS }) as string;
      }
      return interpolate(lookup(key) ?? key, vars);
    },
    [t, i18n],
  );
}
