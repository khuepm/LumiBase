#!/usr/bin/env node
// Check that an EN/VI pair is structurally the same document.
//
// WHY THIS EXISTS
// ---------------
// The other two checkers answer different questions. `sync.mjs` compares hashes
// ("same source revision?"). `verify-code-refs.mjs` compares the doc's claims to
// the source tree ("is what it says true?"). Neither can tell you the translation
// is *the same document*: a hand-written target can silently drop three sections,
// truncate mid-table, translate an env-var name, or — the most common failure —
// be committed still in the source language.
//
// This script is the reviewer that a hand-translation workflow otherwise needs.
// Translations here are written by an LLM in the editor and land without a second
// pair of eyes (docs/.i18n/TASKS.md §6), so the gate has to be mechanical:
//
//   1. language      — the target side must actually read as the target language
//   2. headings      — same count, same level sequence (text differs, shape does not)
//   3. code fences   — same count, and each body byte-identical: code is never translated
//   4. inline code   — same multiset of spans (`siteId`, `LUMIBASE_X`, paths…)
//   5. link targets  — same multiset of URLs/paths (link text differs, destinations do not)
//   6. tables        — same table count and same row count per table
//   7. front matter  — target carries the provenance keys the tooling relies on
//   8. bulk          — body length within a sane band, to catch a dropped tail
//
// It is deliberately blind to prose quality. It cannot tell you a translation
// reads well; it can tell you it is not the same document, which is the class of
// error nobody notices until a reader hits it.
//
// Usage:
//   node scripts/docs-i18n/check-parity.mjs                 # every pair
//   node scripts/docs-i18n/check-parity.mjs features/x.md   # one rel
//   node scripts/docs-i18n/check-parity.mjs --json          # machine-readable
//
// Exit code: 0 = no problems, 1 = problems found, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { LOCALES, DOCS_ROOT } from './config.mjs';
import { splitFrontMatter, readKey } from './frontmatter.mjs';
import { detectLang } from './lang-detect.mjs';

const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const RELS = ARGS.filter((a) => !a.startsWith('--'));

/**
 * Body-length ratio tolerated between the two sides. Vietnamese technical prose
 * runs longer than English (compound terms spelled out, more function words), so
 * the band is asymmetric-friendly and wide: this is a truncation tripwire, not a
 * style rule. A target at 45% of its source has lost content, not been concise.
 */
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.9;

/**
 * Fence languages whose bodies are code and must be identical on both sides.
 * Anything else — `text`, `tree`, `mermaid`, an untagged block — holds prose or a
 * diagram whose labels are supposed to be translated, so only its presence is
 * checked, not its content.
 */
const CODE_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'console',
  'ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'dotenv',
  'sql', 'graphql', 'gql', 'http', 'html', 'css', 'diff', 'dockerfile', 'docker',
  'python', 'py', 'go', 'rust', 'rs', 'java', 'kotlin', 'swift', 'php', 'ruby',
]);

/** A doc can waive a specific check when the divergence is deliberate. */
const WAIVER = /<!--\s*check-parity:\s*allow\s+([^>]+?)\s*-->/g;

function readWaivers(raw) {
  const out = new Set();
  WAIVER.lastIndex = 0;
  let m;
  while ((m = WAIVER.exec(raw)) !== null) {
    for (const token of m[1].split(/\s+/)) if (token) out.add(token);
  }
  return out;
}

/** Fenced code blocks: returns [{ lang, body }] in document order. */
function codeFences(body) {
  const out = [];
  const re = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({ lang: m[3].trim(), body: m[4] });
  }
  return out;
}

/** Body with fenced blocks removed, so fence content never feeds prose checks. */
function withoutFences(body) {
  return body.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$/gm, '');
}

function headings(body) {
  return withoutFences(body)
    .split('\n')
    .map((l) => /^(#{1,6})\s+\S/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].length);
}

function inlineCode(body) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(withoutFences(body))) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Link destinations, split by kind.
 *
 * In-page anchors (`#deployment-steps`) are generated from heading text, so a
 * correctly translated doc *must* have different ones — comparing their values
 * would flag every good translation. Their count still has to match: a missing
 * anchor link means a missing cross-reference. Everything else (relative paths,
 * URLs) must match exactly; a translated file path is a broken link.
 */
function linkTargets(body) {
  const files = [];
  let anchors = 0;
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(withoutFences(body))) !== null) {
    if (m[1].startsWith('#')) anchors += 1;
    else files.push(m[1]);
  }
  return { files, anchors };
}

/** Row counts of each pipe table, in document order. */
function tableShapes(body) {
  const shapes = [];
  let rows = 0;
  for (const line of withoutFences(body).split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      rows += 1;
    } else if (rows > 0) {
      shapes.push(rows);
      rows = 0;
    }
  }
  if (rows > 0) shapes.push(rows);
  return shapes;
}

/** Multiset difference, reported both ways, capped so output stays readable. */
function multisetDiff(a, b) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const missing = [];
  const extra = [];
  for (const [k, n] of ca) {
    const d = n - (cb.get(k) ?? 0);
    if (d > 0) missing.push(d > 1 ? `${k} (×${d})` : k);
  }
  for (const [k, n] of cb) {
    const d = n - (ca.get(k) ?? 0);
    if (d > 0) extra.push(d > 1 ? `${k} (×${d})` : k);
  }
  return { missing, extra };
}

function sample(list, n = 5) {
  return list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} … +${list.length - n} more`;
}

/**
 * Compare one rel across both locales.
 * @returns {{rel: string, skipped?: string, sourceLocale?: string, problems: Array<{check: string, detail: string}>}}
 */
export function checkPair(rel) {
  const abs = Object.fromEntries(LOCALES.map((l) => [l, path.join(DOCS_ROOT, l, rel)]));
  for (const l of LOCALES) {
    if (!fs.existsSync(abs[l])) {
      return { rel, skipped: `no docs/${l}/${rel} yet — nothing to compare`, problems: [] };
    }
  }

  const raw = Object.fromEntries(LOCALES.map((l) => [l, fs.readFileSync(abs[l], 'utf8')]));
  const parts = Object.fromEntries(LOCALES.map((l) => [l, splitFrontMatter(raw[l])]));
  const waived = new Set([...readWaivers(raw.en), ...readWaivers(raw.vi)]);

  // Authoring direction decides which side must carry provenance. `sourceLang`
  // is per-file and can be vi, so this is read, never assumed.
  const enFrom = readKey(parts.en.fmRaw, 'translatedFrom');
  const sourceLocale = enFrom === 'vi' ? 'vi' : 'en';
  const targetLocale = sourceLocale === 'en' ? 'vi' : 'en';

  const problems = [];
  const add = (check, detail) => {
    if (!waived.has(check)) problems.push({ check, detail });
  };

  // 1. language — the single most common failure is a target still in the source
  //    language, which every hash-based check reads as perfectly fine.
  const det = detectLang(parts[targetLocale].body);
  if (det && det.lang && det.lang !== targetLocale) {
    add(
      'language',
      `docs/${targetLocale}/${rel} reads as "${det.lang}", not "${targetLocale}" — untranslated or copied from the source side`,
    );
  }

  // 2. headings
  const hs = Object.fromEntries(LOCALES.map((l) => [l, headings(parts[l].body)]));
  if (hs.en.length !== hs.vi.length) {
    add('headings', `en has ${hs.en.length} headings, vi has ${hs.vi.length}`);
  } else if (hs.en.join(',') !== hs.vi.join(',')) {
    add('headings', `same count (${hs.en.length}) but different level sequence`);
  }

  // 3. code fences — count always, content only for blocks that hold real code.
  const fences = Object.fromEntries(LOCALES.map((l) => [l, codeFences(parts[l].body)]));
  if (fences.en.length !== fences.vi.length) {
    add('code-fences', `en has ${fences.en.length} fenced blocks, vi has ${fences.vi.length}`);
  } else {
    // Comments inside a fence are prose and are meant to be translated, so they
    // are stripped before comparing. Prose-shaped fences (diagrams, trees,
    // sample output, untagged blocks) are compared by count only — translating
    // an ASCII architecture diagram's labels is correct, not drift.
    const stripComments = (s) =>
      s
        .split('\n')
        .filter((l) => !/^\s*(#|\/\/|--)/.test(l))
        .join('\n')
        .trim();
    const real = [];
    for (let i = 0; i < fences.en.length; i += 1) {
      if (!CODE_LANGS.has(fences.en[i].lang.toLowerCase())) continue;
      if (stripComments(fences.en[i].body) !== stripComments(fences.vi[i].body)) {
        real.push(`#${i + 1} (${fences.en[i].lang})`);
      }
    }
    if (real.length) {
      add('code-fences', `code differs (ignoring comment lines) in block(s) ${real.join(', ')}`);
    }
  }

  // 4. inline code
  const ic = multisetDiff(inlineCode(parts.en.body), inlineCode(parts.vi.body));
  if (ic.missing.length || ic.extra.length) {
    const bits = [];
    if (ic.missing.length) bits.push(`missing in vi: ${sample(ic.missing)}`);
    if (ic.extra.length) bits.push(`only in vi: ${sample(ic.extra)}`);
    add('inline-code', bits.join(' · '));
  }

  // 5. link targets
  const lEn = linkTargets(parts.en.body);
  const lVi = linkTargets(parts.vi.body);
  const lt = multisetDiff(lEn.files, lVi.files);
  if (lt.missing.length || lt.extra.length) {
    const bits = [];
    if (lt.missing.length) bits.push(`missing in vi: ${sample(lt.missing)}`);
    if (lt.extra.length) bits.push(`only in vi: ${sample(lt.extra)}`);
    add('links', bits.join(' · '));
  }
  if (lEn.anchors !== lVi.anchors) {
    add('links', `en has ${lEn.anchors} in-page anchor link(s), vi has ${lVi.anchors}`);
  }

  // 6. tables
  const ts = Object.fromEntries(LOCALES.map((l) => [l, tableShapes(parts[l].body)]));
  if (ts.en.join(',') !== ts.vi.join(',')) {
    add('tables', `row counts en=[${ts.en.join(',')}] vi=[${ts.vi.join(',')}]`);
  }

  // 7. front matter on the translated side
  for (const key of ['translatedFrom', 'sourceHash']) {
    if (!readKey(parts[targetLocale].fmRaw, key)) {
      add('front-matter', `docs/${targetLocale}/${rel} has no \`${key}\` — run stamp-pair.mjs`);
    }
  }

  // 8. bulk
  const lenSrc = parts[sourceLocale].body.trim().length;
  const lenTgt = parts[targetLocale].body.trim().length;
  if (lenSrc > 400) {
    const ratio = lenTgt / lenSrc;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      add(
        'bulk',
        `target/source length ratio ${ratio.toFixed(2)} outside [${MIN_RATIO}, ${MAX_RATIO}] ` +
          `(${lenTgt} vs ${lenSrc} chars) — likely dropped or duplicated content`,
      );
    }
  }

  return { rel, sourceLocale, problems };
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '.i18n' || entry.name === 'node_modules') continue;
      walk(path.join(dir, entry.name), onFile);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      onFile(path.join(dir, entry.name));
    }
  }
}

function allRels() {
  const rels = new Set();
  for (const locale of LOCALES) {
    const root = path.join(DOCS_ROOT, locale);
    if (!fs.existsSync(root)) continue;
    walk(root, (file) => rels.add(path.relative(root, file).split(path.sep).join('/')));
  }
  return [...rels].sort();
}

// --- CLI ------------------------------------------------------------------
// Importable (stamp-pair gates on it) but also runnable directly; only the
// direct run should produce output and set an exit code.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('check-parity.mjs');

if (invokedDirectly) {
  const targets = RELS.length > 0 ? RELS : allRels();
  const results = targets.map(checkPair);
  const failed = results.filter((r) => r.problems.length > 0);
  const skipped = results.filter((r) => r.skipped);
  const total = failed.reduce((n, r) => n + r.problems.length, 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          pairs: results.length - skipped.length,
          singleSided: skipped.length,
          problems: total,
          results: failed,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[check-parity] pairs=${results.length - skipped.length} single-sided=${skipped.length} ` +
        `problems=${total} in ${failed.length} pair(s)`,
    );
    for (const r of failed) {
      console.log(`\n  ${r.rel}`);
      for (const p of r.problems) console.log(`    [${p.check}] ${p.detail}`);
    }
    if (total === 0) console.log('  every two-sided pair is structurally consistent');
  }

  process.exit(total > 0 ? 1 : 0);
}
