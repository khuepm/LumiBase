/**
 * In-memory {@link ReviewStore} for service and route tests. It mirrors the
 * database constraints the service relies on — site scoping, unique
 * (site, key, version), unique (site, principal, idempotency_key), unique
 * (site, run, question, principal) — so idempotency and tenancy are tested
 * against the same rules. The Drizzle store is covered by the DB suite.
 */

import {
  reclaimBinding,
  REVIEW_RUN_ORPHAN_MS,
  type ReviewFeedbackInsert,
  type ReviewFeedbackRecord,
  type ReviewProfileInsert,
  type ReviewProfileRecord,
  type ReviewRunCompletion,
  type ReviewRunInsert,
  type ReviewRunRecord,
  type ReviewSessionInsert,
  type ReviewSessionRecord,
  type ReviewStore,
} from '../../services/review-store';

export class MemoryReviewStore implements ReviewStore {
  profiles: ReviewProfileRecord[] = [];
  runs: ReviewRunRecord[] = [];
  feedback: ReviewFeedbackRecord[] = [];
  sessions: ReviewSessionRecord[] = [];
  private clock = 0;

  /** The store's current time (the last stamp handed out). */
  now(): Date {
    return new Date(Date.UTC(2026, 0, 1) + this.clock * 1000);
  }
  private stamp(): Date {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.clock * 1000);
  }

  private profileRecord(row: ReviewProfileInsert): ReviewProfileRecord {
    return {
      id: row.id,
      siteId: row.siteId,
      collection: row.collection ?? null,
      key: row.key,
      version: row.version,
      status: 'active',
      preset: row.preset ?? null,
      fields: row.fields ?? [],
      questions: row.questions ?? {},
      sourceField: row.sourceField ?? null,
      minConfidence: row.minConfidence ?? null,
      note: row.note ?? null,
      createdBy: row.createdBy ?? null,
      createdAt: this.stamp(),
    };
  }

  async listActiveProfiles(siteId: string, collection?: string) {
    return this.profiles.filter(
      (p) =>
        p.siteId === siteId &&
        p.status === 'active' &&
        (collection === undefined || p.collection === null || p.collection === collection),
    );
  }

  async getProfile(siteId: string, key: string, version?: number) {
    return (
      this.profiles.find(
        (p) =>
          p.siteId === siteId && p.key === key && (version === undefined ? p.status === 'active' : p.version === version),
      ) ?? null
    );
  }

  async getProfileById(siteId: string, id: string) {
    return this.profiles.find((p) => p.siteId === siteId && p.id === id) ?? null;
  }

  async insertFirstProfile(row: ReviewProfileInsert) {
    if (this.profiles.some((p) => p.siteId === row.siteId && p.key === row.key)) return null;
    const record = this.profileRecord(row);
    this.profiles.push(record);
    return record;
  }

  async insertNextProfileVersion(siteId: string, key: string, build: (version: number) => ReviewProfileInsert) {
    const rows = this.profiles.filter((p) => p.siteId === siteId && p.key === key);
    if (!rows.some((p) => p.status === 'active')) return 'not_found' as const;
    const next = Math.max(...rows.map((p) => p.version)) + 1;
    for (const row of rows) row.status = 'archived';
    const record = this.profileRecord(build(next));
    this.profiles.push(record);
    return record;
  }

  async claimRun(row: ReviewRunInsert) {
    const existing = this.runs.find(
      (r) =>
        r.siteId === row.siteId &&
        r.principalType === row.principalType &&
        r.principalId === row.principalId &&
        r.idempotencyKey === row.idempotencyKey,
    );
    if (existing) {
      const orphaned =
        existing.status === 'running' && existing.createdAt.getTime() < this.now().getTime() - REVIEW_RUN_ORPHAN_MS;
      if (existing.status === 'error' || orphaned) {
        Object.assign(existing, reclaimBinding(row), { createdAt: this.stamp() });
        return { run: existing, created: true };
      }
      return { run: existing, created: false };
    }
    const record: ReviewRunRecord = {
      id: row.id,
      siteId: row.siteId,
      profileId: row.profileId,
      profileKey: row.profileKey,
      profileVersion: row.profileVersion,
      collection: row.collection,
      itemId: row.itemId ?? null,
      revisionId: row.revisionId ?? null,
      contentHash: row.contentHash,
      source: row.source,
      omittedFields: row.omittedFields ?? [],
      principalType: row.principalType,
      principalId: row.principalId,
      status: row.status,
      provider: null,
      model: null,
      calibrated: null,
      answers: null,
      usage: null,
      latencyMs: null,
      errorCode: null,
      idempotencyKey: row.idempotencyKey,
      createdAt: this.stamp(),
      completedAt: null,
    };
    this.runs.push(record);
    return { run: record, created: true };
  }

  async completeRun(siteId: string, id: string, completion: ReviewRunCompletion, claimedAt: Date) {
    const run = this.runs.find((r) => r.siteId === siteId && r.id === id);
    // Same claim rule as the Drizzle store: only while this claim still holds.
    if (!run || run.status !== 'running' || Math.abs(run.createdAt.getTime() - claimedAt.getTime()) > 1) return null;
    Object.assign(run, completion, { completedAt: this.stamp() });
    return run;
  }

  async getRun(siteId: string, id: string) {
    return this.runs.find((r) => r.siteId === siteId && r.id === id) ?? null;
  }

  async listRuns(siteId: string, filter: { collection: string; itemId: string; limit: number }) {
    return this.runs
      .filter((r) => r.siteId === siteId && r.collection === filter.collection && r.itemId === filter.itemId)
      .reverse()
      .slice(0, filter.limit);
  }

  async insertFeedback(siteId: string, runId: string, principalId: string, rows: ReviewFeedbackInsert[]) {
    for (const row of rows) {
      const duplicate = this.feedback.some(
        (f) =>
          f.siteId === row.siteId &&
          f.runId === row.runId &&
          f.questionKey === row.questionKey &&
          f.principalId === row.principalId,
      );
      if (duplicate) continue;
      this.feedback.push({
        id: row.id,
        siteId: row.siteId,
        runId: row.runId,
        questionKey: row.questionKey,
        verdict: row.verdict,
        editedValue: row.editedValue ?? null,
        principalType: row.principalType,
        principalId: row.principalId,
        createdAt: this.stamp(),
      });
    }
    const keys = new Set(rows.map((row) => row.questionKey));
    return this.feedback.filter(
      (f) => f.siteId === siteId && f.runId === runId && f.principalId === principalId && keys.has(f.questionKey),
    );
  }

  async insertSession(row: ReviewSessionInsert) {
    const record: ReviewSessionRecord = {
      id: row.id,
      siteId: row.siteId,
      collection: row.collection,
      itemId: row.itemId ?? null,
      mode: row.mode,
      runId: row.runId ?? null,
      viewedQuestions: row.viewedQuestions ?? [],
      principalType: row.principalType,
      principalId: row.principalId,
      durationMs: row.durationMs,
      locale: row.locale ?? null,
      createdAt: this.stamp(),
    };
    this.sessions.push(record);
    return record;
  }
}
