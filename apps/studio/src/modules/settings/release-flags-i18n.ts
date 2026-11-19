import type { i18n as I18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import enBundle from '@/locales/en/release-flags.json';
import viBundle from '@/locales/vi/release-flags.json';

/**
 * Strings of Settings → Release flags (#895), bundled for every shipped
 * locale under the `releaseFlags` namespace (`locales/{en,vi}/release-flags.json`).
 * Without an initialised i18next instance (component tests) the English
 * bundle is used, so the page never renders raw keys.
 */

export const RELEASE_FLAGS_NS = 'releaseFlags';

const BUNDLES = { en: enBundle, vi: viBundle } as const;

/** Adds the bundled namespace for every shipped locale. Idempotent. */
export function registerReleaseFlagBundles(i18n: I18n): void {
  for (const [lang, bundle] of Object.entries(BUNDLES)) {
    if (!i18n.hasResourceBundle(lang, RELEASE_FLAGS_NS)) {
      i18n.addResourceBundle(lang, RELEASE_FLAGS_NS, bundle, true, false);
    }
  }
}

type Vars = Record<string, string | number>;

function lookup(path: string): string | undefined {
  let node: unknown = enBundle;
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

export type ReleaseFlagsT = (key: string, vars?: Vars) => string;

export function useReleaseFlagsT(): ReleaseFlagsT {
  const { t, i18n } = useTranslation(RELEASE_FLAGS_NS);
  return useCallback(
    (key: string, vars?: Vars) => {
      if (i18n?.isInitialized && i18n.exists(key, { ns: RELEASE_FLAGS_NS })) {
        return t(key, { ...vars, ns: RELEASE_FLAGS_NS }) as string;
      }
      return interpolate(lookup(key) ?? key, vars);
    },
    [t, i18n],
  );
}
