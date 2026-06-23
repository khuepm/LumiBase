// Machine-translation adapters. Pluggable: DeepL (default) and Google Cloud
// Translation v2. Both translate a *masked* markdown body where language-neutral
// segments have already been replaced with placeholders (see markdown-protect.mjs).
//
// A missing API key is a soft condition: callers detect `engineAvailable()` and
// fall back to a detect-only run instead of failing the whole pipeline.

import { getEngineConfig, DEEPL_LANG, GOOGLE_LANG } from './config.mjs';

/** Is the configured engine usable (key present)? */
export function engineAvailable(env = process.env) {
  const cfg = getEngineConfig(env);
  if (cfg.engine === 'deepl') return Boolean(cfg.deepl.apiKey);
  if (cfg.engine === 'google') return Boolean(cfg.google.apiKey);
  return false;
}

/** Human-readable description of the active engine (no secrets). */
export function engineLabel(env = process.env) {
  const cfg = getEngineConfig(env);
  return cfg.engine;
}

async function translateDeepL(text, sourceLocale, targetLocale, cfg) {
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('source_lang', DEEPL_LANG[sourceLocale].split('-')[0]);
  params.append('target_lang', DEEPL_LANG[targetLocale]);
  // Keep markdown structure intact; DeepL must not reflow our placeholders.
  params.append('preserve_formatting', '1');
  params.append('split_sentences', 'nonewlines');

  const res = await fetch(`https://${cfg.deepl.host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${cfg.deepl.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) {
    throw new Error(`DeepL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.translations.map((t) => t.text).join('');
}

async function translateGoogle(text, sourceLocale, targetLocale, cfg) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(
    cfg.google.apiKey,
  )}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: GOOGLE_LANG[sourceLocale],
      target: GOOGLE_LANG[targetLocale],
      format: 'text',
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data.translations.map((t) => t.translatedText).join('');
}

/**
 * Translate a (masked) markdown body from one locale to another.
 * @param {string} text masked body
 * @param {'en'|'vi'} sourceLocale
 * @param {'en'|'vi'} targetLocale
 * @param {object} [env]
 * @returns {Promise<string>}
 */
export async function translateText(text, sourceLocale, targetLocale, env = process.env) {
  if (!text.trim()) return text;
  const cfg = getEngineConfig(env);
  if (cfg.engine === 'deepl') {
    if (!cfg.deepl.apiKey) throw new Error('DEEPL_API_KEY is not set');
    return translateDeepL(text, sourceLocale, targetLocale, cfg);
  }
  if (cfg.engine === 'google') {
    if (!cfg.google.apiKey) throw new Error('GOOGLE_TRANSLATE_API_KEY is not set');
    return translateGoogle(text, sourceLocale, targetLocale, cfg);
  }
  throw new Error(`Unknown DOCS_MT_ENGINE: ${cfg.engine}`);
}
