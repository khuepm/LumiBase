import { hasAgentToolSchema, validateAgentToolInput } from '@lumibase/contracts';

/**
 * Builds a minimal set of arguments that SATISFIES a skill's canonical input
 * schema (`@lumibase/contracts` → `AgentToolSchemas`).
 *
 * Why this exists. Several property tests drive `harness.execute()` with
 * randomly generated argument dictionaries because their subject is something
 * else entirely — risk classification, error propagation, approval bookkeeping.
 * Once the harness started enforcing the input contract (#454), random keys made
 * those probes bounce off validation before ever reaching the behaviour under
 * test. Handing them valid arguments keeps each property testing what it claims
 * to test, instead of accidentally re-testing validation.
 *
 * It is derived, not hand-maintained: values are proposed from a small candidate
 * list and accepted only when the real validator stops complaining about that
 * field. So a schema added later needs no edit here — and if none of the
 * candidates fit it, `g2-agent-tool-schemas.test.ts` fails loudly rather than
 * silently producing junk.
 */

/**
 * Candidate values, most specific first. `'posts'` satisfies the snake_case slug
 * pattern and any plain non-empty string; `'a@b.co'` covers email; `{}` covers
 * free-form record fields.
 */
const CANDIDATES: unknown[] = ['posts', 'a@b.co', {}, 'x', 1, true, []];

/**
 * @returns arguments accepted by the skill's canonical schema, or `{}` when the
 * skill has no canonical schema (nothing to satisfy).
 * @throws when no candidate can satisfy a required field — that is a signal to
 * extend `CANDIDATES`, not to loosen the schema.
 */
export function validArgsFor(skillName: string): Record<string, unknown> {
  if (!hasAgentToolSchema(skillName)) return {};

  const args: Record<string, unknown> = {};
  // Bounded: each pass fixes at least one top-level field or throws.
  for (let pass = 0; pass <= CANDIDATES.length * 32; pass += 1) {
    const verdict = validateAgentToolInput(skillName, args);
    if (verdict.ok) return args;

    const pending = verdict.issues.find((issue) => issue.path !== '' && !issue.path.includes('.'));
    if (pending === undefined) {
      throw new Error(
        `validArgsFor(${skillName}): cannot resolve issues ${JSON.stringify(verdict.issues)}`,
      );
    }

    const accepted = CANDIDATES.find((candidate) => {
      const probe = { ...args, [pending.path]: candidate };
      const result = validateAgentToolInput(skillName, probe);
      return result.ok || !result.issues.some((issue) => issue.path === pending.path);
    });
    if (accepted === undefined) {
      throw new Error(
        `validArgsFor(${skillName}): no candidate satisfies "${pending.path}" (${pending.message})`,
      );
    }
    args[pending.path] = accepted;
  }

  throw new Error(`validArgsFor(${skillName}): did not converge`);
}

/**
 * Arguments to send for a skill in a test that does not care about input shape:
 * the canonical-valid set when the skill has a schema, otherwise whatever the
 * caller generated.
 */
export function argsForProperty(
  skillName: string,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  return hasAgentToolSchema(skillName) ? validArgsFor(skillName) : generated;
}
