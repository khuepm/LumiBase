/**
 * Persistence for Jev automation actions (J11, #518). Every query is scoped
 * by `site_id`. The unique key (site, flow run, node, item) is what makes a
 * redelivered flow job find its row instead of proposing again.
 */
import { agentApprovals, aiAutomationActions, reviewFeedback, type Database } from '@lumibase/database';
import { and, desc, eq, gte, inArray, isNull, lt, type SQL } from 'drizzle-orm';

export type AutomationActionRecord = typeof aiAutomationActions.$inferSelect;
export type AutomationActionInsert = Omit<typeof aiAutomationActions.$inferInsert, 'createdAt' | 'updatedAt'>;
export type AutomationActionPatch = Partial<
  Pick<
    AutomationActionRecord,
    | 'mode'
    | 'status'
    | 'reason'
    | 'applied'
    | 'previous'
    | 'proposed'
    | 'approvalId'
    | 'agentRunId'
    | 'revisionId'
    | 'contentHash'
    | 'revertedAt'
    | 'revertedBy'
  >
>;

export interface AutomationFeedbackRecord {
  runId: string;
  questionKey: string;
  verdict: string;
  editedValue: unknown;
  principalType: string;
  principalId: string;
  createdAt: Date;
}

export interface AutomationActionFilter {
  collection?: string;
  itemId?: string;
  status?: string;
  mode?: 'shadow' | 'live';
  action?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

export interface AutomationActionStore {
  /** Inserts the row, or returns the existing one for the same (site, flow run, node, item). */
  claim(row: AutomationActionInsert): Promise<{ row: AutomationActionRecord; created: boolean }>;
  update(siteId: string, id: string, patch: AutomationActionPatch): Promise<AutomationActionRecord | null>;
  get(siteId: string, id: string): Promise<AutomationActionRecord | null>;
  list(siteId: string, filter: AutomationActionFilter): Promise<AutomationActionRecord[]>;
  /** Feedback on the decisions behind these review runs (the last link of the audit chain). */
  feedbackForRuns(siteId: string, runIds: readonly string[]): Promise<AutomationFeedbackRecord[]>;
  /** Status of the agent approval a live proposal parked, or null when unknown. */
  approvalStatus(siteId: string, approvalId: string): Promise<string | null>;
  /** Sets `reverted` once: only an applied, not yet reverted row changes. */
  markReverted(siteId: string, id: string, by: string, at: Date): Promise<AutomationActionRecord | null>;
}

export function automationActionStoreFor(db: Database): AutomationActionStore {
  return new DrizzleAutomationActionStore(db);
}

export class DrizzleAutomationActionStore implements AutomationActionStore {
  constructor(private readonly db: Database) {}

  async claim(row: AutomationActionInsert): Promise<{ row: AutomationActionRecord; created: boolean }> {
    const [inserted] = await this.db
      .insert(aiAutomationActions)
      .values(row)
      .onConflictDoNothing({
        target: [
          aiAutomationActions.siteId,
          aiAutomationActions.flowRunId,
          aiAutomationActions.nodeId,
          aiAutomationActions.itemId,
        ],
      })
      .returning();
    if (inserted) return { row: inserted, created: true };
    const [existing] = await this.db
      .select()
      .from(aiAutomationActions)
      .where(
        and(
          eq(aiAutomationActions.siteId, row.siteId),
          eq(aiAutomationActions.flowRunId, row.flowRunId),
          eq(aiAutomationActions.nodeId, row.nodeId),
          eq(aiAutomationActions.itemId, row.itemId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('automation action claim conflicted but no row was found');
    return { row: existing, created: false };
  }

  async update(siteId: string, id: string, patch: AutomationActionPatch): Promise<AutomationActionRecord | null> {
    const [row] = await this.db
      .update(aiAutomationActions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(aiAutomationActions.siteId, siteId), eq(aiAutomationActions.id, id)))
      .returning();
    return row ?? null;
  }

  async get(siteId: string, id: string): Promise<AutomationActionRecord | null> {
    const [row] = await this.db
      .select()
      .from(aiAutomationActions)
      .where(and(eq(aiAutomationActions.siteId, siteId), eq(aiAutomationActions.id, id)))
      .limit(1);
    return row ?? null;
  }

  async list(siteId: string, filter: AutomationActionFilter): Promise<AutomationActionRecord[]> {
    const conditions: SQL[] = [eq(aiAutomationActions.siteId, siteId)];
    if (filter.collection) conditions.push(eq(aiAutomationActions.collection, filter.collection));
    if (filter.itemId) conditions.push(eq(aiAutomationActions.itemId, filter.itemId));
    if (filter.status) conditions.push(eq(aiAutomationActions.status, filter.status));
    if (filter.mode) conditions.push(eq(aiAutomationActions.mode, filter.mode));
    if (filter.action) conditions.push(eq(aiAutomationActions.action, filter.action));
    if (filter.from) conditions.push(gte(aiAutomationActions.createdAt, filter.from));
    if (filter.to) conditions.push(lt(aiAutomationActions.createdAt, filter.to));
    return this.db
      .select()
      .from(aiAutomationActions)
      .where(and(...conditions))
      .orderBy(desc(aiAutomationActions.createdAt))
      .limit(filter.limit);
  }

  async feedbackForRuns(siteId: string, runIds: readonly string[]): Promise<AutomationFeedbackRecord[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(reviewFeedback)
      .where(and(eq(reviewFeedback.siteId, siteId), inArray(reviewFeedback.runId, [...runIds])));
    return rows.map((row) => ({
      runId: row.runId,
      questionKey: row.questionKey,
      verdict: row.verdict,
      editedValue: row.editedValue,
      principalType: row.principalType,
      principalId: row.principalId,
      createdAt: row.createdAt,
    }));
  }

  async approvalStatus(siteId: string, approvalId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: agentApprovals.status })
      .from(agentApprovals)
      .where(and(eq(agentApprovals.siteId, siteId), eq(agentApprovals.id, approvalId)))
      .limit(1);
    return row?.status ?? null;
  }

  async markReverted(siteId: string, id: string, by: string, at: Date): Promise<AutomationActionRecord | null> {
    const [row] = await this.db
      .update(aiAutomationActions)
      .set({ status: 'reverted', applied: false, revertedAt: at, revertedBy: by, updatedAt: at })
      .where(
        and(
          eq(aiAutomationActions.siteId, siteId),
          eq(aiAutomationActions.id, id),
          eq(aiAutomationActions.status, 'applied'),
          isNull(aiAutomationActions.revertedAt),
        ),
      )
      .returning();
    return row ?? null;
  }
}
