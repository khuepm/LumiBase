// Read a committed revision of the repository with the same interface as
// `fsTree` in verify-code-refs.mjs, plus the small set of git queries the
// drift gate and the self-heal fixers need (#756).
//
// Why not `git worktree add <base>`: the gate only needs "does this path exist"
// and "the text of the source files" at the PR base. Reading both straight out
// of the object database is faster, leaves nothing on disk to clean up, and
// works in a CI clone without a second checkout.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { SOURCE_DIRS, SOURCE_EXTS, SKIP_DIRS } from './verify-code-refs.mjs';

const MAX_BUFFER = 512 * 1024 * 1024;

/** Run git in `cwd` and return stdout. Throws on a non-zero exit. */
export function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Resolve a ref to a full sha, or null when it does not exist in this clone. */
export function resolveRef(cwd, ref) {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

/** Every file path tracked at `ref`. */
export function listFiles(cwd, ref) {
  return git(cwd, ['ls-tree', '-r', '-z', '--name-only', ref])
    .split('\0')
    .filter(Boolean);
}

/** Text of `rel` at `ref`, or null when it does not exist there. */
export function showFile(cwd, ref, rel) {
  try {
    return git(cwd, ['show', `${ref}:${rel}`]);
  } catch {
    return null;
  }
}

/**
 * Read many blobs in one `git cat-file --batch` round trip.
 * @returns {Map<string, string>} path -> text
 */
export function readBlobs(cwd, ref, rels) {
  const out = new Map();
  if (rels.length === 0) return out;
  const buf = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: rels.map((r) => `${ref}:${r}`).join('\n') + '\n',
    maxBuffer: MAX_BUFFER,
  });
  let pos = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ')[2]);
    out.set(rel, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1; // trailing LF after each object
  }
  return out;
}

/** True when a repo-relative path would be part of the verifier's corpus. */
export function isSourcePath(rel) {
  const parts = rel.split('/');
  if (!SOURCE_DIRS.includes(parts[0])) return false;
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  return SOURCE_EXTS.includes(path.extname(rel));
}

/**
 * A source tree view of `ref`, shaped like `fsTree`: `exists(rel)` answers for
 * files and directories, `corpus()` is the concatenated text of every source
 * file the working-copy verifier would read.
 */
export function gitTree(cwd, ref) {
  const files = listFiles(cwd, ref);
  const fileSet = new Set(files);
  const dirSet = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i += 1) dirSet.add(parts.slice(0, i).join('/'));
  }
  let corpus = null;
  return {
    ref,
    files,
    exists(rel) {
      const clean = rel.replace(/\/+$/, '');
      return fileSet.has(clean) || dirSet.has(clean);
    },
    corpus() {
      if (corpus != null) return corpus;
      const blobs = readBlobs(cwd, ref, files.filter(isSourcePath));
      corpus = [...blobs.values()].join('\n');
      return corpus;
    },
    read(rel) {
      return fileSet.has(rel) ? showFile(cwd, ref, rel) : null;
    },
  };
}

/**
 * Parse `git diff --name-status -z -M` output.
 * @returns {{ status: string, path: string, from?: string }[]}
 */
export function parseNameStatus(raw) {
  const tokens = raw.split('\0').filter((t) => t !== '');
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[i++];
      const to = tokens[i++];
      out.push({ status: status[0], from, path: to });
    } else {
      out.push({ status: status[0], path: tokens[i++] });
    }
  }
  return out;
}

/** Files changed between two revisions, with rename detection. */
export function diffNameStatus(cwd, base, head) {
  return parseNameStatus(git(cwd, ['diff', '--name-status', '-z', '-M', base, head]));
}

/**
 * Every rename git can see in the reachable history of `head`, oldest first,
 * as `[from, to]` pairs. Used to follow a path a doc cites to where the file
 * lives now even when the move happened outside the range being healed.
 */
export function historyRenames(cwd, head = 'HEAD') {
  let raw;
  try {
    raw = git(cwd, ['log', '--reverse', '-M', '--diff-filter=R', '--name-status', '-z', '--format=', head]);
  } catch {
    return [];
  }
  return parseNameStatus(raw)
    .filter((e) => e.status === 'R')
    .map((e) => [e.from, e.path]);
}
