#!/usr/bin/env node
// Docs i18n sync orchestrator.
//
// Responsibilities:
//   1. Detect the real language of every doc in docs/en and docs/vi (heuristic).
//   2. Decide a source-of-truth per file pair and what action is required.
//   3. Preserve Vietnamese content that currently lives in an en-labelled file
//      BEFORE any translation overwrites it (no-loss requirement).
//   4. Machine-translate stale/missing targets (DeepL or Google) — only in --apply.
//   5. Stamp every written file with `version` + `lastUpdated` + provenance front
//      matter so changes are versioned and auditable.
//   6. Append a human-readable sync log + a machine-readable JSON report.
//
// Modes:
//   (no flag)        plan only — detect, classify, write log + report. No doc rewrites.
//   --preserve-only  also perform the safe no-MT preservation copies + version stamps.
//   --apply          full run: preservation + machine translation + version stamps.
//
// Without an MT API key, --apply degrades to --preserve-only and records why.

import fs from 'node:fs';
import path from 'node:path';
import {
  DOCS_ROOT,
  LOCALES,
  DEFAULT_LOCALE,
  otherLocale,
  IGNORED_DIRS,
  IGNORED_FILES,
  SYNC_LOG_PATH,
  SYNC_REPORT_PATH,
} from './config.mjs';
import { detectLang } from './lang-detect.mjs';
import { protectMarkdown, restoreMarkdown } from './markdown-protect.mjs';
import { translateText, engineAvailable, engineLabel } from './mt-engine.mjs';
import {
  splitFrontMatter,
  readKey,
  upsertKeys,
  buildFile,
  contentHash,
} from './frontmatter.mjs';

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has('--apply')
  ? 'apply'
  : ARGS.has('--preserve-only')
    ? 'preserve-only'
    : 'plan';

const PRESERVE_DIR = path.join(DOCS_ROOT, '.i18n', 'preserved');

function localeDir(locale) {
  return path.join(DOCS_ROOT, locale);
}

/** Recursively collect *.md files under a locale dir, keyed by path relative to it. */
function collectDocs(locale) {
  const root = localeDir(locale);
  const out = new Map();
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (IGNORED_FILES.has(rel)) continue;
        out.set(rel, abs);
      }
    }
  };
  walk(root);
  return out;
}

function readFile(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

/** Translate a markdown body with placeholder protection + post-restore validation. */
async function translateBody(body, sourceLocale, targetLocale) {
  const { masked, tokens } = protectMarkdown(body);
  const translatedMasked = await translateText(masked, sourceLocale, targetLocale);
  const { text, missing } = restoreMarkdown(translatedMasked, tokens);
  return { text, missing };
}

/**
 * Write a translated target file, bumping version and stamping provenance.
 * Reads any existing target front matter to continue the version counter.
 */
function writeTargetFile(targetAbs, translatedBody, meta) {
  let prevVersion = 0;
  if (fs.existsSync(targetAbs)) {
    const { fmRaw } = splitFrontMatter(readFile(targetAbs));
    const v = readKey(fmRaw, 'version');
    if (v && !Number.isNaN(Number(v))) prevVersion = Number(v);
  }
  const { fmRaw: existingFm } = fs.existsSync(targetAbs)
    ? splitFrontMatter(readFile(targetAbs))
    : { fmRaw: null };

  const fmRaw = upsertKeys(existingFm, {
    version: prevVersion + 1,
    lastUpdated: meta.now,
    sourceLang: meta.sourceLocale,
    translatedFrom: meta.sourceLocale,
    sourceHash: meta.sourceHash,
    mtEngine: meta.engine,
    syncStatus: meta.status,
  });
  ensureDir(targetAbs);
  fs.writeFileSync(targetAbs, buildFile(fmRaw, translatedBody), 'utf8');
}

/** Stamp a source file with version + lastUpdated + its own content hash. */
function stampSourceFile(sourceAbs, sourceBody, sourceLocale, now) {
  const raw = readFile(sourceAbs);
  const { fmRaw, body } = splitFrontMatter(raw);
  const newHash = contentHash(sourceBody);
  const prevHash = readKey(fmRaw, 'contentHash');
  let version = Number(readKey(fmRaw, 'version') || 0);
  if (prevHash !== newHash) version += 1; // content changed → bump
  if (version === 0) version = 1;
  const newFm = upsertKeys(fmRaw, {
    version,
    lastUpdated: prevHash === newHash ? readKey(fmRaw, 'lastUpdated') || now : now,
    sourceLang: sourceLocale,
    contentHash: newHash,
  });
  fs.writeFileSync(sourceAbs, buildFile(newFm, body), 'utf8');
}

function preserveContent(relPath, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESERVE_DIR, `${relPath}.${stamp}.bak.md`);
  ensureDir(dest);
  fs.writeFileSync(dest, content, 'utf8');
  return path.relative(DOCS_ROOT, dest).split(path.sep).join('/');
}

async function main() {
  const now = new Date().toISOString();
  const engine = engineLabel();
  const hasEngine = engineAvailable();
  let effectiveMode = MODE;
  if (MODE === 'apply' && !hasEngine) effectiveMode = 'preserve-only';

  const docs = Object.fromEntries(LOCALES.map((l) => [l, collectDocs(l)]));
  const allPaths = new Set([...docs.en.keys(), ...docs.vi.keys()]);

  const actions = [];

  for (const rel of [...allPaths].sort()) {
    const enAbs = docs.en.get(rel);
    const viAbs = docs.vi.get(rel);

    const enRaw = enAbs ? readFile(enAbs) : null;
    const viRaw = viAbs ? readFile(viAbs) : null;
    const enBody = enRaw != null ? splitFrontMatter(enRaw).body : null;
    const viBody = viRaw != null ? splitFrontMatter(viRaw).body : null;

    const enDet = enBody != null ? detectLang(enBody) : null;
    const viDet = viBody != null ? detectLang(viBody) : null;

    const action = classify(rel, {
      enAbs, viAbs, enBody, viBody, enDet, viDet,
    });
    actions.push(action);
  }

  // Execute actions per mode.
  const summary = { translated: 0, preserved: 0, conflicts: 0, upToDate: 0, planned: 0 };

  for (const a of actions) {
    if (a.type === 'up-to-date') {
      summary.upToDate += 1;
      continue;
    }

    if (effectiveMode === 'plan') {
      summary.planned += 1;
      continue;
    }

    // preserve-only and apply both run preservation/conflict handling.
    if (a.type === 'preserve-and-translate') {
      // Move the Vietnamese content currently mislabelled in en/ into vi/.
      a.preservedTo = null;
      if (effectiveMode === 'preserve-only' || effectiveMode === 'apply') {
        const viAbs = path.join(localeDir('vi'), a.rel);
        ensureDir(viAbs);
        // Stamp the rescued vi file as the source of truth.
        const tmp = a.sourceBody;
        fs.writeFileSync(viAbs, tmp, 'utf8');
        stampSourceFile(viAbs, tmp, 'vi', now);
        summary.preserved += 1;
      }
    }

    if (a.type === 'preserve-and-translate-en') {
      // English content currently mislabelled in vi/ → rescue into en/ first.
      const enAbs = path.join(localeDir('en'), a.rel);
      ensureDir(enAbs);
      fs.writeFileSync(enAbs, a.sourceBody, 'utf8');
      stampSourceFile(enAbs, a.sourceBody, 'en', now);
      summary.preserved += 1;
    }

    if (a.type === 'conflict') {
      a.preservedTo = preserveContent(a.rel, a.conflictContent);
      summary.conflicts += 1;
      continue; // never auto-overwrite on conflict
    }

    if (effectiveMode === 'apply' && hasEngine && a.willTranslate) {
      const sourceAbs = path.join(localeDir(a.sourceLocale), a.rel);
      const targetAbs = path.join(localeDir(a.targetLocale), a.rel);
      const { text, missing } = await translateBody(
        a.sourceBody,
        a.sourceLocale,
        a.targetLocale,
      );
      const status = missing.length ? 'needs-review' : 'machine-translated';
      writeTargetFile(targetAbs, text, {
        now,
        sourceLocale: a.sourceLocale,
        sourceHash: contentHash(a.sourceBody),
        engine,
        status,
      });
      // Keep the source's own version/hash stamp current.
      if (fs.existsSync(sourceAbs)) stampSourceFile(sourceAbs, a.sourceBody, a.sourceLocale, now);
      a.missingPlaceholders = missing.length;
      summary.translated += 1;
    } else if (a.willTranslate) {
      summary.planned += 1;
    }
  }

  writeReport({ now, mode: MODE, effectiveMode, engine, hasEngine, actions, summary });
  appendLog({ now, mode: MODE, effectiveMode, engine, hasEngine, actions, summary });

  // Console summary.
  const line = (k, v) => console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`\n[docs-i18n] mode=${MODE} effective=${effectiveMode} engine=${engine} key=${hasEngine ? 'present' : 'absent'}`);
  line('files', allPaths.size);
  line('up-to-date', summary.upToDate);
  line('translated', summary.translated);
  line('preserved', summary.preserved);
  line('conflicts', summary.conflicts);
  line('planned', summary.planned);
  console.log(`\nReport:  ${path.relative(process.cwd(), SYNC_REPORT_PATH)}`);
  console.log(`Log:     ${path.relative(process.cwd(), SYNC_LOG_PATH)}\n`);
}

/**
 * Decide what to do with a single relative path given both locales' state.
 * Returns an action descriptor.
 */
function classify(rel, ctx) {
  const { enAbs, viAbs, enBody, viBody, enDet, viDet } = ctx;
  const base = { rel, enLang: enDet?.lang ?? null, viLang: viDet?.lang ?? null };

  const enIsVi = enDet && enDet.lang === 'vi';
  const viIsEn = viDet && viDet.lang === 'en';

  // en file actually contains Vietnamese.
  if (enAbs && enIsVi) {
    if (!viAbs) {
      // No vi counterpart yet → rescue the vi content into vi/, then vi→en.
      return {
        ...base,
        type: 'preserve-and-translate',
        reason: 'en-file-is-vietnamese; no vi counterpart',
        sourceLocale: 'vi',
        targetLocale: 'en',
        sourceBody: enBody,
        willTranslate: true,
      };
    }
    // vi already exists. If the en-resident Vietnamese differs from vi, it is
    // unsynced authored content → flag conflict and preserve, do not overwrite.
    if (contentHash(enBody) !== contentHash(viBody)) {
      return {
        ...base,
        type: 'conflict',
        reason: 'en file holds Vietnamese that differs from existing docs/vi',
        conflictContent: enBody,
        willTranslate: false,
      };
    }
    // Identical → en just needs to be the English translation of vi.
    return {
      ...base,
      type: 'translate',
      reason: 'en duplicates vi content; replace en with English translation',
      sourceLocale: 'vi',
      targetLocale: 'en',
      sourceBody: viBody,
      willTranslate: needsTranslation(enAbs, viBody),
    };
  }

  // Symmetric rare case: a vi file actually contains English.
  if (viAbs && viIsEn && !enAbs) {
    return {
      ...base,
      type: 'preserve-and-translate-en',
      reason: 'vi-file-is-english; no en counterpart',
      sourceLocale: 'en',
      targetLocale: 'vi',
      sourceBody: viBody,
      willTranslate: true,
    };
  }

  // Only one side exists → it is the source, translate to the other.
  if (enAbs && !viAbs) {
    return {
      ...base,
      type: 'translate',
      reason: 'missing vi translation',
      sourceLocale: 'en',
      targetLocale: 'vi',
      sourceBody: enBody,
      willTranslate: needsTranslation(viAbs, enBody),
    };
  }
  if (viAbs && !enAbs) {
    return {
      ...base,
      type: 'translate',
      reason: 'missing en translation',
      sourceLocale: 'vi',
      targetLocale: 'en',
      sourceBody: viBody,
      willTranslate: needsTranslation(enAbs, viBody),
    };
  }

  // Both exist and folders match their language → default source is en.
  if (enAbs && viAbs) {
    const sourceLocale = DEFAULT_LOCALE;
    const targetLocale = otherLocale(sourceLocale);
    const sourceBody = sourceLocale === 'en' ? enBody : viBody;
    const targetAbs = targetLocale === 'en' ? enAbs : viAbs;
    const needs = needsTranslation(targetAbs, sourceBody);
    return {
      ...base,
      type: needs ? 'translate' : 'up-to-date',
      reason: needs ? 'source changed since last sync' : 'in sync',
      sourceLocale,
      targetLocale,
      sourceBody,
      willTranslate: needs,
    };
  }

  return { ...base, type: 'up-to-date', reason: 'nothing to do', willTranslate: false };
}

/** A target needs (re)translation if it is missing or its stored sourceHash is stale. */
function needsTranslation(targetAbs, sourceBody) {
  if (!targetAbs || !fs.existsSync(targetAbs)) return true;
  const { fmRaw } = splitFrontMatter(readFile(targetAbs));
  const stored = readKey(fmRaw, 'sourceHash');
  if (!stored) return true;
  return stored !== contentHash(sourceBody);
}

function writeReport(data) {
  ensureDir(SYNC_REPORT_PATH);
  const slim = {
    generatedAt: data.now,
    mode: data.mode,
    effectiveMode: data.effectiveMode,
    engine: data.engine,
    engineKeyPresent: data.hasEngine,
    summary: data.summary,
    actions: data.actions.map((a) => ({
      rel: a.rel,
      type: a.type,
      reason: a.reason,
      enLang: a.enLang,
      viLang: a.viLang,
      sourceLocale: a.sourceLocale ?? null,
      targetLocale: a.targetLocale ?? null,
      willTranslate: Boolean(a.willTranslate),
      preservedTo: a.preservedTo ?? null,
      missingPlaceholders: a.missingPlaceholders ?? 0,
    })),
  };
  fs.writeFileSync(SYNC_REPORT_PATH, JSON.stringify(slim, null, 2), 'utf8');
}

function appendLog(data) {
  const mislabeled = data.actions.filter(
    (a) => a.type === 'preserve-and-translate' || a.type === 'conflict' || a.type === 'preserve-and-translate-en',
  );
  const toTranslate = data.actions.filter((a) => a.willTranslate);

  const lines = [];
  lines.push(`## ${data.now} — mode \`${data.mode}\` (effective \`${data.effectiveMode}\`)`);
  lines.push('');
  lines.push(
    `Engine: \`${data.engine}\` · API key: ${data.hasEngine ? 'present' : 'absent'} · ` +
      `files scanned: ${data.actions.length}`,
  );
  lines.push('');
  lines.push(
    `Summary — up-to-date: ${data.summary.upToDate}, translated: ${data.summary.translated}, ` +
      `preserved: ${data.summary.preserved}, conflicts: ${data.summary.conflicts}, ` +
      `planned: ${data.summary.planned}`,
  );
  lines.push('');

  if (mislabeled.length) {
    lines.push('### Language mismatches / preservation');
    lines.push('');
    lines.push('| File | en lang | vi lang | Action | Note |');
    lines.push('|------|---------|---------|--------|------|');
    for (const a of mislabeled) {
      lines.push(
        `| \`${a.rel}\` | ${a.enLang ?? '—'} | ${a.viLang ?? '—'} | ${a.type} | ${
          a.preservedTo ? `preserved → \`${a.preservedTo}\`` : a.reason
        } |`,
      );
    }
    lines.push('');
  }

  if (toTranslate.length) {
    lines.push('### Pending / performed translations');
    lines.push('');
    lines.push('| File | Direction | Reason |');
    lines.push('|------|-----------|--------|');
    for (const a of toTranslate) {
      lines.push(`| \`${a.rel}\` | ${a.sourceLocale} → ${a.targetLocale} | ${a.reason} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  const header =
    '# Docs i18n Sync Log\n\n' +
    'Append-only history of automated EN ⇄ VI documentation syncs. ' +
    'Each run records language detection, preserved content and translation actions ' +
    'so no source content is silently lost.\n\n';

  let prev = '';
  if (fs.existsSync(SYNC_LOG_PATH)) {
    prev = readFile(SYNC_LOG_PATH).replace(header, '');
  }
  ensureDir(SYNC_LOG_PATH);
  fs.writeFileSync(SYNC_LOG_PATH, header + lines.join('\n') + '\n' + prev, 'utf8');
}

main().catch((err) => {
  console.error('[docs-i18n] failed:', err);
  process.exit(1);
});
