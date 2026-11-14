import { activity, type Database } from '@lumibase/database';
import type { ExternalActionMetadata } from './external-action-tools';

/**
 * Audit trail for external-action tools.
 *
 * One `lumibase_activity` row per step of an external action's life:
 *
 * - `proposed`: parked as a pending approval;
 * - `approved`: a human released it (written BEFORE the handler runs);
 * - `rejected`: a decider turned it down;
 * - `refused`: the harness would not run or release it (autonomy L0, a
 *   non-human decider, a missing capability at decision time, …);
 * - `executed` / `failed`: the handler ran and returned / threw.
 *
 * The payload is assembled from the tool's DECLARATION and from identifiers,
 * never from the call's arguments or the handler's output: the arguments are
 * identified by a digest, and secrets appear as the names the tool declared.
 * That is what makes the row safe to show to anyone who may read the audit
 * log, and it is why this module takes no free-form detail object.
 */

export type ExternalActionAuditStage =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'refused'
  | 'executed'
  | 'failed';

/** Who decided an approval, as the harness needs to know it. */
export interface ApprovalDecider {
  /**
   * `human`: a signed-in user session. `api_key`: any API key, whoever holds
   * it. `agent`: an agent acting as reviewer.
   */
  kind: 'human' | 'api_key' | 'agent';
  /** `users.id` when `kind` is `human`. */
  userId?: string | null;
}

export interface ExternalActionAuditEntry {
  stage: ExternalActionAuditStage;
  tool: string;
  metadata: ExternalActionMetadata;
  agentName: string;
  runId?: string | null;
  toolCallId?: string | null;
  approvalId?: string | null;
  autonomyLevel?: number | null;
  /** Machine-readable reason for `refused` / `failed`. */
  code?: string | null;
  /** Already-scrubbed, bounded message for `refused` / `failed`. */
  message?: string | null;
  decider?: ApprovalDecider | null;
  /** `sha256:<hex>` of the canonical arguments. */
  inputHash?: string | null;
  /** Hash of the constitution pinned to the run, when one is active. */
  constitutionHash?: string | null;
}

export const EXTERNAL_ACTION_AUDIT_PREFIX = 'agent.external_action.';

export function externalActionAuditAction(stage: ExternalActionAuditStage): string {
  return `${EXTERNAL_ACTION_AUDIT_PREFIX}${stage}`;
}

/** `sha256:<hex>` over JSON with sorted keys, so equal arguments hash equally. */
export async function externalActionInputHash(args: Record<string, unknown>): Promise<string> {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
      );
    }
    return value === undefined ? null : value;
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sort(args))));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function recordExternalActionAudit(
  db: Database,
  siteId: string,
  entry: ExternalActionAuditEntry,
): Promise<void> {
  await db.insert(activity).values({
    siteId,
    action: externalActionAuditAction(entry.stage),
    userId: entry.decider?.kind === 'human' ? entry.decider.userId ?? null : null,
    payload: {
      tool: entry.tool,
      capability: entry.metadata.capability,
      risk: entry.metadata.risk,
      reversibility: entry.metadata.reversibility,
      blastRadius: entry.metadata.blastRadius,
      secretRefs: [...entry.metadata.secrets],
      agentName: entry.agentName,
      runId: entry.runId ?? null,
      toolCallId: entry.toolCallId ?? null,
      approvalId: entry.approvalId ?? null,
      autonomyLevel: entry.autonomyLevel ?? null,
      code: entry.code ?? null,
      message: entry.message ? entry.message.slice(0, 500) : null,
      deciderKind: entry.decider?.kind ?? null,
      inputHash: entry.inputHash ?? null,
      constitutionHash: entry.constitutionHash ?? null,
    },
  });
}
