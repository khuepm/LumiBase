// Configuration for the docs i18n sync tooling.
// Central place for paths, locales and machine-translation engine settings.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (scripts/docs-i18n -> repo root). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Root folder that holds the per-locale docs trees. Override with DOCS_ROOT env. */
export const DOCS_ROOT = process.env.DOCS_ROOT
  ? path.resolve(process.env.DOCS_ROOT)
  : path.join(REPO_ROOT, 'docs');

/** Supported locales. `defaultLocale` is the canonical published language. */
export const LOCALES = ['en', 'vi'];
export const DEFAULT_LOCALE = 'en';

/** The "other" locale for a given one (only valid for a 2-locale setup). */
export function otherLocale(locale) {
  return locale === 'en' ? 'vi' : 'en';
}

/** Folders inside docs/<locale> that should never be treated as doc pages. */
export const IGNORED_DIRS = new Set(['node_modules', 'dist', '.i18n']);

/** Files (relative to docs/<locale>) that are managed manually, never auto-synced. */
export const IGNORED_FILES = new Set([
  // sync log lives outside the locale trees, listed for safety
  'i18n-sync-log.md',
]);

/** Where the append-only sync log is written (relative to DOCS_ROOT). */
export const SYNC_LOG_PATH = path.join(DOCS_ROOT, 'i18n-sync-log.md');

/** Where the machine-readable sync report is written (relative to DOCS_ROOT). */
export const SYNC_REPORT_PATH = path.join(DOCS_ROOT, '.i18n', 'last-report.json');

/**
 * Machine-translation engine configuration.
 * Engine + credentials are read from the environment so no secret lives in the repo.
 *
 *   DOCS_MT_ENGINE   = 'deepl' | 'google'   (default: 'deepl')
 *   DEEPL_API_KEY    = <key>                (DeepL)
 *   DEEPL_API_HOST   = api-free.deepl.com | api.deepl.com (default: api-free.deepl.com)
 *   GOOGLE_TRANSLATE_API_KEY = <key>        (Google Cloud Translation v2)
 */
export function getEngineConfig(env = process.env) {
  const engine = (env.DOCS_MT_ENGINE || 'deepl').toLowerCase();
  return {
    engine,
    deepl: {
      apiKey: env.DEEPL_API_KEY || '',
      host: env.DEEPL_API_HOST || 'api-free.deepl.com',
    },
    google: {
      apiKey: env.GOOGLE_TRANSLATE_API_KEY || '',
    },
  };
}

/** DeepL language codes per locale. */
export const DEEPL_LANG = { en: 'EN-US', vi: 'VI' };
/** Google language codes per locale. */
export const GOOGLE_LANG = { en: 'en', vi: 'vi' };
