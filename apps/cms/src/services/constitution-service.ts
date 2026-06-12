import { activity, agentRuns, constitutions } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import type { ConfiguredLLM, LLMMessage } from './llm-provider';

/**
 * Constitution service (content-os task 16; Req 15.1-15.6).
 *
 * A constitution is a versioned set of evaluators that gate publishing:
 * - `rule` evaluators are a small deterministic DSL over content fields;
 * - `llm_judge` evaluators delegate the verdict to a configured LLM and
 *   fail loudly when none is configured (no silent stub).
 *
 * Identity is the sha256 of the canonicalized evaluator list. Runs pin the
 * active hash once at start; every later evaluation of that run uses the
 * pinned hash even if the active version changes mid-run (Property 12).
 */

export interface RuleEvaluator {
  id: string;
  type: 'rule';
  /** Blocking failures veto publish; non-blocking ones only report. */
  blocking?: boolean;
  description?: string;
  rule: {
    field: string;
    op: 'required' | 'equals' | 'max_length' | 'min_length' | 'regex' | 'contains' | 'not_contains';
    value?: unknown;
  };
}

export interface LlmJudgeEvaluator {
  id: string;
  type: 'llm_judge';
  blocking?: boolean;
  description?: string;
  /** Judge instruction; the content sample is appended as context. */
  prompt: string;
}

export type ConstitutionEvaluator = RuleEvaluator | LlmJudgeEvaluator;

export interface EvaluatorResult {
  evaluatorId: string;
  type: 'rule' | 'llm_judge';
  blocking: boolean;
  status: 'pass' | 'fail' | 'error';
  message?: string;
}

export class ConstitutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ConstitutionError';
  }
}

/** Stable stringify (sorted object keys) so hashing is order-insensitive. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical form — Workers-compatible via WebCrypto. */
export async function computeConstitutionHash(
  evaluators: readonly ConstitutionEvaluator[],
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(evaluators));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** Pure rule-DSL evaluation — exported for tests. */
export function evaluateRuleEvaluator(
  evaluator: RuleEvaluator,
  content: Record<string, unknown>,
): EvaluatorResult {
  const base = {
    evaluatorId: evaluator.id,
    type: 'rule' as const,
    blocking: evaluator.blocking !== false,
  };
  const raw = content[evaluator.rule.field];
  const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : JSON.stringify(raw);
  const { op, value } = evaluator.rule;

  const fail = (message: string): EvaluatorResult => ({ ...base, status: 'fail', message });
  const pass = (): EvaluatorResult => ({ ...base, status: 'pass' });

  switch (op) {
    case 'required':
      return raw !== undefined && raw !== null && text.trim().length > 0
        ? pass()
        : fail(`Field "${evaluator.rule.field}" is required.`);
    case 'equals':
      return raw === value ? pass() : fail(`Field "${evaluator.rule.field}" must equal ${JSON.stringify(value)}.`);
    case 'max_length':
      return text.length <= Number(value)
        ? pass()
        : fail(`Field "${evaluator.rule.field}" exceeds ${value} characters.`);
    case 'min_length':
      return text.length >= Number(value)
        ? pass()
        : fail(`Field "${evaluator.rule.field}" is shorter than ${value} characters.`);
    case 'regex':
      try {
        return new RegExp(String(value)).test(text)
          ? pass()
          : fail(`Field "${evaluator.rule.field}" does not match ${value}.`);
      } catch {
        return { ...base, status: 'error', message: `Invalid regex: ${value}` };
      }
    case 'contains':
      return text.includes(String(value))
        ? pass()
        : fail(`Field "${evaluator.rule.field}" must contain "${value}".`);
    case 'not_contains':
      return text.includes(String(value))
        ? fail(`Field "${evaluator.rule.field}" must not contain "${value}".`)
        : pass();
    default:
      return { ...base, status: 'error', message: `Unknown rule op: ${String(op)}` };
  }
}

function validateEvaluators(input: unknown): ConstitutionEvaluator[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConstitutionError('VALIDATION', 'evaluators must be a non-empty array.');
  }
  const ids = new Set<string>();
  for (const entry of input) {
    const e = entry as Partial<ConstitutionEvaluator>;
    if (!e || typeof e.id !== 'string' || e.id.length === 0) {
      throw new ConstitutionError('VALIDATION', 'Every evaluator needs a string id.');
    }
    if (ids.has(e.id)) {
      throw new ConstitutionError('VALIDATION', `Duplicate evaluator id "${e.id}".`);
    }
    ids.add(e.id);
    if (e.type === 'rule') {
      const rule = (e as RuleEvaluator).rule;
      if (!rule || typeof rule.field !== 'string' || typeof rule.op !== 'string') {
        throw new ConstitutionError('VALIDATION', `Evaluator "${e.id}": rule needs field and op.`);
      }
    } else if (e.type === 'llm_judge') {
      if (typeof (e as LlmJudgeEvaluator).prompt !== 'string' || (e as LlmJudgeEvaluator).prompt.length === 0) {
        throw new ConstitutionError('VALIDATION', `Evaluator "${e.id}": llm_judge needs a prompt.`);
      }
    } else {
      throw new ConstitutionError('VALIDATION', `Evaluator "${e.id}": unknown type.`);
    }
  }
  return input as ConstitutionEvaluator[];
}

export interface ConstitutionServiceDeps {
  db: Database;
  siteId: string;
  /** Configured LLM for llm_judge evaluators; absent/null fails loudly. */
  llm?: ConfiguredLLM | null;
}

export class ConstitutionService {
  constructor(private readonly deps: ConstitutionServiceDeps) {}

  async listVersions() {
    return this.deps.db
      .select()
      .from(constitutions)
      .where(eq(constitutions.siteId, this.deps.siteId))
      .orderBy(desc(constitutions.version));
  }

  async getActive() {
    const [row] = await this.deps.db
      .select()
      .from(constitutions)
      .where(and(eq(constitutions.siteId, this.deps.siteId), eq(constitutions.status, 'active')))
      .limit(1);
    return row;
  }

  /** Creates the next draft version (Req 15.1). */
  async createDraft(evaluatorsInput: unknown, createdBy: string | null) {
    const evaluators = validateEvaluators(evaluatorsInput);
    const hash = await computeConstitutionHash(evaluators);
    const versions = await this.listVersions();
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const [row] = await this.deps.db
      .insert(constitutions)
      .values({
        siteId: this.deps.siteId,
        version: nextVersion,
        evaluators,
        hash,
        status: 'draft',
        createdBy,
      })
      .returning();
    return row!;
  }

  /**
   * Runs a version's evaluators against content samples without activating
   * anything (Req 15.5).
   */
  async dryRun(
    constitutionId: string,
    samples: Array<Record<string, unknown>>,
  ): Promise<Array<{ sample: number; results: EvaluatorResult[] }>> {
    const row = await this.getById(constitutionId);
    if (!row) {
      throw new ConstitutionError('NOT_FOUND', 'Constitution version not found.', 404);
    }
    const evaluators = row.evaluators as ConstitutionEvaluator[];
    const out: Array<{ sample: number; results: EvaluatorResult[] }> = [];
    for (let i = 0; i < samples.length; i += 1) {
      const results: EvaluatorResult[] = [];
      for (const evaluator of evaluators) {
        results.push(
          evaluator.type === 'rule'
            ? evaluateRuleEvaluator(evaluator, samples[i]!)
            : await this.runLlmJudge(evaluator, samples[i]!),
        );
      }
      out.push({ sample: i, results });
    }
    return out;
  }

  /**
   * Activates a draft: the previous active version is archived, the change
   * is audited with an evaluator-level diff (Req 15.6).
   */
  async activate(constitutionId: string, actor: string | null) {
    const next = await this.getById(constitutionId);
    if (!next) {
      throw new ConstitutionError('NOT_FOUND', 'Constitution version not found.', 404);
    }
    if (next.status === 'active') {
      return next;
    }
    if (next.status === 'archived') {
      throw new ConstitutionError('CONFLICT', 'Archived versions cannot be re-activated; create a new draft.', 409);
    }

    const current = await this.getActive();
    if (current) {
      await this.deps.db
        .update(constitutions)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(eq(constitutions.id, current.id), eq(constitutions.siteId, this.deps.siteId)));
    }
    const [activated] = await this.deps.db
      .update(constitutions)
      .set({ status: 'active', activatedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(constitutions.id, constitutionId), eq(constitutions.siteId, this.deps.siteId)))
      .returning();

    const beforeIds = new Set(
      ((current?.evaluators ?? []) as ConstitutionEvaluator[]).map((e) => e.id),
    );
    const afterIds = new Set((next.evaluators as ConstitutionEvaluator[]).map((e) => e.id));
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action: 'constitution.activated',
      userId: actor,
      payload: {
        fromVersion: current?.version ?? null,
        toVersion: next.version,
        fromHash: current?.hash ?? null,
        toHash: next.hash,
        added: [...afterIds].filter((id) => !beforeIds.has(id)),
        removed: [...beforeIds].filter((id) => !afterIds.has(id)),
      },
    });
    return activated!;
  }

  /**
   * Pins the active constitution hash to a run, once (Req 15.3,
   * Property 12). Idempotent: a hash pinned at run start survives any
   * later activation — repeat calls return the original pin.
   */
  async pinToRun(runId: string): Promise<string | null> {
    const [run] = await this.deps.db
      .select({ metrics: agentRuns.metrics })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.deps.siteId)))
      .limit(1);
    if (!run) {
      throw new ConstitutionError('NOT_FOUND', 'Run not found.', 404);
    }
    const metrics = (run.metrics ?? {}) as Record<string, unknown>;
    const pinned = metrics['constitutionHash'];
    if (typeof pinned === 'string') {
      return pinned;
    }
    const active = await this.getActive();
    const hash = active?.hash ?? null;
    if (hash) {
      await this.deps.db
        .update(agentRuns)
        .set({ metrics: { ...metrics, constitutionHash: hash }, updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.deps.siteId)));
    }
    return hash;
  }

  /**
   * Publish gate (Req 15.4): evaluates the ACTIVE constitution against the
   * content. A blocking fail (or blocking error — fail closed) blocks
   * publish; callers may override with an explicit reason, which is audited.
   */
  async publishGate(content: Record<string, unknown>): Promise<{
    allowed: boolean;
    hash: string | null;
    failures: EvaluatorResult[];
  }> {
    const active = await this.getActive();
    if (!active) {
      return { allowed: true, hash: null, failures: [] };
    }
    const evaluators = active.evaluators as ConstitutionEvaluator[];
    const failures: EvaluatorResult[] = [];
    for (const evaluator of evaluators) {
      const result =
        evaluator.type === 'rule'
          ? evaluateRuleEvaluator(evaluator, content)
          : await this.runLlmJudge(evaluator, content);
      if (result.status !== 'pass') {
        failures.push(result);
      }
    }
    const blockingFailure = failures.some((f) => f.blocking);
    return { allowed: !blockingFailure, hash: active.hash, failures };
  }

  private async getById(constitutionId: string) {
    const [row] = await this.deps.db
      .select()
      .from(constitutions)
      .where(and(eq(constitutions.id, constitutionId), eq(constitutions.siteId, this.deps.siteId)))
      .limit(1);
    return row;
  }

  private async runLlmJudge(
    evaluator: LlmJudgeEvaluator,
    content: Record<string, unknown>,
  ): Promise<EvaluatorResult> {
    const base = {
      evaluatorId: evaluator.id,
      type: 'llm_judge' as const,
      blocking: evaluator.blocking !== false,
    };
    if (!this.deps.llm) {
      // Explicit error, no stub fallback (design "Error Handling").
      return { ...base, status: 'error', message: 'LLM_NOT_CONFIGURED: llm_judge evaluators need a configured provider.' };
    }
    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content:
            'You are a content constitution judge. Reply with exactly PASS or FAIL followed by a one-line reason.',
        },
        {
          role: 'user',
          content: `${evaluator.prompt}\n\nContent:\n${JSON.stringify(content).slice(0, 6000)}`,
        },
      ];
      const response = await this.deps.llm.provider.chat(messages);
      const verdict = (response.content ?? '').trim().toUpperCase();
      if (verdict.startsWith('PASS')) return { ...base, status: 'pass' };
      if (verdict.startsWith('FAIL')) {
        return { ...base, status: 'fail', message: (response.content ?? '').trim().slice(0, 500) };
      }
      return { ...base, status: 'error', message: `Unparseable judge verdict: ${verdict.slice(0, 120)}` };
    } catch (err) {
      return { ...base, status: 'error', message: `Judge error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
