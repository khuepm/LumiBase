/**
 * In-memory AutomationActionStore with the same unique key as the DB
 * (site, flow run, node, item). Feedback is read from a MemoryReviewStore so
 * tests exercise the real audit-chain join.
 */
import type {
  AutomationActionFilter,
  AutomationActionInsert,
  AutomationActionPatch,
  AutomationActionRecord,
  AutomationActionStore,
  AutomationFeedbackRecord,
} from '../../services/ai-automation-store';
import { AUTOMATION_ORPHAN_MS } from '../../services/ai-automation-store';
import type { MemoryReviewStore } from './memory-review-store';

export class MemoryAutomationActionStore implements AutomationActionStore {
  rows: AutomationActionRecord[] = [];
  approvals = new Map<string, string>();
  /** Decision reason per approval id (e.g. an ITEM_PRECONDITION_FAILED settlement). */
  approvalReasons = new Map<string, string>();
  private clock = 0;
  /** The store's clock; tests move it forward to age a claim past the orphan window. */
  now: () => Date = () => new Date(Date.UTC(2026, 9, 1) + this.clock * 1000);

  constructor(private readonly reviews?: MemoryReviewStore) {}

  private stamp(): Date {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 1) + this.clock * 1000);
  }

  async claim(row: AutomationActionInsert) {
    const existing = this.rows.find(
      (r) => r.siteId === row.siteId && r.flowRunId === row.flowRunId && r.nodeId === row.nodeId && r.itemId === row.itemId,
    );
    if (existing) {
      // Same orphan rule as the Drizzle store (B120).
      const orphaned =
        existing.status === 'pending' &&
        existing.approvalId === null &&
        existing.createdAt.getTime() < this.now().getTime() - AUTOMATION_ORPHAN_MS;
      if (orphaned) Object.assign(existing, { status: 'denied', reason: 'orphaned', updatedAt: this.now() });
      return { row: existing, created: false };
    }
    const at = this.stamp();
    const record: AutomationActionRecord = {
      reviewRunId: null,
      revisionId: null,
      contentHash: null,
      reason: null,
      questionKey: null,
      locale: null,
      provider: null,
      model: null,
      profileKey: null,
      profileVersion: null,
      confidence: null,
      inZone: false,
      proposed: null,
      applied: false,
      previous: null,
      approvalId: null,
      agentRunId: null,
      revertedAt: null,
      revertedBy: null,
      ...row,
      createdAt: at,
      updatedAt: at,
    } as AutomationActionRecord;
    this.rows.push(record);
    return { row: record, created: true };
  }

  async update(siteId: string, id: string, patch: AutomationActionPatch) {
    const row = this.rows.find((r) => r.siteId === siteId && r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: this.stamp() });
    return row;
  }

  async get(siteId: string, id: string) {
    return this.rows.find((r) => r.siteId === siteId && r.id === id) ?? null;
  }

  async list(siteId: string, filter: AutomationActionFilter) {
    return this.rows
      .filter(
        (r) =>
          r.siteId === siteId &&
          (!filter.collection || r.collection === filter.collection) &&
          (!filter.itemId || r.itemId === filter.itemId) &&
          (!filter.status || r.status === filter.status) &&
          (!filter.mode || r.mode === filter.mode) &&
          (!filter.action || r.action === filter.action) &&
          (!filter.from || r.createdAt >= filter.from) &&
          (!filter.to || r.createdAt < filter.to),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }

  async feedbackForRuns(siteId: string, runIds: readonly string[]): Promise<AutomationFeedbackRecord[]> {
    return (this.reviews?.feedback ?? [])
      .filter((f) => f.siteId === siteId && runIds.includes(f.runId))
      .map((f) => ({
        runId: f.runId,
        questionKey: f.questionKey,
        verdict: f.verdict,
        editedValue: f.editedValue,
        principalType: f.principalType,
        principalId: f.principalId,
        createdAt: f.createdAt,
      }));
  }

  async approvalStatus(_siteId: string, approvalId: string) {
    const status = this.approvals.get(approvalId);
    return status === undefined ? null : { status, reason: this.approvalReasons.get(approvalId) ?? null };
  }

  async markReverted(siteId: string, id: string, by: string, at: Date) {
    const row = this.rows.find((r) => r.siteId === siteId && r.id === id);
    if (!row || row.status !== 'applied' || row.revertedAt) return null;
    Object.assign(row, { status: 'reverted', applied: false, revertedAt: at, revertedBy: by, updatedAt: at });
    return row;
  }
}
