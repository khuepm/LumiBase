import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  accountSchema,
  evaluatePasswordRules,
  type PasswordRuleId,
} from '../account';

/**
 * Locks the `params.rule` ↔ `PasswordRuleId` contract that `account.ts`
 * documents but nothing enforced.
 *
 * The Zod 4 migration had to rewrite the length rule from `code: too_small`
 * (which carried no `params.rule`) to `code: custom`, and picked
 * `rule: 'minLength'` — a value absent from `PasswordRuleId` and disagreeing
 * with the parallel emitter in `modules/recovery/backup-code-page.tsx`, which
 * derives its `rule` from `evaluatePasswordRules()` keys. Nothing read
 * `params.rule` at runtime yet, so the drift was invisible.
 *
 * These tests fail on any future emitter that invents a rule id.
 */

const VALID: readonly PasswordRuleId[] = [
  'length',
  'lowercase',
  'uppercase',
  'digit',
  'special',
];

/**
 * `params` only exists on the `custom` member of Zod 4's issue union, so read
 * it off `unknown` rather than narrowing the union at every call site.
 */
function paramsOf(issue: unknown): Record<string, unknown> {
  const params = (issue as { params?: unknown }).params;
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

/** Every issue the schema emits against the `password` field. */
function passwordIssues(password: string) {
  const result = accountSchema.safeParse({
    email: 'admin@example.com',
    password,
    confirmPassword: password,
    firstName: 'Ada',
    lastName: 'Lovelace',
  });
  if (!result.success) {
    return result.error.issues.filter((issue) => issue.path[0] === 'password');
  }
  return [];
}

/** Collect the `params.rule` of every issue the schema emits for `password`. */
function emittedRules(password: string): string[] {
  return passwordIssues(password)
    .map((issue) => paramsOf(issue).rule)
    .filter((rule): rule is string => typeof rule === 'string');
}

describe('accountSchema password rule ids', () => {
  it('emits only ids declared by PasswordRuleId (Req 3.3)', () => {
    // A password that fails every class at once, so one parse exercises all
    // five emitters.
    const rules = emittedRules('a');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(VALID).toContain(rule);
    }
  });

  it('agrees with evaluatePasswordRules() on which rules failed', () => {
    // `evaluatePasswordRules` is what the inline ✓/✗ list and
    // `backup-code-page.tsx` both key off — the two must not diverge.
    for (const password of ['a', 'ALLUPPERCASE1!', 'nouppercase1!', 'NoDigits!!!!!', 'NoSpecial1234']) {
      const failing = Object.entries(evaluatePasswordRules(password))
        .filter(([, ok]) => !ok)
        .map(([rule]) => rule)
        .sort();
      expect(emittedRules(password).sort()).toEqual(failing);
    }
  });

  it('reports the length rule as `length`, carrying the minimum', () => {
    const short = 'Aa1!'.repeat(2); // 8 chars — under PASSWORD_MIN_LENGTH
    expect(short.length).toBeLessThan(PASSWORD_MIN_LENGTH);

    const issues = passwordIssues(short);
    const lengthIssue = issues.find((i) => paramsOf(i).rule === 'length');
    expect(lengthIssue).toBeDefined();
    expect(paramsOf(lengthIssue!).minimum).toBe(PASSWORD_MIN_LENGTH);
    // 'minLength' was the Zod 4 migration's original choice — it is not a
    // PasswordRuleId and must never come back.
    expect(issues.some((i) => paramsOf(i).rule === 'minLength')).toBe(false);
  });

  it('accepts a password satisfying every rule', () => {
    const strong = 'Str0ng!Passw0rd';
    expect(Object.values(evaluatePasswordRules(strong)).every(Boolean)).toBe(true);
    expect(emittedRules(strong)).toEqual([]);
  });
});
