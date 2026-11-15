import { EXTERNAL_ACTION_FACT_KEYS, type ExternalActionFacts } from '@lumibase/contracts/platform';
import type { ConstitutionEvaluator, EvaluatorResult } from './constitution-service';
import type { ExternalActionToolDefinition } from './external-action-tools';

/**
 * Pre-execution policy for external-action tools.
 *
 * A tool that declares a `policy` has the site's constitution evaluated on a
 * flat record describing each call, before the harness decides anything else
 * about the call, and again before an approved call executes. The outcome is
 * one of:
 *
 * - `not_evaluated`: the tool declares no policy, or declares `if_active` on a
 *   site with no constitution. The call proceeds exactly as it did before
 *   policies existed.
 * - `pass`: every blocking evaluator passed.
 * - `require_approval`: the only blocking failures come from evaluators marked
 *   `onViolation: 'require_approval'`. The call may still run, but only after
 *   a human approves it, whatever the autonomy level.
 * - `refuse`: the call does not run. Fail-closed cases are refusals too: no
 *   active constitution under a `required` policy, a pinned version the tool
 *   does not accept, a record that cannot be built, an evaluator that errors.
 *
 * This module decides; it does not write. The harness records every outcome
 * in the external-action audit trail.
 */

export type ExternalActionPolicyCode =
  | 'CONSTITUTION_REQUIRED'
  | 'CONSTITUTION_NOT_ACCEPTED'
  | 'CONSTITUTION_VIOLATION'
  | 'POLICY_RECORD_INVALID';

/** One evaluator's verdict as it is audited: no message, so no call content. */
export interface AuditedEvaluatorResult {
  id: string;
  status: EvaluatorResult['status'];
  blocking: boolean;
}

export interface ExternalActionPolicyVerdict {
  outcome: 'not_evaluated' | 'pass' | 'require_approval' | 'refuse';
  code?: ExternalActionPolicyCode;
  /** Safe to return to the caller and to store: names evaluators, never quotes the call. */
  message?: string;
  /** The version the record was evaluated against, when one was. */
  constitutionHash: string | null;
  evaluators: AuditedEvaluatorResult[];
}

/** The two reads the gate needs from the constitution store. */
export interface ConstitutionSource {
  getActive(): Promise<{ hash: string } | undefined>;
  getByHash(hash: string): Promise<{ hash: string; evaluators: unknown } | undefined>;
  evaluate(evaluators: readonly ConstitutionEvaluator[], record: Record<string, unknown>): Promise<EvaluatorResult[]>;
}

const NOT_EVALUATED: ExternalActionPolicyVerdict = Object.freeze({
  outcome: 'not_evaluated',
  constitutionHash: null,
  evaluators: [],
}) as ExternalActionPolicyVerdict;

/**
 * The record the evaluators read: the tool's own record (default: the
 * arguments), then the harness's facts, which always win.
 */
export function externalActionPolicyRecord(
  tool: Pick<ExternalActionToolDefinition, 'policy'>,
  args: Record<string, unknown>,
  facts: ExternalActionFacts,
): Record<string, unknown> {
  const frozenFacts = Object.freeze({ ...facts });
  const built = tool.policy?.record ? tool.policy.record(Object.freeze({ ...args }), frozenFacts) : { ...args };
  if (!built || typeof built !== 'object' || Array.isArray(built)) {
    throw new Error('policy.record must return a plain object');
  }
  const record: Record<string, unknown> = { ...built };
  for (const key of EXTERNAL_ACTION_FACT_KEYS) record[key] = facts[key];
  return record;
}

function refuse(
  code: ExternalActionPolicyCode,
  message: string,
  constitutionHash: string | null,
  evaluators: AuditedEvaluatorResult[] = [],
): ExternalActionPolicyVerdict {
  return { outcome: 'refuse', code, message, constitutionHash, evaluators };
}

/**
 * Decides one call.
 *
 * `pinnedHash` is the constitution pinned to the run, or `null` when nothing
 * is pinned yet. A pinned run is evaluated against its pinned version even
 * after a newer one was activated (the run started under those rules), but a
 * `required` policy still refuses on a site that has no active version at all:
 * deactivating the constitution stops every governed call, including those of
 * runs already under way.
 */
export async function evaluateExternalActionPolicy(input: {
  tool: Pick<ExternalActionToolDefinition, 'name' | 'policy'>;
  args: Record<string, unknown>;
  facts: ExternalActionFacts;
  pinnedHash: string | null;
  constitutions: ConstitutionSource;
}): Promise<ExternalActionPolicyVerdict> {
  const policy = input.tool.policy;
  if (!policy) return NOT_EVALUATED;

  const active = await input.constitutions.getActive();
  if (!active) {
    if (policy.constitution === 'if_active' && !input.pinnedHash) return NOT_EVALUATED;
    return refuse(
      'CONSTITUTION_REQUIRED',
      `constitution_required: "${input.tool.name}" runs only on a site with an active constitution`,
      input.pinnedHash,
    );
  }

  const hash = input.pinnedHash ?? active.hash;
  if (policy.constitutionHashes && !policy.constitutionHashes.includes(hash)) {
    return refuse(
      'CONSTITUTION_NOT_ACCEPTED',
      `constitution_not_accepted: "${input.tool.name}" is not bound to constitution ${hash}`,
      hash,
    );
  }
  const version = await input.constitutions.getByHash(hash);
  if (!version || !Array.isArray(version.evaluators)) {
    return refuse('CONSTITUTION_REQUIRED', `constitution_required: constitution ${hash} was not found for this site`, hash);
  }

  let record: Record<string, unknown>;
  try {
    record = externalActionPolicyRecord(input.tool, input.args, input.facts);
  } catch {
    return refuse('POLICY_RECORD_INVALID', `policy_record_invalid: "${input.tool.name}" could not describe this call`, hash);
  }

  const evaluators = version.evaluators as ConstitutionEvaluator[];
  const results = await input.constitutions.evaluate(evaluators, record);
  const byId = new Map(evaluators.map((evaluator) => [evaluator.id, evaluator]));
  const audited = results.map((result) => ({ id: result.evaluatorId, status: result.status, blocking: result.blocking }));

  const blockingMisses = results.filter((result) => result.blocking && result.status !== 'pass');
  // An evaluator that could not decide (bad regex, no judge configured) refuses
  // whatever it is marked: nobody evaluated the rule it stands for.
  const refusing = blockingMisses.filter(
    (result) => result.status === 'error' || byId.get(result.evaluatorId)?.onViolation !== 'require_approval',
  );
  if (refusing.length > 0) {
    return refuse(
      'CONSTITUTION_VIOLATION',
      `constitution_violation: ${refusing.map((result) => `${result.evaluatorId} (${result.status})`).join(', ')}`,
      hash,
      audited,
    );
  }
  if (blockingMisses.length > 0) {
    return {
      outcome: 'require_approval',
      message: `constitution_requires_approval: ${blockingMisses.map((result) => result.evaluatorId).join(', ')}`,
      constitutionHash: hash,
      evaluators: audited,
    };
  }
  return { outcome: 'pass', constitutionHash: hash, evaluators: audited };
}
