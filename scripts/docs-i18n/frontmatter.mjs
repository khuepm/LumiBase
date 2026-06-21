// Minimal, dependency-free YAML front-matter handling for docs.
//
// We only need to read/upsert a handful of *scalar* keys (version, lastUpdated,
// sourceLang, sourceHash, translatedFrom, mtEngine, syncStatus). Rather than fully
// parse YAML, we preserve the original front-matter block verbatim and only
// replace or append the specific managed lines. Unknown keys (e.g. `title`) are
// left untouched.

import crypto from 'node:crypto';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a markdown file into its front matter (raw text, no fences) and body.
 * @returns {{ fmRaw: string|null, body: string }}
 */
export function splitFrontMatter(raw) {
  const m = raw.match(FM_RE);
  if (!m) return { fmRaw: null, body: raw };
  return { fmRaw: m[1], body: raw.slice(m[0].length) };
}

/** Read a single scalar key from a raw front-matter block (or null). */
export function readKey(fmRaw, key) {
  if (!fmRaw) return null;
  const re = new RegExp(`^${escapeRe(key)}:\\s*(.*)$`, 'm');
  const m = fmRaw.match(re);
  if (!m) return null;
  return unquote(m[1].trim());
}

/**
 * Upsert scalar keys into a raw front-matter block, preserving order of existing
 * keys and appending new ones at the end.
 * @param {string|null} fmRaw existing block (without fences) or null
 * @param {Record<string, string|number>} updates
 * @returns {string} new raw block (without fences)
 */
export function upsertKeys(fmRaw, updates) {
  let lines = fmRaw != null ? fmRaw.split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    const serialized = `${key}: ${quoteIfNeeded(String(value))}`;
    const idx = lines.findIndex((l) => new RegExp(`^${escapeRe(key)}:\\s*`).test(l));
    if (idx >= 0) lines[idx] = serialized;
    else lines.push(serialized);
  }
  // drop accidental empty trailing lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/** Reassemble a markdown file from a raw front-matter block and a body. */
export function buildFile(fmRaw, body) {
  const fence = `---\n${fmRaw}\n---\n`;
  // Ensure exactly one blank line between front matter and body when body has content.
  const trimmedBody = body.replace(/^\r?\n+/, '');
  return `${fence}\n${trimmedBody}`;
}

/** SHA-256 of content, used to detect when a source doc changed since last sync. */
export function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function quoteIfNeeded(v) {
  // Quote values containing YAML-significant characters.
  if (/^[\w.\-/+:T Z]+$/.test(v) && !/^[\s]|[\s]$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}
