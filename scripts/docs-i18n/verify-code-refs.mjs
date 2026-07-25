#!/usr/bin/env node
// Verify that a doc's code-facing claims still hold against the source tree.
//
// WHY THIS EXISTS
// ---------------
// `sync.mjs` and `stamp-pair.mjs` only ever compare *hashes* between the en/vi
// pair. A pair can therefore be stamped "in sync" while both sides confidently
// document a file, endpoint or env var the code no longer has — the two
// translations agree with each other and are wrong together. Hash equality is
// not correctness, and nothing should be marked as a full match on hash alone.
//
// This script is the missing half: it extracts the claims a doc makes about the
// repository and checks each one.
//
//   1. file references  — `apps/cms/src/middleware/auth.ts` must exist
//   2. env vars         — `LUMIBASE_FOO` must be read somewhere in the source
//   3. API routes       — `GET /api/v1/items/...` must have a matching mount
//
// DESIGN NOTE: precision over recall. A verifier that cries wolf gets ignored,
// so a claim is only asserted when it is unambiguously about THIS repo. Anything
// that could legitimately point outside it — a user's Next.js app (`app/page.tsx`),
// an IDE config (`.cursor/mcp.json`), a generated artifact (`./lumibase-types.ts`),
// a URL path — is skipped rather than guessed at. Skipped claims are counted and
// reported so the blind spot stays visible instead of reading as a pass.
//
// Usage:
//   node scripts/docs-i18n/verify-code-refs.mjs                 # every doc
//   node scripts/docs-i18n/verify-code-refs.mjs features/x.md   # one rel (both locales)
//   node scripts/docs-i18n/verify-code-refs.mjs --json          # machine-readable
//
// Exit code: 0 = no findings, 1 = findings, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { LOCALES, DOCS_ROOT, REPO_ROOT } from './config.mjs';

const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const RELS = ARGS.filter((a) => !a.startsWith('--'));

/** Top-level dirs that make a path reference unambiguously about this repo. */
const REPO_ROOTS = [
  'apps/',
  'packages/',
  'scripts/',
  'docs/',
  'docker/',
  '.github/',
  '.kiro/',
  'e2e/',
];

/** Source trees searched for env-var reads and route mounts. */
const SOURCE_DIRS = ['apps', 'packages', 'scripts', 'docker', '.github'];
const SOURCE_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.yml', '.yaml', '.toml', '.json', '.sh', '.example'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'build', '.next', 'coverage']);

/**
 * Env-var families the docs are expected to keep honest. Deliberately an
 * allowlist: a bare `[A-Z_]+` pattern would match prose acronyms and SQL
 * keywords inside code fences and drown the real findings.
 */
const ENV_PATTERN =
  /`(LUMIBASE_[A-Z0-9_]+|VAPID_[A-Z0-9_]+|CF_ACCESS_[A-Z0-9_]+|STUDIO_[A-Z0-9_]+|FRONTEND_[A-Z0-9_]+|REFRESH_COOKIE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|GITHUB_[A-Z0-9_]+|GITLAB_[A-Z0-9_]+|CLOUDFLARE_[A-Z0-9_]+|WORKERS_AI_[A-Z0-9_]+|VERTEX_[A-Z0-9_]+|OPENAI_API_KEY|GEMINI_API_KEY|NVIDIA_[A-Z0-9_]+|JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL|CORS_ALLOWED_ORIGINS|METRICS_TOKEN|SENTRY_[A-Z0-9_]+)`/g;

const FILE_REF_PATTERN = /`([a-zA-Z0-9_./@-]+\.(?:ts|tsx|mjs|sql|yaml|yml))`/g;

const ROUTE_PATTERN = /(?:GET|POST|PATCH|PUT|DELETE)\s+(\/api\/v1\/[A-Za-z0-9/_:{}.-]+)/g;

/**
 * Routes written relative to the API root — docs frequently show
 * `POST /access/grants` rather than the full `/api/v1/...`. Excluding `/api/`
 * keeps this from double-matching {@link ROUTE_PATTERN}. Without this pattern a
 * doc that documents its endpoints in the shorter form yields zero assertable
 * claims and passes verification without anything actually being checked.
 */
const API_RELATIVE_ROUTE_PATTERN =
  /(?:^|\s|`)(?:GET|POST|PATCH|PUT|DELETE)\s+(\/(?!api\/)[a-z][A-Za-z0-9/_:{}.-]*)/g;

/**
 * Routes in markdown tables — `| \`POST\` | \`/api/v1/x\` |`. The method and the
 * path sit in separate backtick spans, so neither pattern above sees them, which
 * left the largest API doc in the repo (`api/hono-api-spec.md`, ~156 routes in
 * table form) almost entirely unchecked.
 */
const TABLE_ROUTE_PATTERN =
  /`(?:GET|POST|PATCH|PUT|DELETE)`\s*\|\s*`(\/[A-Za-z0-9/_:{}.-]+)`/g;

/** Example values in docs — an ID stands in for real data, not a real mount. */
const EXAMPLE_ID = /(?:^|\/)(?:[a-z]{2,4}_[A-Za-z0-9]{6,}|\d{4,})(?:\/|$)/;

let sourceCorpus = null;
function corpus() {
  if (sourceCorpus != null) return sourceCorpus;
  const parts = [];
  for (const base of SOURCE_DIRS) {
    const abs = path.join(REPO_ROOT, base);
    if (!fs.existsSync(abs)) continue;
    walk(abs, (file) => {
      if (!SOURCE_EXTS.includes(path.extname(file))) return;
      try {
        parts.push(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable file — nothing to assert from it */
      }
    });
  }
  sourceCorpus = parts.join('\n');
  return sourceCorpus;
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(path.join(dir, entry.name));
    }
  }
}

/** Strip fenced code blocks that are illustrative output rather than claims. */
function stripIgnorableFences(body) {
  // Keep the text — we still want refs inside shell/ts examples — but drop
  // blocks explicitly marked as output or as a user-side file tree.
  return body.replace(/```(?:text|txt|tree|output)\n[\s\S]*?```/g, '');
}

/**
 * A path reference is only asserted when it is repo-rooted. Relative refs are
 * resolved against a small set of plausible bases first; if one hits, the claim
 * is satisfied. Otherwise it is SKIPPED, not failed — `app/page.tsx` in a
 * Next.js integration guide is about the reader's project, not ours.
 */
const RELATIVE_BASES = [
  'packages/database/',
  'apps/cms/src/',
  'apps/studio/src/',
  'packages/',
  'apps/',
];

function checkFileRef(ref) {
  if (/^(?:https?:|\/|@)/.test(ref) || ref.startsWith('./')) return { verdict: 'skip' };
  if (REPO_ROOTS.some((r) => ref.startsWith(r))) {
    return fs.existsSync(path.join(REPO_ROOT, ref))
      ? { verdict: 'ok' }
      : { verdict: 'fail', detail: 'file does not exist' };
  }
  for (const base of RELATIVE_BASES) {
    if (fs.existsSync(path.join(REPO_ROOT, base + ref))) return { verdict: 'ok' };
  }
  return { verdict: 'skip' };
}

function checkEnvVar(name) {
  return corpus().includes(name)
    ? { verdict: 'ok' }
    : { verdict: 'fail', detail: 'not read anywhere in apps/, packages/, scripts/, docker/' };
}

function checkRoute(route) {
  if (EXAMPLE_ID.test(route)) return { verdict: 'skip' };
  const segments = route
    .replace(/^\/api\/v1\//, '/')
    .split('/')
    .filter((s) => s && !s.startsWith(':') && !s.startsWith('{'));
  if (segments.length === 0) return { verdict: 'skip' };
  // Match the mount prefix, not the full path: routers register `/items` and
  // handlers add `/:collection`, so the full string never appears verbatim.
  const head = segments.slice(0, 2);
  const missing = head.filter((s) => !corpus().includes(s));
  return missing.length === 0
    ? { verdict: 'ok' }
    : { verdict: 'fail', detail: `no mount found for "${missing.join('/')}"` };
}

const CHECKS = [
  { kind: 'file', pattern: FILE_REF_PATTERN, run: checkFileRef },
  { kind: 'env', pattern: ENV_PATTERN, run: checkEnvVar },
  { kind: 'route', pattern: ROUTE_PATTERN, run: checkRoute },
  { kind: 'route', pattern: API_RELATIVE_ROUTE_PATTERN, run: checkRoute },
  { kind: 'route', pattern: TABLE_ROUTE_PATTERN, run: checkRoute },
];

/** Verify one doc file. Returns { findings, checked, skipped }. */
export function verifyDoc(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const body = stripIgnorableFences(raw);
  const findings = [];
  let checked = 0;
  let skipped = 0;
  const seen = new Set();

  for (const { kind, pattern, run } of CHECKS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(body)) !== null) {
      const claim = m[1];
      const key = `${kind}:${claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { verdict, detail } = run(claim);
      if (verdict === 'skip') {
        skipped += 1;
        continue;
      }
      checked += 1;
      if (verdict === 'fail') findings.push({ kind, claim, detail });
    }
  }
  return { findings, checked, skipped };
}

/**
 * A doc with zero assertable claims cannot be *confirmed* by this script — it
 * merely has nothing this tooling knows how to test. Reporting that as a clean
 * pass is the exact failure mode the verifier exists to prevent, so callers get
 * an explicit `unverifiable` signal to act on (human review) instead of a green
 * light. `stampVerified` refuses to write a code-verified marker in this case.
 */
export function isUnverifiable(result) {
  return result.checked === 0;
}

/** Every doc rel present in at least one locale. */
function allRels() {
  const rels = new Set();
  for (const locale of LOCALES) {
    const root = path.join(DOCS_ROOT, locale);
    if (!fs.existsSync(root)) continue;
    walk(root, (file) => {
      if (file.endsWith('.md')) rels.add(path.relative(root, file));
    });
  }
  return [...rels].sort();
}

const targets = RELS.length > 0 ? RELS : allRels();
const results = [];

for (const rel of targets) {
  for (const locale of LOCALES) {
    const abs = path.join(DOCS_ROOT, locale, rel);
    if (!fs.existsSync(abs)) continue;
    const { findings, checked, skipped } = verifyDoc(abs);
    results.push({ rel, locale, checked, skipped, findings });
  }
}

const withFindings = results.filter((r) => r.findings.length > 0);
const unverifiable = results.filter((r) => isUnverifiable(r));
const totalFindings = withFindings.reduce((n, r) => n + r.findings.length, 0);
const totalChecked = results.reduce((n, r) => n + r.checked, 0);
const totalSkipped = results.reduce((n, r) => n + r.skipped, 0);

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        docs: results.length,
        claimsChecked: totalChecked,
        claimsSkipped: totalSkipped,
        findings: totalFindings,
        unverifiable: unverifiable.map((r) => `docs/${r.locale}/${r.rel}`),
        results: withFindings,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[verify-code-refs] docs=${results.length} claims=${totalChecked} skipped=${totalSkipped} ` +
      `findings=${totalFindings} unverifiable=${unverifiable.length}`,
  );
  for (const r of withFindings) {
    console.log(`\n  docs/${r.locale}/${r.rel}`);
    for (const f of r.findings) console.log(`    [${f.kind}] ${f.claim} — ${f.detail}`);
  }
  if (totalFindings === 0) console.log('  no stale code references found');
  if (unverifiable.length > 0 && RELS.length > 0) {
    console.log(
      `\n  NOTE: ${unverifiable.length} doc(s) make no claim this tooling can test — ` +
        'that is not a pass. They need human review before being marked verified:',
    );
    for (const r of unverifiable) console.log(`    docs/${r.locale}/${r.rel}`);
  }
}

process.exit(totalFindings > 0 ? 1 : 0);
