// Translation engine: Claude (Anthropic Messages API).
//
// No third-party machine-translation services. The engine receives a *masked*
// markdown body where language-neutral segments (code, links, inline code, html)
// have already been replaced with placeholders (see markdown-protect.mjs), and
// must return the same markdown with only the prose translated and every
// placeholder left byte-for-byte intact.
//
// A missing API key is a soft condition: callers check `engineAvailable()` and
// fall back to a detect-only / preserve-only run instead of failing.

import { getEngineConfig, LOCALE_NAMES } from './config.mjs';

const ANTHROPIC_VERSION = '2023-06-01';

/** Is the engine usable (API key present)? */
export function engineAvailable(env = process.env) {
  return Boolean(getEngineConfig(env).apiKey);
}

/** Human-readable engine label stored in front matter (no secrets). */
export function engineLabel() {
  return 'claude';
}

function buildSystemPrompt(sourceLocale, targetLocale) {
  const from = LOCALE_NAMES[sourceLocale];
  const to = LOCALE_NAMES[targetLocale];
  return [
    `You are a professional technical-documentation translator for a software project.`,
    `Translate the user's Markdown from ${from} to ${to}.`,
    `Rules:`,
    `- Output ONLY the translated Markdown. No preamble, no explanation, no surrounding code fences.`,
    `- Preserve all Markdown structure exactly: headings, lists, tables, blockquotes, emphasis.`,
    `- Translate prose only. Do NOT translate code, identifiers, file paths, URLs, CLI commands, or environment variable names.`,
    `- Some segments are replaced by placeholder tokens of the form LBP<number>. Keep every placeholder exactly as-is, in the same position. Never translate, reorder, add, or remove them.`,
    `- Keep technical terms that are conventionally left in English (e.g. "headless CMS", "Edge", "runtime") untranslated when that is the norm for ${to} technical writing.`,
    `- Do not add or drop trailing whitespace or blank lines.`,
  ].join('\n');
}

/**
 * Translate a (masked) markdown body from one locale to another using Claude.
 * @param {string} text masked body
 * @param {'en'|'vi'} sourceLocale
 * @param {'en'|'vi'} targetLocale
 * @param {object} [env]
 * @returns {Promise<string>}
 */
export async function translateText(text, sourceLocale, targetLocale, env = process.env) {
  if (!text.trim()) return text;
  const cfg = getEngineConfig(env);
  if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: 0,
      system: buildSystemPrompt(sourceLocale, targetLocale),
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.stop_reason === 'max_tokens') {
    throw new Error(
      'Translation truncated (max_tokens). Increase ANTHROPIC_MAX_TOKENS or split the document.',
    );
  }
  const out = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!out) throw new Error('Anthropic API returned no text content');
  return out;
}
