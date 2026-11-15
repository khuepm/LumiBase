// Doc/code drift analysis shared by the PR gate (`gate-code-drift.mjs`) and the
// self-heal fixers (`self-heal.mjs`) — issue #756.
//
// THE QUESTION
// ------------
// `verify-code-refs.mjs` answers "is every claim in this doc true of the tree?".
// A PR needs two narrower answers on top of that:
//
//   1. WHICH docs could this change have made stale? (the changed-file -> doc
//      mapping, so the gate is scoped to what the PR touched), and
//   2. WHAT changed underneath each stale claim — a file moved, a route segment
//      renamed, an env var or exported symbol renamed or removed — so the
//      failure points at a cause, and so the mechanical cases can be rewritten
//      without a human.
//
// Everything here is deterministic: string extraction from source text plus git
// rename detection. There is no model call and no translation anywhere in this
// pipeline (docs/.i18n/TASKS.md §6). A rename is only reported as a rename when
// it is UNAMBIGUOUS — one removal paired with exactly one addition in the same
// file. Anything else is reported as "removed" and left to a human.

import { ENV_PATTERN, RELATIVE_BASES, extractClaims, isRepoRooted, routeSegments } from './verify-code-refs.mjs';
import { diffNameStatus, isSourcePath, readBlobs } from './git-tree.mjs';

// ---------------------------------------------------------------------------
// Extraction from source text (pure)
// ---------------------------------------------------------------------------

/**
 * Names a TS/JS module exports. Covers declarations and `export { a, b as c }`
 * lists; deliberately ignores `export default` (it has no name a doc can cite)
 * and `export * from` (the names live in another file, which is checked there).
 */
export function extractExports(src) {
  const names = new Set();
  const DECL =
    /^\s*export\s+(?:declare\s+)?(?:default\s+(?=(?:async\s+)?function\s+\w|class\s+\w))?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = DECL.exec(src)) !== null) names.add(m[1]);
  const LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm;
  while ((m = LIST.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  return names;
}

/**
 * Route literals a Hono-style router registers, as `METHOD path` strings
 * (`ROUTE /webhooks` for `.route()`/`.basePath()` mounts).
 */
export function extractRoutes(src) {
  const routes = new Set();
  const RE = /\.(get|post|put|patch|delete|all|on|route|basePath)\(\s*(['"`])(\/[^'"`\s]*)\2/g;
  let m;
  while ((m = RE.exec(src)) !== null) {
    const method = ['route', 'basePath'].includes(m[1]) ? 'ROUTE' : m[1].toUpperCase();
    routes.add(`${method} ${m[3]}`);
  }
  return routes;
}

/** Env-var names (the families the verifier tracks) that appear in source. */
export function extractEnvNames(src) {
  const body = ENV_PATTERN.source.replace(/^`\(/, '').replace(/\)`$/, '');
  const RE = new RegExp(`(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`, 'g');
  return new Set(src.match(RE) ?? []);
}

/**
 * Pair removed names with added names when that pairing is unambiguous: exactly
 * one of each. Two removed + two added could be a swap, a split or unrelated
 * edits; guessing there would write a wrong name into the docs, so it yields
 * no pairs and every removal stays a plain removal.
 * @returns {[string, string][]}
 */
export function pairRenames(removed, added) {
  return removed.length === 1 && added.length === 1 ? [[removed[0], added[0]]] : [];
}

/**
 * Pair removed route literals with added ones. A pair needs the same method and
 * the same number of segments, differing in exactly one literal segment, and
 * must be the only such candidate in both directions. Returns segment-level
 * renames (`webhooks` -> `hooks`), which is the granularity the verifier checks
 * mounts at.
 * @returns {{ from: string, to: string, fromRoute: string, toRoute: string }[]}
 */
export function pairRouteRenames(removed, added) {
  const split = (r) => {
    const [method, p] = r.split(' ');
    return { method, segs: p.split('/').filter(Boolean) };
  };
  const diffSeg = (a, b) => {
    if (a.method !== b.method || a.segs.length !== b.segs.length) return null;
    const idx = [];
    a.segs.forEach((s, i) => {
      if (s !== b.segs[i]) idx.push(i);
    });
    if (idx.length !== 1) return null;
    const i = idx[0];
    if (/^[:{$*]/.test(a.segs[i]) || /^[:{$*]/.test(b.segs[i])) return null;
    return { from: a.segs[i], to: b.segs[i] };
  };
  const out = [];
  for (const r of removed) {
    const ra = split(r);
    const cands = added.filter((a) => diffSeg(ra, split(a)));
    if (cands.length !== 1) continue;
    const back = removed.filter((x) => diffSeg(split(x), split(cands[0])));
    if (back.length !== 1) continue;
    const d = diffSeg(ra, split(cands[0]));
    out.push({ ...d, fromRoute: r, toRoute: cands[0] });
  }
  return out;
}

const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
const wordIn = (text, word) =>
  new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`).test(text);

// ---------------------------------------------------------------------------
// Change set between two revisions
// ---------------------------------------------------------------------------

/**
 * Everything a doc could be stale against, between `base` and `head`.
 *
 * `baseTree`/`headTree` are `gitTree`/`fsTree` views (only `corpus()` is used
 * here); file contents come from git so the head side is the committed
 * revision, not whatever is in the working copy.
 *
 * @returns {{
 *   base: string, head: string,
 *   changed: { status: string, path: string, from?: string }[],
 *   moved: Map<string, string>,        // old path -> new path (git rename)
 *   deleted: Set<string>,
 *   touched: Set<string>,              // every base- and head-side path in the diff
 *   symbols: { file: string, headFile: string|null, name: string, to: string|null }[],
 *   routes:  { file: string, segment: string, to: string|null, fromRoute: string, toRoute: string|null }[],
 *   env:     { file: string, name: string, to: string|null }[],
 * }}
 */
export function computeChangeSet({ cwd, base, head, baseTree, headTree }) {
  const changed = diffNameStatus(cwd, base, head);
  const moved = new Map();
  const deleted = new Set();
  const touched = new Set();
  for (const c of changed) {
    touched.add(c.path);
    if (c.from) touched.add(c.from);
    if (c.status === 'R') moved.set(c.from, c.path);
    if (c.status === 'D') deleted.add(c.path);
  }

  // Source files whose text can lose an export / route / env read.
  const pairs = changed
    .filter((c) => c.status !== 'A')
    .map((c) => ({ baseFile: c.from ?? c.path, headFile: c.status === 'D' ? null : c.path }))
    .filter((p) => isSourcePath(p.baseFile));
  const baseBlobs = readBlobs(cwd, base, pairs.map((p) => p.baseFile));
  const headBlobs = readBlobs(cwd, head, pairs.filter((p) => p.headFile).map((p) => p.headFile));
  const headCorpus = headTree.corpus();

  const symbols = [];
  const routes = [];
  const env = [];
  for (const { baseFile, headFile } of pairs) {
    const before = baseBlobs.get(baseFile) ?? '';
    const after = headFile ? (headBlobs.get(headFile) ?? '') : '';

    // Exported symbols: gone from this file AND not referenced anywhere at head.
    // A symbol that still appears in the source was moved or un-exported, not
    // renamed away, and a doc naming it may well still be right.
    const exBefore = extractExports(before);
    const exAfter = extractExports(after);
    const exRemoved = minus(exBefore, exAfter).filter((n) => !wordIn(headCorpus, n));
    const exAdded = minus(exAfter, exBefore);
    const exRenames = new Map(pairRenames(exRemoved, exAdded));
    for (const name of exRemoved) {
      symbols.push({ file: baseFile, headFile, name, to: exRenames.get(name) ?? null });
    }

    // Route literals: segment-level renames; plain removals keep the segment
    // that disappeared from the source entirely.
    const rtBefore = extractRoutes(before);
    const rtAfter = extractRoutes(after);
    const rtRemoved = minus(rtBefore, rtAfter);
    const rtAdded = minus(rtAfter, rtBefore);
    const renamedRoutes = new Set();
    for (const r of pairRouteRenames(rtRemoved, rtAdded)) {
      if (headCorpus.includes(r.from)) continue; // segment still mounted elsewhere
      renamedRoutes.add(r.fromRoute);
      routes.push({ file: baseFile, segment: r.from, to: r.to, fromRoute: r.fromRoute, toRoute: r.toRoute });
    }
    for (const r of rtRemoved) {
      if (renamedRoutes.has(r)) continue;
      for (const seg of routeSegments(r.split(' ')[1])) {
        if (headCorpus.includes(seg)) continue;
        if (routes.some((x) => x.segment === seg)) continue;
        routes.push({ file: baseFile, segment: seg, to: null, fromRoute: r, toRoute: null });
      }
    }

    // Env vars: no longer read anywhere at head.
    const envBefore = extractEnvNames(before);
    const envAfter = extractEnvNames(after);
    const envRemoved = minus(envBefore, envAfter).filter((n) => !headCorpus.includes(n));
    const envAdded = minus(envAfter, envBefore);
    const envRenames = new Map(pairRenames(envRemoved, envAdded));
    for (const name of envRemoved) env.push({ file: baseFile, name, to: envRenames.get(name) ?? null });
  }

  return { base, head, changed, moved, deleted, touched, symbols, routes, env };
}

// ---------------------------------------------------------------------------
// Changed files -> docs that cite them
// ---------------------------------------------------------------------------

/** Doc rel for a changed path under docs/<locale>/, else null. */
export function docRelOf(p) {
  return /^docs\/(?:en|vi)\/(.+\.md)$/.exec(p)?.[1] ?? null;
}

/**
 * Repo paths a file claim can refer to. Repo-rooted claims are themselves;
 * relative ones (`middleware/auth.ts`) are tried against the same bases the
 * verifier resolves them with, in either tree.
 */
export function candidatePaths(ref) {
  if (/^(?:https?:|\/|@)/.test(ref) || ref.startsWith('./')) return [];
  if (isRepoRooted(ref)) return [ref];
  return RELATIVE_BASES.map((b) => b + ref);
}

/** Code spans (outside fenced blocks), with 1-based line numbers. */
export function codeSpans(raw) {
  const lines = raw.split('\n');
  const out = [];
  let inFence = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const RE = /`([^`\n]+)`/g;
    let m;
    while ((m = RE.exec(text)) !== null) out.push({ span: m[1], line: i + 1 });
  });
  return out;
}

/** The identifier a code span names, if it is shaped like `name`, `name()` or `name<T>`. */
export function spanIdentifier(span) {
  return /^([A-Za-z_$][\w$]*)(?:\(.*\)|<.*>)?$/.exec(span)?.[1] ?? null;
}

/**
 * Which docs this change could have made stale, and why.
 *
 * A doc is affected when it
 *   - was itself changed (either locale),
 *   - cites a changed, moved or deleted source file (by any file claim that
 *     resolves to it),
 *   - names an env var the change stopped reading,
 *   - claims a route whose literal segments include one the change removed, or
 *   - names, in a code span, an exported symbol removed from a file it cites.
 *
 * @param {{ rel: string, locale: string, raw: string }[]} docs  doc texts (head side)
 * @param changeSet  from computeChangeSet (only changed/touched/env/routes/symbols are read)
 * @returns {Map<string, string[]>} rel -> human-readable reasons
 */
export function mapChangesToDocs(docs, changeSet) {
  const affected = new Map();
  const add = (rel, why) => {
    if (!affected.has(rel)) affected.set(rel, []);
    const list = affected.get(rel);
    if (!list.includes(why)) list.push(why);
  };

  for (const c of changeSet.changed) {
    for (const p of [c.path, c.from].filter(Boolean)) {
      const rel = docRelOf(p);
      if (rel) add(rel, `doc changed: ${p}`);
    }
  }

  const removedEnv = new Map(changeSet.env.map((e) => [e.name, e]));
  const removedSegs = new Map(changeSet.routes.map((r) => [r.segment, r]));
  const sourceTouched = [...changeSet.touched].filter((p) => !p.startsWith('docs/'));
  const touchedSet = new Set(sourceTouched);

  for (const doc of docs) {
    const claims = extractClaims(doc.raw);
    for (const c of claims) {
      if (c.kind === 'file') {
        for (const p of candidatePaths(c.claim)) {
          if (touchedSet.has(p)) {
            add(doc.rel, `cites changed file ${p}`);
          }
        }
      } else if (c.kind === 'env' && removedEnv.has(c.claim)) {
        add(doc.rel, `names env var ${c.claim}, no longer read (${removedEnv.get(c.claim).file})`);
      } else if (c.kind === 'route') {
        for (const seg of routeSegments(c.claim)) {
          if (removedSegs.has(seg)) {
            add(doc.rel, `route ${c.claim} uses segment "${seg}" removed from ${removedSegs.get(seg).file}`);
          }
        }
      }
    }
    for (const s of symbolFindings(doc.raw, changeSet)) {
      add(doc.rel, `names ${s.claim}, an export removed from ${s.file}`);
    }
  }
  return affected;
}

/**
 * Stale exported-symbol claims: a code span naming a symbol that the change
 * removed from a file THIS doc cites. Requiring the citation keeps a short
 * name like `parse` from matching every doc that happens to say `parse`.
 *
 * @param {Set<string>} [cited] base-side paths the doc cites; computed when omitted
 */
export function symbolFindings(raw, changeSet, cited) {
  if (changeSet.symbols.length === 0) return [];
  let citedPaths = cited;
  if (!citedPaths) {
    citedPaths = new Set();
    for (const c of extractClaims(raw)) {
      if (c.kind !== 'file') continue;
      for (const p of candidatePaths(c.claim)) citedPaths.add(p);
    }
  }
  const out = [];
  const byName = new Map();
  for (const s of changeSet.symbols) {
    if (citedPaths.has(s.file) || (s.headFile && citedPaths.has(s.headFile))) byName.set(s.name, s);
  }
  if (byName.size === 0) return out;
  const seen = new Map();
  for (const { span, line } of codeSpans(raw)) {
    const id = spanIdentifier(span);
    if (!id || !byName.has(id)) continue;
    if (seen.has(id)) {
      seen.get(id).lines.push(line);
      continue;
    }
    const s = byName.get(id);
    const finding = {
      kind: 'symbol',
      claim: id,
      file: s.file,
      to: s.to,
      detail: s.to
        ? `export renamed to \`${s.to}\` in ${s.headFile ?? s.file}`
        : `no longer exported by ${s.file} and not referenced anywhere in the source`,
      line,
      lines: [line],
    };
    seen.set(id, finding);
    out.push(finding);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Explaining a finding
// ---------------------------------------------------------------------------

/**
 * Follow renames from `from` until a path that exists in `tree`.
 * @param {Map<string,string>|[string,string][]} renames
 */
export function followMoves(from, renames, tree) {
  const map = renames instanceof Map ? renames : new Map(renames);
  let cur = from;
  for (let i = 0; i < 32 && map.has(cur); i += 1) {
    cur = map.get(cur);
    if (tree.exists(cur)) return cur;
  }
  return null;
}

/**
 * Attach a cause (and, when mechanical, a replacement) to a verifier finding.
 * The cause is what CI prints after the claim; `fix` is what self-heal applies.
 *
 * @param finding   from verifyText (kind file|env|route) or symbolFindings
 * @param changeSet from computeChangeSet, or null outside a diff
 * @param {{ tree: object, history?: [string,string][] }} ctx
 * @returns {{ cause: string, fix: null | { from: string, to: string, scope: string } }}
 */
export function explainFinding(finding, changeSet, { tree, history = [] }) {
  const cs = changeSet ?? { moved: new Map(), deleted: new Set(), env: [], routes: [], symbols: [] };
  if (finding.kind === 'file') {
    const viaDiff = cs.moved.has(finding.claim) ? followMoves(finding.claim, cs.moved, tree) : null;
    const target = viaDiff ?? followMoves(finding.claim, history, tree);
    if (target) {
      return {
        cause: `file moved to \`${target}\`${viaDiff ? ' in this change' : ' (git rename history)'}`,
        fix: { from: finding.claim, to: target, scope: 'path' },
      };
    }
    if (cs.deleted.has(finding.claim)) return { cause: 'file deleted in this change', fix: null };
    return { cause: 'file does not exist', fix: null };
  }
  if (finding.kind === 'env') {
    const e = cs.env.find((x) => x.name === finding.claim);
    if (e?.to) {
      return {
        cause: `env var renamed to \`${e.to}\` in ${e.file}`,
        fix: { from: finding.claim, to: e.to, scope: 'word' },
      };
    }
    if (e) return { cause: `env var no longer read (removed from ${e.file})`, fix: null };
    return { cause: 'env var not read anywhere in the source', fix: null };
  }
  if (finding.kind === 'route') {
    const missing = finding.missing ?? routeSegments(finding.claim).slice(0, 2);
    const parts = missing.map((seg) => cs.routes.find((r) => r.segment === seg) ?? { segment: seg });
    if (parts.length > 0 && parts.every((p) => p.to)) {
      let to = finding.claim;
      for (const p of parts) {
        to = to.replace(new RegExp(`/${escapeRe(p.segment)}(?![A-Za-z0-9_-])`), `/${p.to}`);
      }
      return {
        cause: parts.map((p) => `route segment "${p.segment}" renamed to "${p.to}" in ${p.file}`).join('; '),
        fix: { from: finding.claim, to, scope: 'route' },
      };
    }
    const removed = parts.filter((p) => p.file);
    if (removed.length > 0) {
      return {
        cause: removed.map((p) => `route \`${p.fromRoute}\` removed from ${p.file}`).join('; '),
        fix: null,
      };
    }
    return { cause: finding.detail ?? 'no mount found', fix: null };
  }
  if (finding.kind === 'symbol') {
    return {
      cause: finding.detail,
      fix: finding.to ? { from: finding.claim, to: finding.to, scope: 'span' } : null,
    };
  }
  return { cause: finding.detail ?? 'stale', fix: null };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { escapeRe };
