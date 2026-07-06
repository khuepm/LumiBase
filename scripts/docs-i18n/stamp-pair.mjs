#!/usr/bin/env node
// Stamp a manually-translated doc pair with the SAME provenance that
// `sync.mjs --apply` would write, so a later `detect` run classifies the pair
// as up-to-date. Use this after hand-writing a translation into the target
// side (you already created/edited docs/<targetLocale>/<rel>).
//
// Usage:
//   node scripts/docs-i18n/stamp-pair.mjs <rel> <sourceLocale>
//     <rel>          path relative to docs/<locale>/, e.g. sdk/javascript.md
//     <sourceLocale> 'en' (source is EN, you wrote the VI translation)
//                    'vi' (source is VI, you wrote the EN translation)
//
// Assumes both docs/en/<rel> and docs/vi/<rel> already exist.

import { splitFrontMatter, contentHash, upsertKeys, buildFile, readKey } from './frontmatter.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const [rel, sourceLocale] = process.argv.slice(2);
if (!rel || !['en', 'vi'].includes(sourceLocale)) {
  console.error('usage: node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi>');
  process.exit(1);
}
const targetLocale = sourceLocale === 'en' ? 'vi' : 'en';
const now = new Date().toISOString();

const srcAbs = path.join(REPO, 'docs', sourceLocale, rel);
const tgtAbs = path.join(REPO, 'docs', targetLocale, rel);
for (const p of [srcAbs, tgtAbs]) {
  if (!fs.existsSync(p)) { console.error('missing:', p); process.exit(2); }
}

// source hash from its body
const { fmRaw: srcFm, body: srcBody } = splitFrontMatter(fs.readFileSync(srcAbs, 'utf8'));
const srcHash = contentHash(srcBody);

// stamp target (translated) file
const { fmRaw: tgtFm, body: tgtBody } = splitFrontMatter(fs.readFileSync(tgtAbs, 'utf8'));
const prevVersion = Number(readKey(tgtFm, 'version') || 0);
fs.writeFileSync(tgtAbs, buildFile(upsertKeys(tgtFm, {
  version: prevVersion + 1,
  lastUpdated: now,
  sourceLang: sourceLocale,
  translatedFrom: sourceLocale,
  sourceHash: srcHash,
  mtEngine: 'claude',
  syncStatus: 'machine-translated',
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
}), srcBody), 'utf8');

console.log(`stamped ${rel}  (${sourceLocale}->${targetLocale})  srcHash=${srcHash}`);
