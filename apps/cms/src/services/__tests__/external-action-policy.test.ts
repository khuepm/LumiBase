import { describe, expect, it } from 'vitest';
import type { ExternalActionFacts, ExternalActionPolicy } from '@lumibase/contracts/platform';
import {
  computeConstitutionHash,
  evaluateRuleEvaluator,
  type ConstitutionEvaluator,
  type EvaluatorResult,
} from '../constitution-service';
import {
  evaluateExternalActionPolicy,
  externalActionPolicyRecord,
  type ConstitutionSource,
} from '../external-action-policy';

/**
 * The pre-execution policy decision, as a pure function of the tool's policy,
 * the call and the site's constitution versions. The harness wiring and the
 * audit rows are covered against PostgreSQL in
 * `external-action-tools.db.integration.test.ts`.
 */

const FACTS: ExternalActionFacts = {
  tool: 'fixtureNotify',
  capability: 'fixture:notify',
  risk: 'medium',
  blastRadius: 'single',
  agentName: 'fixture-role',
  agentRole: 'fixture-role',
  intentId: 'intent_1',
  runId: 'run_1',
};

const RULES: ConstitutionEvaluator[] = [
  { id: 'intent-linked', type: 'rule', blocking: true, rule: { field: 'intentId', op: 'required' } },
  { id: 'no-token', type: 'rule', blocking: true, rule: { field: 'body', op: 'not_contains', value: 'tok_' } },
  {
    id: 'polite',
    type: 'rule',
    blocking: true,
    onViolation: 'require_approval',
    rule: { field: 'body', op: 'contains', value: 'please' },
  },
  { id: 'short', type: 'rule', blocking: false, rule: { field: 'body', op: 'max_length', value: 20 } },
];

interface Version {
  hash: string;
  evaluators: ConstitutionEvaluator[];
}

async function version(evaluators: ConstitutionEvaluator[]): Promise<Version> {
  return { hash: await computeConstitutionHash(evaluators), evaluators };
}

function source(active: Version | null, ...others: Version[]): ConstitutionSource & { evaluated: number } {
  const all = [...(active ? [active] : []), ...others];
  const self = {
    evaluated: 0,
    getActive: async () => active ?? undefined,
    getByHash: async (hash: string) => all.find((entry) => entry.hash === hash),
    evaluate: async (evaluators: readonly ConstitutionEvaluator[], record: Record<string, unknown>) => {
      self.evaluated += 1;
      return evaluators.map((evaluator): EvaluatorResult =>
        evaluator.type === 'rule'
          ? evaluateRuleEvaluator(evaluator, record)
          : {
              evaluatorId: evaluator.id,
              type: 'llm_judge',
              blocking: evaluator.blocking !== false,
              status: 'error',
              message: 'LLM_NOT_CONFIGURED',
            },
      );
    },
  };
  return self;
}

const decide = (
  policy: ExternalActionPolicy | undefined,
  constitutions: ConstitutionSource,
  args: Record<string, unknown> = { body: 'please read' },
  pinnedHash: string | null = null,
  facts: ExternalActionFacts = FACTS,
) =>
  evaluateExternalActionPolicy({
    tool: { name: 'fixtureNotify', ...(policy ? { policy } : {}) },
    args,
    facts,
    pinnedHash,
    constitutions,
  });

describe('evaluateExternalActionPolicy — fail closed', () => {
  it('does not evaluate a tool that declares no policy, whatever the site has', async () => {
    const constitutions = source(await version(RULES));
    const verdict = await decide(undefined, constitutions);
    expect(verdict.outcome).toBe('not_evaluated');
    expect(constitutions.evaluated).toBe(0);
  });

  it('refuses a `required` tool on a site with no active constitution', async () => {
    const verdict = await decide({ constitution: 'required' }, source(null));
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_REQUIRED' });
  });

  it('refuses a `required` tool when the constitution was deactivated after the run pinned it', async () => {
    const pinned = await version(RULES);
    const verdict = await decide({ constitution: 'required' }, source(null, pinned), undefined, pinned.hash);
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_REQUIRED' });
  });

  it('lets an `if_active` tool through unevaluated on a site with no constitution', async () => {
    const verdict = await decide({ constitution: 'if_active' }, source(null));
    expect(verdict.outcome).toBe('not_evaluated');
  });

  it('refuses when the version in force is not one the tool accepts', async () => {
    const active = await version(RULES);
    const verdict = await decide(
      { constitution: 'required', constitutionHashes: [`sha256:${'0'.repeat(64)}`] },
      source(active),
    );
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_NOT_ACCEPTED', constitutionHash: active.hash });
  });

  it('refuses when the record builder throws', async () => {
    const verdict = await decide(
      {
        constitution: 'required',
        record: () => {
          throw new Error('boom');
        },
      },
      source(await version(RULES)),
    );
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'POLICY_RECORD_INVALID' });
    expect(verdict.message).not.toContain('boom');
  });

  it('refuses when a blocking evaluator errors, even one marked require_approval', async () => {
    const judge: ConstitutionEvaluator = {
      id: 'judge',
      type: 'llm_judge',
      blocking: true,
      onViolation: 'require_approval',
      prompt: 'PASS if polite.',
    };
    const verdict = await decide({ constitution: 'required' }, source(await version([...RULES, judge])));
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_VIOLATION' });
    expect(verdict.message).toContain('judge (error)');
  });
});

describe('evaluateExternalActionPolicy — verdicts', () => {
  it('passes when every blocking evaluator passes, and reports the non-blocking ones', async () => {
    const active = await version(RULES);
    const verdict = await decide({ constitution: 'required' }, source(active), { body: 'please read this long message' });
    expect(verdict.outcome).toBe('pass');
    expect(verdict.constitutionHash).toBe(active.hash);
    expect(verdict.evaluators).toContainEqual({ id: 'short', status: 'fail', blocking: false });
  });

  it('refuses a blocking violation and names the evaluator, not the content', async () => {
    const verdict = await decide({ constitution: 'required' }, source(await version(RULES)), {
      body: 'please use tok_abc123',
    });
    expect(verdict).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_VIOLATION' });
    expect(verdict.message).toContain('no-token');
    expect(verdict.message).not.toContain('tok_abc123');
  });

  it('routes to a human when only require_approval evaluators fail', async () => {
    const verdict = await decide({ constitution: 'required' }, source(await version(RULES)), { body: 'read now' });
    expect(verdict.outcome).toBe('require_approval');
    expect(verdict.message).toContain('polite');
  });

  it('a refusing violation wins over a require_approval one', async () => {
    const verdict = await decide({ constitution: 'required' }, source(await version(RULES)), { body: 'tok_x' });
    expect(verdict.outcome).toBe('refuse');
  });

  it('evaluates a pinned run against its pinned version, not the newer active one', async () => {
    const pinned = await version(RULES);
    const lenient = await version([{ id: 'anything', type: 'rule', blocking: false, rule: { field: 'x', op: 'required' } }]);
    const verdict = await decide({ constitution: 'required' }, source(lenient, pinned), { body: 'tok_x' }, pinned.hash);
    expect(verdict).toMatchObject({ outcome: 'refuse', constitutionHash: pinned.hash });
  });

  it('the harness facts reach the record and cannot be overwritten by the tool or the arguments', async () => {
    const verdict = await decide(
      { constitution: 'required', record: (args) => ({ ...args, intentId: '' }) },
      source(await version(RULES)),
      { body: 'please', intentId: '' },
    );
    expect(verdict.outcome).toBe('pass');
    const noIntent = await decide(
      { constitution: 'required' },
      source(await version(RULES)),
      { body: 'please', intentId: 'forged' },
      null,
      { ...FACTS, intentId: null },
    );
    expect(noIntent).toMatchObject({ outcome: 'refuse', code: 'CONSTITUTION_VIOLATION' });
    expect(noIntent.message).toContain('intent-linked');
  });
});

describe('externalActionPolicyRecord', () => {
  it('defaults to the arguments plus the facts', () => {
    expect(externalActionPolicyRecord({}, { body: 'hi' }, FACTS)).toEqual({ body: 'hi', ...FACTS });
  });

  it('uses the tool record builder, which sees frozen inputs', () => {
    const record = externalActionPolicyRecord(
      {
        policy: {
          constitution: 'required',
          record: (args, facts) => {
            expect(Object.isFrozen(args)).toBe(true);
            expect(Object.isFrozen(facts)).toBe(true);
            return { text: args['body'], role: facts.agentRole };
          },
        },
      },
      { body: 'hi' },
      FACTS,
    );
    expect(record).toMatchObject({ text: 'hi', role: 'fixture-role', tool: 'fixtureNotify' });
    expect(record).not.toHaveProperty('body');
  });

  it('refuses a builder that returns something other than an object', () => {
    expect(() =>
      externalActionPolicyRecord({ policy: { constitution: 'required', record: () => [] as never } }, {}, FACTS),
    ).toThrow(/plain object/);
  });
});
