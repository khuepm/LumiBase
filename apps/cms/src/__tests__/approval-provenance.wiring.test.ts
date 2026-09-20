import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every production call into the harness must carry approval provenance (#472 F2).
 *
 * ## The defect this locks down
 *
 * `executeApproved` refuses an approval whose requester is unknown
 * (`APPROVAL_PROVENANCE_MISSING`). That is right for rows parked before the
 * column existed — but a *new* park that forgets to pass the principal writes a
 * row indistinguishable from those, and the refusal tells the operator to
 * "re-request the action". Re-requesting down the same path hits the same wall,
 * so the work is not blocked, it is impossible.
 *
 * It happened on exactly one of four call sites: `POST /ai/chat` answered inline
 * passed provenance, the same endpoint answered through the queue
 * (`Prefer: respond-async`) did not. One endpoint, two paths, picked by a header
 * — the same shape as the RBAC split that `ai-chat-run-worker` already carries a
 * comment about. A behavioural test on the sync path could not have caught it.
 *
 * ## Why a source scan
 *
 * The failure mode is a *missing argument*, and the argument is optional by
 * necessity: the type cannot require it, because a legacy queued job has no
 * principal to name. So the type system will not catch the next one either, and
 * a behavioural test only covers the paths someone thought to write. This scan
 * covers the ones nobody thought about, which is where the bug was.
 *
 * Evidence class: reads the real source files. No DB, no network.
 *
 * **Validates: #472 F2 — no park path can create an unapprovable approval**
 */

const SRC = join(__dirname, '..');

/**
 * Production files that drive the harness. Listed rather than globbed so that
 * ADDING a call site is a deliberate act: a new file has to be named here, which
 * is the moment to ask whether it passes provenance.
 */
const HARNESS_CALL_SITES = [
  'routes/ai.ts',
  'routes/mcp.ts',
  'services/ai-chat-run-worker.ts',
  'services/agent-run-worker.ts',
] as const;

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/**
 * Source with comments blanked out.
 *
 * `governed-capabilities.ts` explains the old bug by quoting
 * `harness.execute(..., auth.roles ?? [])` in a docblock. Scanning raw text would
 * flag it as a call site and then demand provenance from prose, so the scan below
 * would have to be loosened to pass — and a loosened scan is how this class of
 * guard stops firing. Blanking comments keeps it strict instead.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/**
 * The text of one call, from `harness.execute(` to its matching `)`.
 *
 * A fixed-size window was the first attempt and it was wrong in both directions:
 * too small to clear the explanatory comments these call sites carry, and large
 * enough to spill into the next call, where a neighbour's provenance would
 * satisfy the assertion. Balancing parentheses reads exactly one call.
 */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe('approval provenance is wired at every harness call site', () => {
  it.each(HARNESS_CALL_SITES)('%s passes requestedByPrincipal', (relative) => {
    const source = code(relative);
    const calls = [...source.matchAll(/harness\.execute\(/g)];
    expect(calls.length, `${relative} should still call harness.execute`).toBeGreaterThan(0);

    for (const call of calls) {
      expect(
        callText(source, call.index!),
        `${relative}: harness.execute at offset ${call.index} must pass requestedByPrincipal, ` +
          'or the approval it parks cannot be approved by anyone',
      ).toMatch(/requestedByPrincipal/);
    }
  });

  it('finds no unlisted production file calling harness.execute', async () => {
    // Guards the list itself: a new call site added elsewhere would otherwise be
    // silently outside this check — the same "guard that cannot fire" class the
    // backlog keeps recording.
    const { globSync } = await import('node:fs');
    const files = globSync('**/*.ts', { cwd: SRC })
      .filter((f) => !f.includes('__tests__') && !f.includes('test-utils'))
      .filter((f) => code(f).includes('harness.execute('));

    expect(new Set(files)).toEqual(new Set(HARNESS_CALL_SITES));
  });

  it('the async chat path binds provenance to the job principal, not the worker', () => {
    // Specific enough to fail if someone "fixes" the scan above by passing a
    // constant or the worker's own identity. The requester is whoever sent the
    // message, and that is only knowable from the job.
    const source = read('services/ai-chat-run-worker.ts');
    expect(source).toMatch(/requestedByPrincipal:\s*\{\s*kind:\s*'principal',\s*ref:\s*job\.principal\s*\}/);
  });
});
