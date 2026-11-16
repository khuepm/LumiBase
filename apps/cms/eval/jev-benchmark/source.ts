/**
 * Source revision a benchmark report was produced from (#585).
 *
 * A report already pins the dataset (version + manifest hash), rubric,
 * protocol, seed, provider and model. It did not pin the code: the decision
 * provider, the prompt builder and the scoring all live in the repository, so
 * two reports with identical identities could come from different code and
 * nothing in either file said so. `commit` is the git `HEAD` of the checkout;
 * `dirty` is true when tracked or untracked files differ from it, so a number produced from
 * uncommitted changes is never mistaken for one produced from that commit.
 *
 * Both are `null` when they cannot be read (no git, not a checkout). That is
 * stated in the report notes rather than filled with a guess.
 */

import { execFileSync } from 'node:child_process';

export interface SourceRevision {
  commit: string | null;
  dirty: boolean | null;
}

export const UNKNOWN_SOURCE: SourceRevision = { commit: null, dirty: null };

export const UNKNOWN_SOURCE_NOTE =
  'Source revision unknown: the report was not produced from a git checkout, so it cannot be tied to a commit.';
export const DIRTY_SOURCE_NOTE =
  'Source revision dirty: tracked or untracked files differed from the recorded commit when this report was produced.';

export const UNKNOWN_DIRTY_NOTE =
  'Source revision may be dirty: the working tree state could not be read, so uncommitted changes cannot be ruled out.';

type Git = (args: string[]) => string;

const defaultGit =
  (cwd: string): Git =>
  (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Reads `HEAD` and the dirty flag. Never throws; unknown parts are `null`. */
export function readSourceRevision(cwd: string, git: Git = defaultGit(cwd)): SourceRevision {
  let commit: string | null;
  try {
    commit = git(['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) commit = null;
  } catch {
    return UNKNOWN_SOURCE;
  }
  if (commit === null) return UNKNOWN_SOURCE;
  let dirty: boolean | null;
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=normal']).trim().length > 0;
  } catch {
    dirty = null;
  }
  return { commit, dirty };
}

/** The notes a report carries for its source revision (none when it is a clean, known commit). */
export function sourceNotes(source: SourceRevision): string[] {
  if (source.commit === null) return [UNKNOWN_SOURCE_NOTE];
  if (source.dirty === true) return [DIRTY_SOURCE_NOTE];
  if (source.dirty === null) return [UNKNOWN_DIRTY_NOTE];
  return [];
}
