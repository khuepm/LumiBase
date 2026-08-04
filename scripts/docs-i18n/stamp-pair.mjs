#!/usr/bin/env node
// Stamp a manually-translated doc pair with the provenance a later `detect` run
// needs to classify the pair as up-to-date (`sourceHash` + `translatedFrom`).
// Use this after hand-writing a translation into the target side (you already
// created/edited docs/<targetLocale>/<rel>).
//
// It records the translation as what it is — `mtEngine: manual`,
// `syncStatus: human-translated`. It used to copy `sync.mjs --apply`'s
// machine-translation provenance verbatim, which labelled every hand-written
// page as produced by an API this project does not call.
//
// Usage:
//   node scripts/docs-i18n/stamp-pair.mjs <rel> <sourceLocale> [--verified]
//     <rel>          path relative to docs/<locale>/, e.g. sdk/javascript.md
//     <sourceLocale> 'en' (source is EN, you wrote the VI translation)
//                    'vi' (source is VI, you wrote the EN translation)
//     --verified     additionally record that the doc's code-facing claims were
//                    checked against the source tree. Runs
//                    `verify-code-refs.mjs` and REFUSES to write the marker if
//                    anything is stale — or if the doc makes no claim the
//                    tooling can test, since "nothing to check" is not a pass.
//
// Assumes both docs/en/<rel> and docs/vi/<rel> already exist.
//
// PROVENANCE, AND WHY THERE ARE TWO SEPARATE MARKERS
// -------------------------------------------------
// `sourceHash`/`contentHash` answer "do the two locales correspond to the same
// source revision?" — a question purely about the pair. They say nothing about
// whether either side is *true*. Both translations can agree perfectly and both
// document an endpoint that was deleted a release ago.
//
// `codeVerified` answers the other question: "were this doc's claims about the
// repository checked?" It is stamped with the body hash it was verified at, so
// any later edit to the body invalidates it rather than carrying a stale
// assurance forward. Marking a translation as a full match requires both.

import { splitFrontMatter, contentHash, upsertKeys, buildFile, readKey } from './frontmatter.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const WANT_VERIFIED = argv.includes('--verified');
const [rel, sourceLocale] = argv.filter((a) => !a.startsWith('--'));
if (!rel || !['en', 'vi'].includes(sourceLocale)) {
  console.error('usage: node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> [--verified]');
  process.exit(1);
}
const targetLocale = sourceLocale === 'en' ? 'vi' : 'en';
const now = new Date().toISOString();

/**
 * Run the code-reference verifier for this rel and return its report.
 *
 * Exit code 1 means findings — expected, not a crash — so stderr/status are
 * read off the thrown error rather than letting it propagate.
 */
function runVerifier() {
  const script = path.join(__dirname, 'verify-code-refs.mjs');
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [script, rel, '--json'], { encoding: 'utf8' });
  } catch (err) {
    stdout = err.stdout || '';
    if (!stdout) {
      console.error('verifier failed to run:', err.message);
      process.exit(3);
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    console.error('verifier produced unparseable output');
    process.exit(3);
  }
}

const srcAbs = path.join(REPO, 'docs', sourceLocale, rel);
const tgtAbs = path.join(REPO, 'docs', targetLocale, rel);
for (const p of [srcAbs, tgtAbs]) {
  if (!fs.existsSync(p)) { console.error('missing:', p); process.exit(2); }
}

// source hash from its body
const { fmRaw: srcFm, body: srcBody } = splitFrontMatter(fs.readFileSync(srcAbs, 'utf8'));
const srcHash = contentHash(srcBody);

// Gate the verified marker BEFORE writing anything, so a refusal leaves both
// files untouched rather than half-stamped.
let verifiedKeys = {};
if (WANT_VERIFIED) {
  const report = runVerifier();
  if (report.findings > 0) {
    console.error(`refusing --verified: ${report.findings} stale code reference(s) in ${rel}`);
    for (const r of report.results ?? []) {
      for (const f of r.findings) console.error(`  docs/${r.locale}/${r.rel}  [${f.kind}] ${f.claim} — ${f.detail}`);
    }
    console.error('Fix the doc (or the code) and re-run.');
    process.exit(4);
  }
  if ((report.unverifiable ?? []).length > 0) {
    console.error(
      `refusing --verified: ${rel} makes no claim this tooling can test, so nothing was ` +
        'actually verified. Review it by hand and stamp without --verified.',
    );
    for (const u of report.unverifiable) console.error(`  ${u}`);
    process.exit(5);
  }
  verifiedKeys = {
    codeVerified: now,
    // Pinned to the body it was verified against: editing the body must
    // invalidate the assurance, not silently inherit it.
    codeVerifiedHash: srcHash,
    codeVerifiedClaims: report.claimsChecked,
  };
  console.log(`verified ${report.claimsChecked} code reference(s) in ${rel}`);
}

// stamp target (translated) file
//
// Version bumps only when the source it tracks actually moved. Bumping
// unconditionally inflated the target on every re-stamp — re-recording
// provenance is not a new revision — which drifted the two sides' numbers apart
// and made them uncomparable. Both locales now version on real change only.
const { fmRaw: tgtFm, body: tgtBody } = splitFrontMatter(fs.readFileSync(tgtAbs, 'utf8'));
const tgtPrevSourceHash = readKey(tgtFm, 'sourceHash');
let tgtVersion = Number(readKey(tgtFm, 'version') || 0);
if (tgtPrevSourceHash !== srcHash) tgtVersion += 1;
if (tgtVersion === 0) tgtVersion = 1;
fs.writeFileSync(tgtAbs, buildFile(upsertKeys(tgtFm, {
  version: tgtVersion,
  lastUpdated: tgtPrevSourceHash === srcHash ? (readKey(tgtFm, 'lastUpdated') || now) : now,
  sourceLang: sourceLocale,
  translatedFrom: sourceLocale,
  sourceHash: srcHash,
  mtEngine: 'manual',
  syncStatus: 'human-translated',
  ...verifiedKeys,
}), tgtBody), 'utf8');

// stamp source with its own contentHash
const srcPrevHash = readKey(srcFm, 'contentHash');
let srcVersion = Number(readKey(srcFm, 'version') || 0);
if (srcPrevHash !== srcHash) srcVersion += 1;
if (srcVersion === 0) srcVersion = 1;
fs.writeFileSync(srcAbs, buildFile(upsertKeys(srcFm, {
  version: srcVersion,
  lastUpdated: srcPrevHash === srcHash ? (readKey(srcFm, 'lastUpdated') || now) : now,
  sourceLang: sourceLocale,
  contentHash: srcHash,
  // Both sides carry the marker: the claims live in both translations, so
  // either one going stale is a finding against that file.
  ...verifiedKeys,
}), srcBody), 'utf8');

console.log(
  `stamped ${rel}  (${sourceLocale}->${targetLocale})  srcHash=${srcHash}` +
    (WANT_VERIFIED ? '  codeVerified' : ''),
);
