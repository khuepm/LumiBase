#!/usr/bin/env node
// PR gate (#756): fail when a change makes a doc claim stale, and say exactly
// where and why.
//
// `verify-code-refs.mjs` checks a doc against the tree it sits in. That is not
// enough on a PR: a rename in `apps/cms` silently breaks `docs/vi/x.md` without
// the PR touching any doc, and the existing docs workflow only runs when docs
// change. This gate runs on code changes too:
//
//   1. diff the PR (base..head, with rename detection) — code-drift.mjs
//   2. map the changed source files to the docs that cite them, plus every doc
//      the PR edited, plus docs naming a route segment / env var / exported
//      symbol the PR removed
//   3. verify those docs at HEAD and at BASE with the same checks
//      `stamp-pair --verified` enforces, and fail on claims stale at HEAD that
//      were not stale at BASE — the drift THIS PR introduced
//   4. print a GitHub annotation per occurrence (`::error file=…,line=…::`) with
//      the claim, the cause (file moved to X, segment renamed, env var no longer
//      read…) and whether `pnpm docs:i18n:heal` can rewrite it mechanically.
//
// Findings that were already stale at the base are reported as warnings, not
// failures: the contributor is answerable for what they changed.
//
// Usage:
//   node scripts/docs-i18n/gate-code-drift.mjs --base <ref> [--head <ref>] [--all] [--json out.json]
//
//   --all   verify every doc instead of the mapped set (still diffed vs base)
//
// Exit code: 0 = no new stale claim, 1 = new stale claim(s), 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, REPO_ROOT } from './config.mjs';
import { verifyText } from './verify-code-refs.mjs';
import { gitTree, historyRenames, resolveRef } from './git-tree.mjs';
import { computeChangeSet, explainFinding, mapChangesToDocs, symbolFindings } from './code-drift.mjs';

/** Escape a value for a workflow-command message / property (GitHub spec). */
export function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** `::error file=…,line=…,title=…::message` */
export function annotation(level, { file, line, title, message }) {
  const props = [`file=${escapeProperty(file)}`];
  if (line) props.push(`line=${line}`);
  if (title) props.push(`title=${escapeProperty(title)}`);
  return `::${level} ${props.join(',')}::${escapeData(message)}`;
}

const keyOf = (f) => `${f.kind}:${f.claim}`;

/**
 * Run the gate against a git repository.
 * @returns {{ affected: Map<string,string[]>, introduced: object[], preexisting: object[] }}
 */
export function runGate({ cwd = REPO_ROOT, base, head = 'HEAD', all = false }) {
  const baseSha = resolveRef(cwd, base);
  const headSha = resolveRef(cwd, head);
  if (!baseSha || !headSha) throw new Error(`cannot resolve ${!baseSha ? base : head}`);
  const baseTree = gitTree(cwd, baseSha);
  const headTree = gitTree(cwd, headSha);
  const changeSet = computeChangeSet({ cwd, base: baseSha, head: headSha, baseTree, headTree });
  const history = historyRenames(cwd, headSha);

  const DOC = /^docs\/(en|vi)\/(.+\.md)$/;
  const docs = [];
  for (const f of headTree.files) {
    const m = DOC.exec(f);
    if (!m) continue;
    docs.push({ rel: m[2], locale: m[1], path: f, raw: headTree.read(f) });
  }

  let affected = mapChangesToDocs(docs, changeSet);
  if (all) {
    const everything = new Map(docs.map((d) => [d.rel, ['--all']]));
    for (const [rel, why] of affected) everything.set(rel, why);
    affected = everything;
  }

  const introduced = [];
  const preexisting = [];
  for (const rel of [...affected.keys()].sort()) {
    for (const locale of LOCALES) {
      const p = `docs/${locale}/${rel}`;
      const headRaw = headTree.read(p);
      if (headRaw == null) continue; // a half-deleted pair is the parity gate's to fail
      const baseRaw = baseTree.read(p);
      const baseKeys = new Set(baseRaw == null ? [] : verifyText(baseRaw, baseTree).findings.map(keyOf));
      const findings = [...verifyText(headRaw, headTree).findings, ...symbolFindings(headRaw, changeSet)];
      for (const f of findings) {
        const { cause, fix } = explainFinding(f, changeSet, { tree: headTree, history });
        const entry = { file: p, rel, locale, ...f, cause, fixable: Boolean(fix), fixTo: fix?.to ?? null };
        if (f.kind !== 'symbol' && baseKeys.has(keyOf(f))) preexisting.push(entry);
        else introduced.push(entry);
      }
    }
  }
  return { affected, introduced, preexisting, base: baseSha, head: headSha };
}

function describe(e) {
  const fix = e.fixable
    ? ` Mechanical fix available: \`${e.claim}\` -> \`${e.fixTo}\` (run \`pnpm docs:i18n:heal --base <base>\`, or wait for the docs/self-heal PR after merge).`
    : ' No mechanical fix: rewrite this sentence in both docs/en and docs/vi.';
  return `[${e.kind}] ${e.claim} — ${e.detail ?? 'stale'}. Cause: ${e.cause}.${fix}`;
}

function parseArgs(argv) {
  const opts = { head: 'HEAD', all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--head') opts.head = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--all') opts.all = true;
    else {
      console.error(`gate-code-drift: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.base) {
    console.error('usage: gate-code-drift.mjs --base <ref> [--head <ref>] [--all] [--json out.json]');
    process.exit(2);
  }
  let result;
  try {
    result = runGate({ base: opts.base, head: opts.head, all: opts.all });
  } catch (err) {
    console.error(`gate-code-drift: ${err.message}`);
    process.exit(2);
  }
  const { affected, introduced, preexisting, base, head } = result;

  console.log(
    `gate-code-drift: ${base.slice(0, 12)}..${head.slice(0, 12)} — ${affected.size} doc pair(s) affected, ` +
      `${introduced.length} new stale claim(s), ${preexisting.length} pre-existing`,
  );
  for (const [rel, why] of [...affected].sort()) console.log(`  ${rel}\n    ${why.slice(0, 4).join('\n    ')}${why.length > 4 ? `\n    (+${why.length - 4} more)` : ''}`);

  for (const e of introduced) {
    for (const line of e.lines.slice(0, 5)) {
      console.log(annotation('error', { file: e.file, line, title: `Stale doc claim (${e.kind})`, message: describe(e) }));
    }
  }
  for (const e of preexisting) {
    console.log(annotation('warning', { file: e.file, line: e.line, title: `Pre-existing stale doc claim (${e.kind})`, message: describe(e) }));
  }

  if (introduced.length > 0) {
    console.error('\nStale doc claims introduced by this change:\n');
    for (const e of introduced) console.error(`  ${e.file}:${e.line}  ${describe(e)}`);
    console.error(`
Docs are verified against the code (CLAUDE.md, "Docs i18n — mandatory workflow").
Mechanical drift (moved file, renamed route segment / env var / export) can be
rewritten in both locales with:

  pnpm docs:i18n:heal --base origin/main

Anything else needs the sentence rewritten in docs/en AND docs/vi, then:

  pnpm docs:i18n:verify <rel>
  node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = introduced.map(
      (e) => `| \`${e.file}:${e.line}\` | ${e.kind} | \`${e.claim}\` | ${e.cause.replace(/\|/g, '\\|')} | ${e.fixable ? `\`${e.fixTo}\`` : 'human'} |`,
    );
    fs.appendFileSync(
      summary,
      `## Doc/code drift\n\n${affected.size} doc pair(s) affected by this change, ` +
        `${introduced.length} new stale claim(s), ${preexisting.length} pre-existing.\n\n` +
        (rows.length ? `| Doc | Kind | Claim | Cause | Fix |\n|---|---|---|---|---|\n${rows.join('\n')}\n` : ''),
    );
  }
  if (opts.json) {
    fs.writeFileSync(
      opts.json,
      JSON.stringify({ base, head, affected: Object.fromEntries(affected), introduced, preexisting }, null, 2),
    );
  }
  process.exit(introduced.length > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
