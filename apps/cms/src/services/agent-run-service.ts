import {
  agentGoals,
  agentRuns,
  agentToolCalls,
  type Database,
} from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';

export interface AgentRunEnvelope {
  goalId?: string;
  runId?: string;
  agentName?: string;
  provider?: string;
  model?: string;
  budget?: Record<string, unknown>;
  policySnapshotHash?: string;
  createdBy?: string | null;
  title?: string;
  contextMessage?: string;
}

export interface AgentRunContext {
  goalId: string;
  runId: string;
  agentName: string;
}

export interface ToolCallInput {
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  status?: string;
  risk?: string;
  approvalId?: string | null;
}

const SECRET_KEY_RE = /(secret|token|password|api[_-]?key|authorization|credential)/i;

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => maskSecrets(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_RE.test(key) ? '[masked]' : maskSecrets(entry),
    ]),
  );
}

export class AgentRunService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  async ensureRun(envelope: AgentRunEnvelope = {}): Promise<AgentRunContext> {
    const agentName = envelope.agentName ?? 'lumibase-copilot';

    if (envelope.goalId && envelope.runId) {
      return { goalId: envelope.goalId, runId: envelope.runId, agentName };
    }

    let goalId = envelope.goalId;
    if (!goalId) {
      const [goal] = await this.db
        .insert(agentGoals)
        .values({
          siteId: this.siteId,
          title: envelope.title ?? 'Transient agent task',
          description: envelope.contextMessage ?? null,
          source: 'api',
          createdBy: envelope.createdBy ?? null,
          assigneeAgent: agentName,
          status: 'in_progress',
          metadata: { transient: true },
        })
        .returning();
      goalId = goal!.id;
    }

    if (envelope.runId) {
      return { goalId, runId: envelope.runId, agentName };
    }

    const [run] = await this.db
      .insert(agentRuns)
      .values({
        goalId,
        siteId: this.siteId,
        agentName,
        provider: envelope.provider ?? 'local',
        model: envelope.model ?? 'tool-registry',
        budget: envelope.budget ?? {},
        policySnapshotHash: envelope.policySnapshotHash ?? null,
        status: 'running',
      })
      .returning();

    return { goalId, runId: run!.id, agentName };
  }

  async appendToolCall(input: ToolCallInput): Promise<string> {
    const [record] = await this.db
      .insert(agentToolCalls)
      .values({
        runId: input.runId,
        siteId: this.siteId,
        toolName: input.toolName,
        input: maskSecrets(input.input) as Record<string, unknown>,
        status: input.status ?? 'running',
        risk: input.risk ?? 'safe',
        approvalId: input.approvalId ?? null,
      })
      .returning();

    return record!.id;
  }

  async finishToolCall(
    toolCallId: string,
    patch: {
      status: 'executed' | 'pending_approval' | 'denied' | 'failed';
      output?: unknown;
      error?: string | null;
      approvalId?: string | null;
      latencyMs?: number;
      cost?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db
      .update(agentToolCalls)
      .set({
        status: patch.status,
        output: maskSecrets(patch.output ?? {}) as Record<string, unknown>,
        error: patch.error ?? null,
        approvalId: patch.approvalId ?? null,
        latencyMs: patch.latencyMs ?? null,
        cost: patch.cost ?? {},
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(agentToolCalls.id, toolCallId),
          eq(agentToolCalls.siteId, this.siteId),
        ),
      );
  }

  async closeRun(runId: string, metrics: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({ status: 'succeeded', metrics, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
  }

  async failRun(runId: string, error: string, metrics: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({ status: 'failed', error, metrics, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));
  }

  async retryRun(runId: string): Promise<AgentRunContext | null> {
    const [existing] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.siteId, this.siteId)));

    if (!existing) {
      return null;
    }

    const [retry] = await this.db
      .insert(agentRuns)
      .values({
        goalId: existing.goalId,
        siteId: this.siteId,
        agentName: existing.agentName,
        provider: existing.provider,
        model: existing.model,
        budget: existing.budget as Record<string, unknown>,
        policySnapshotHash: existing.policySnapshotHash,
        retryOfRunId: existing.id,
        status: 'running',
      })
      .returning();

    return { goalId: existing.goalId, runId: retry!.id, agentName: existing.agentName };
  }

  async listRuns(limit = 50) {
    return this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.siteId, this.siteId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit);
  }
}
