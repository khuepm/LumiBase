#!/usr/bin/env node
// Self-healing docs (#756): rewrite the MECHANICAL doc/code drift the verifier
// can detect, in both locales identically, and list everything else for a human.
//
// WHAT IT FIXES
// -------------
// Only drift with exactly one correct answer that does not depend on language:
//
//   file    `apps/x/old.ts` -> `apps/x/new.ts`    git rename (this range, or history)
//   env     `LUMIBASE_OLD`  -> `LUMIBASE_NEW`      1:1 rename inside one source file
//   route   `/api/v1/old/…` -> `/api/v1/new/…`     1:1 route-literal rename, one segment
//   symbol  `oldName()`     -> `newName()`         1:1 export rename in a file the doc cites
//
// Paths, env names, routes and identifiers are code, and `check-parity.mjs`
// requires code to be byte-identical across EN and VI — so the same rewrite is
// applied to both locales and the pair stays one document. Nothing is
// translated, and there is no model call anywhere here: there is deliberately no
// ANTHROPIC_API_KEY in CI (docs/.i18n/TASKS.md §6). A removed route, a deleted
// file, an env var that is simply gone — those need a sentence rewritten, in two
// languages, by someone who knows why. They are reported, never guessed at.
//
// PROVENANCE
// ----------
// After rewriting, a pair is re-stamped (`stamp-pair.mjs <rel> <sourceLang>
// --verified`) only when ALL of these hold:
//   - it was in sync before the fix (target `sourceHash` matched the source body),
//     so a fix never launders a pair that was already awaiting translation;
//   - both locales now verify with zero findings; and
//   - stamp-pair's own gates (structural parity, verifiable) accept it.
// Otherwise the bodies are rewritten but provenance is left alone, and the
// report says why — the pair then honestly reads as needing attention.
//
// Usage:
//   node scripts/docs-i18n/self-heal.mjs --base <ref> [--head <ref>]
//        [--report out.md] [--json out.json] [--dry-run] [--rels a.md,b.md]
//
// --base is the revision the drift is measured from (on main: the previous
// push, or the base recorded in the open self-heal PR). File moves are also
// followed through the whole git rename history, so a path that went stale
// before --base is still healed.
//
// Exit code: 0 = ran (whether or not anything changed), 2 = bad usage/git error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCALES, DOCS_ROOT, REPO_ROOT } from './config.mjs';
import { splitFrontMatter, readKey, contentHash } from './frontmatter.mjs';
import { verifyText, fsTree, allRels } from './verify-code-refs.mjs';
import { gitTree, historyRenames, resolveRef } from './git-tree.mjs';
import { computeChangeSet, symbolFindings, explainFinding, escapeRe } from './code-drift.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pure rewriting
// ---------------------------------------------------------------------------

const REWRITERS = {
  // A path is replaced wherever it appears as a whole path — code spans, fenced
  // examples, link targets (`../../apps/x.ts`, `…/blob/main/apps/x.ts`). It may
  // be preceded by `/` but not by a path character, and not continue into a
  // longer path, so `apps/a.ts` never rewrites `apps/a.tsx` or `xapps/a.ts`.
  path: (from) => new RegExp(`(?<![A-Za-z0-9_.@-])${escapeRe(from)}(?!\\.?[A-Za-z0-9_/-])`, 'g'),
  // Env names are distinctive upper-snake tokens; whole-word everywhere.
  word: (from) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(from)}(?![A-Za-z0-9_])`, 'g'),
  // A route claim, not followed by more of the same segment.
  route: (from) => new RegExp(`${escapeRe(from)}(?![A-Za-z0-9_-])`, 'g'),
};

/** Replace an identifier inside inline code spans only (never prose, never fences). */
function rewriteSpans(body, from, to) {
  let count = 0;
  let inFence = false;
  const lines = body.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(/`([^`\n]+)`/g, (whole, span) => {
      const m = new RegExp(`^${escapeRe(from)}(?=$|\\(|<)`).exec(span);
      if (!m) return whole;
      count += 1;
      return '`' + to + span.slice(from.length) + '`';
    });
  });
  return { text: lines.join('\n'), count };
}

/**
 * Apply fixes to a doc's raw text. Front matter is never touched — it holds
 * provenance, which is stamp-pair's to write.
 * @param {string} raw
 * @param {{ from: string, to: string, scope: 'path'|'word'|'route'|'span' }[]} fixes
 * @returns {{ text: string, applied: { from: string, to: string, scope: string, count: number }[] }}
 */
export function applyFixes(raw, fixes) {
  const { body } = splitFrontMatter(raw);
  const prefix = raw.slice(0, raw.length - body.length);
  let text = body;
  const applied = [];
  // Longest first, so a fix for `/a/b` is not pre-empted by one for `/a`.
  const ordered = [...fixes].sort((a, b) => b.from.length - a.from.length);
  for (const fix of ordered) {
    let count = 0;
    if (fix.scope === 'span') {
      const r = rewriteSpans(text, fix.from, fix.to);
      text = r.text;
      count = r.count;
    } else {
      text = text.replace(REWRITERS[fix.scope](fix.from), () => {
        count += 1;
        return fix.to;
      });
    }
    applied.push({ ...fix, count });
  }
  return { text: prefix + text, applied };
}

// ---------------------------------------------------------------------------
// Healing a pair
// ---------------------------------------------------------------------------

/** All stale claims in one locale's text, with causes and fixes attached. */
export function diagnose(raw, { tree, changeSet, history }) {
  const findings = [
    ...verifyText(raw, tree).findings,
    ...(changeSet ? symbolFindings(raw, changeSet) : []),
  ];
  return findings.map((f) => ({ ...f, ...explainFinding(f, changeSet, { tree, history }) }));
}

/** Source locale of a pair, from front matter (EN when unstated). */
function sourceLangOf(raws) {
  for (const raw of Object.values(raws)) {
    const lang = readKey(splitFrontMatter(raw).fmRaw, 'sourceLang');
    if (LOCALES.includes(lang)) return lang;
  }
  return 'en';
}

/** Was the target side stamped against the CURRENT source body? */
function pairInSync(raws, src) {
  const tgt = src === 'en' ? 'vi' : 'en';
  if (!raws[src] || !raws[tgt]) return false;
  const srcHash = contentHash(splitFrontMatter(raws[src]).body);
  return readKey(splitFrontMatter(raws[tgt]).fmRaw, 'sourceHash') === srcHash;
}

/**
 * Heal one doc pair. Reads and (unless dryRun) writes docs/<locale>/<rel>.
 * @returns {{ rel, fixes, unfixed, restamped: boolean, stampNote: string|null, changed: boolean }}
 */
export function healPair(rel, { docsRoot = DOCS_ROOT, tree, changeSet, history, dryRun = false, stamp = runStamp }) {
  const raws = {};
  for (const locale of LOCALES) {
    const abs = path.join(docsRoot, locale, rel);
    if (fs.existsSync(abs)) raws[locale] = fs.readFileSync(abs, 'utf8');
  }
  const diag = {};
  for (const [locale, raw] of Object.entries(raws)) diag[locale] = diagnose(raw, { tree, changeSet, history });

  // One fix list for the pair: a claim stale in either locale is rewritten in
  // both (a no-op where it does not occur), which is what keeps the code in
  // the two sides identical.
  const fixByKey = new Map();
  for (const list of Object.values(diag)) {
    for (const d of list) if (d.fix) fixByKey.set(`${d.fix.scope}:${d.fix.from}`, d.fix);
  }
  const fixes = [...fixByKey.values()];
  const result = { rel, fixes: [], unfixed: [], restamped: false, stampNote: null, changed: false };
  if (fixes.length === 0) {
    result.unfixed = collectUnfixed(rel, diag);
    return result;
  }

  const src = sourceLangOf(raws);
  const wasInSync = pairInSync(raws, src);
  const next = {};
  for (const [locale, raw] of Object.entries(raws)) {
    const { text, applied } = applyFixes(raw, fixes);
    next[locale] = text;
    for (const a of applied) {
      if (a.count === 0) continue;
      const d = diag[locale].find((x) => x.fix && x.fix.scope === a.scope && x.fix.from === a.from);
      result.fixes.push({
        file: `docs/${locale}/${rel}`,
        line: d?.line ?? null,
        kind: d?.kind ?? a.scope,
        from: a.from,
        to: a.to,
        count: a.count,
        cause: d?.cause ?? null,
      });
    }
  }
  result.changed = Object.keys(next).some((l) => next[l] !== raws[l]);

  // What is still stale after the rewrite is what a human has to look at.
  const after = {};
  for (const [locale, text] of Object.entries(next)) after[locale] = diagnose(text, { tree, changeSet, history });
  result.unfixed = collectUnfixed(rel, after);

  if (!dryRun && result.changed) {
    for (const [locale, text] of Object.entries(next)) {
      fs.writeFileSync(path.join(docsRoot, locale, rel), text, 'utf8');
    }
  }

  if (!result.changed) return result;
  if (Object.keys(raws).length < LOCALES.length) {
    result.stampNote = 'single-locale doc — nothing to stamp';
  } else if (!wasInSync) {
    result.stampNote = 'pair was not in sync before the fix — provenance left for the translator';
  } else if (result.unfixed.length > 0) {
    result.stampNote = 'stale claims remain — not re-stamped';
  } else if (dryRun) {
    result.stampNote = 'dry run — would re-stamp --verified';
  } else {
    const r = stamp(rel, src);
    result.restamped = r.ok;
    result.stampNote = r.ok ? `re-stamped (${src} source) --verified` : `stamp-pair refused: ${r.message}`;
  }
  return result;
}

function collectUnfixed(rel, diag) {
  const out = [];
  for (const [locale, list] of Object.entries(diag)) {
    for (const d of list) {
      out.push({ file: `docs/${locale}/${rel}`, line: d.line, kind: d.kind, claim: d.claim, cause: d.cause });
    }
  }
  return out;
}

function runStamp(rel, src) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'stamp-pair.mjs'), rel, src, '--verified'], {
    encoding: 'utf8',
  });
  const message = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n')[0] ?? '';
  return { ok: r.status === 0, message };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Marker the workflow reads back from the open PR to keep the range sticky. */
export const BASE_MARKER = (sha) => `<!-- self-heal-base: ${sha} -->`;

export function renderReport({ base, head, results }) {
  const fixes = results.flatMap((r) => r.fixes);
  const unfixed = results.flatMap((r) => r.unfixed);
  const stamps = results.filter((r) => r.changed);
  const lines = [];
  lines.push(BASE_MARKER(base));
  lines.push('## Self-healing docs');
  lines.push('');
  lines.push(
    `Deterministic doc/code drift fixes for \`${base.slice(0, 12)}..${head.slice(0, 12)}\`. ` +
      'Every rewrite below is a path, env-var name, route or exported identifier — code, which is ' +
      'identical in EN and VI — applied to both locales by `scripts/docs-i18n/self-heal.mjs`. ' +
      'Nothing was translated and no model was called. **Review before merging; this PR is never auto-merged.**',
  );
  lines.push('');
  lines.push(`### Fixed (${fixes.length})`);
  lines.push('');
  if (fixes.length === 0) lines.push('_None._');
  else {
    lines.push('| Doc | Kind | Was | Now | Why |');
    lines.push('|---|---|---|---|---|');
    for (const f of fixes) {
      lines.push(
        `| \`${f.file}${f.line ? `:${f.line}` : ''}\` | ${f.kind} | \`${f.from}\` | \`${f.to}\` | ${escapeCell(f.cause ?? '')}${f.count > 1 ? ` (${f.count}×)` : ''} |`,
      );
    }
  }
  lines.push('');
  lines.push(`### Needs a human (${unfixed.length})`);
  lines.push('');
  if (unfixed.length === 0) lines.push('_None — every stale claim found was mechanical._');
  else {
    lines.push(
      'These claims are stale but have no single mechanical answer (a removed route, a deleted file, an ' +
        'ambiguous rename). The surrounding prose has to change, in both `docs/en` and `docs/vi`, by hand.',
    );
    lines.push('');
    lines.push('| Doc | Kind | Claim | Cause |');
    lines.push('|---|---|---|---|');
    for (const u of unfixed) {
      lines.push(`| \`${u.file}${u.line ? `:${u.line}` : ''}\` | ${u.kind} | \`${u.claim}\` | ${escapeCell(u.cause ?? '')} |`);
    }
  }
  lines.push('');
  lines.push('### Provenance');
  lines.push('');
  if (stamps.length === 0) lines.push('_No pair changed._');
  for (const r of stamps) lines.push(`- \`${r.rel}\` — ${r.stampNote}`);
  lines.push('');
  return lines.join('\n');
}

function escapeCell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { head: 'HEAD', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--base') opts.base = val();
    else if (a === '--head') opts.head = val();
    else if (a === '--report') opts.report = val();
    else if (a === '--json') opts.json = val();
    else if (a === '--rels') opts.rels = val().split(',').filter(Boolean);
    else if (a === '--dry-run') opts.dryRun = true;
    else {
      console.error(`self-heal: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.base) {
    console.error('usage: self-heal.mjs --base <ref> [--head <ref>] [--report f.md] [--json f.json] [--dry-run]');
    process.exit(2);
  }
  const base = resolveRef(REPO_ROOT, opts.base);
  const head = resolveRef(REPO_ROOT, opts.head);
  if (!base || !head) {
    console.error(`self-heal: cannot resolve ${!base ? opts.base : opts.head} (is the clone shallow?)`);
    process.exit(2);
  }

  // The working copy is the head checkout; claims are verified against it, the
  // base side is read from git.
  const tree = fsTree(REPO_ROOT);
  const changeSet = computeChangeSet({ cwd: REPO_ROOT, base, head, baseTree: gitTree(REPO_ROOT, base), headTree: tree });
  const history = historyRenames(REPO_ROOT, head);

  const rels = opts.rels ?? allRels(DOCS_ROOT);
  const results = rels.map((rel) => healPair(rel, { tree, changeSet, history, dryRun: opts.dryRun }));
  const touched = results.filter((r) => r.changed || r.unfixed.length > 0);
  const report = renderReport({ base, head, results: touched });

  if (opts.report) fs.writeFileSync(opts.report, report, 'utf8');
  if (opts.json) {
    fs.writeFileSync(
      opts.json,
      JSON.stringify(
        {
          base,
          head,
          changedPairs: results.filter((r) => r.changed).map((r) => r.rel),
          fixes: touched.flatMap((r) => r.fixes),
          unfixed: touched.flatMap((r) => r.unfixed),
          provenance: touched.filter((r) => r.changed).map((r) => ({ rel: r.rel, restamped: r.restamped, note: r.stampNote })),
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  const nFix = touched.reduce((n, r) => n + r.fixes.length, 0);
  const nUnfixed = touched.reduce((n, r) => n + r.unfixed.length, 0);
  console.log(
    `[self-heal] ${base.slice(0, 12)}..${head.slice(0, 12)} docs=${rels.length} ` +
      `pairs-changed=${results.filter((r) => r.changed).length} fixes=${nFix} needs-human=${nUnfixed}` +
      (opts.dryRun ? ' (dry run)' : ''),
  );
  for (const r of touched) {
    for (const f of r.fixes) console.log(`  fixed  ${f.file}:${f.line ?? '?'} [${f.kind}] ${f.from} -> ${f.to}`);
    for (const u of r.unfixed) console.log(`  human  ${u.file}:${u.line} [${u.kind}] ${u.claim} — ${u.cause}`);
    if (r.changed) console.log(`  stamp  ${r.rel}: ${r.stampNote}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
