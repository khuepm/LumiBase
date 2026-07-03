/**
 * release-service.ts — Content Releases (spec: .kiro/specs/content-releases).
 *
 * A Release collates specific item revisions across collections into a named
 * bundle that publishes all at once (manual) or on a schedule. Publish DELEGATES
 * to `ItemService.patch` so the editorial gate, validation, permission snapshot,
 * hooks, and search indexing all apply exactly as they do for a normal edit —
 * no logic is duplicated.
 *
 * Atomicity (Req 5): `ItemService.patch` is not transaction-injectable (it owns
 * hooks/search side-effects), so `all_or_nothing` is enforced at the application
 * level by a PRE-FLIGHT pass — every item is checked publishable (exists, not
 * deleted, editorial gate satisfiable) before any write. If pre-flight fails,
 * nothing is published and the release is marked `failed`. `best_effort`
 * publishes each item independently and records a per-item outcome. (See design
 * §4.4 + open question §11.2.)
 */

import { and, asc, desc, eq, isNotNull, lte, ne } from 'drizzle-orm';
import {
  collections,
  items,
  releaseItems,
  releases,
  revisions,
  scopeSite,
  type Database,
} from '@lumibase/database';
import { type ItemService, ItemServiceError } from './item-service';
import { itemServiceForSystem } from './item-service-factory';

export type ReleaseStatus = 'draft' | 'scheduled' | 'published' | 'failed' | 'partially_failed';
export type AtomicityMode = 'all_or_nothing' | 'best_effort';
export type PublishTrigger = 'manual' | 'scheduled';

export interface PublishOutcome {
  collection: string;
  itemId: string;
  outcome: 'published' | 'skipped' | 'failed';
  reason?: string;
}

export class ReleaseServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ReleaseServiceError';
  }
}

export interface ReleaseServiceDeps {
  db: Database;
  siteId: string;
  /** Caller user id, recorded as release creator and passed to ItemService. */
  userId?: string | null;
  /**
   * How to build an ItemService for publishing. Defaults to a minimal instance
   * bound to the same db/siteId/userId; callers (routes) may inject a fully
   * configured factory (with search/cache/permissionCtx) so publish honours the
   * same providers a normal edit would.
   */
  itemServiceFactory?: () => ItemService;
}

export interface CreateReleaseInput {
  name: string;
  description?: string | null;
  atomicityMode?: AtomicityMode;
  publishAt?: string | Date | null;
  maintenanceWindow?: unknown;
}

export interface ReleaseItemInput {
  collection: string;
  itemId: string;
  targetStatus?: string;
  revisionId?: string | null;
}

export interface PatchReleaseInput {
  name?: string;
  description?: string | null;
  atomicityMode?: AtomicityMode;
  publishAt?: string | Date | null;
  maintenanceWindow?: unknown;
  addItems?: ReleaseItemInput[];
  removeItems?: Array<{ collection: string; itemId: string }>;
}

const VALID_TARGET_STATUS = new Set(['draft', 'published', 'archived']);

export class ReleaseService {
  constructor(private readonly deps: ReleaseServiceDeps) {}

  private itemService(): ItemService {
    if (this.deps.itemServiceFactory) return this.deps.itemServiceFactory();
    // No injected factory ⇒ system flow (scheduled publish via
    // sweepDueReleases). Request paths inject itemServiceForRequest(c) from
    // the route, so the fail-open posture here only applies to cron work
    // whose authorization is the schedule itself.
    return itemServiceForSystem(
      { db: this.deps.db, siteId: this.deps.siteId, userId: this.deps.userId ?? null },
      'scheduler',
    );
  }

  // ── create (Req 1) ─────────────────────────────────────────────────────────
  async create(input: CreateReleaseInput) {
    const name = input.name?.trim();
    if (!name) throw new ReleaseServiceError('VALIDATION_FAILED', 'Release name is required.', 422);

    const publishAt = this.normalizePublishAt(input.publishAt);
    const [row] = await this.deps.db
      .insert(releases)
      .values({
        siteId: this.deps.siteId,
        name,
        description: input.description ?? null,
        atomicityMode: input.atomicityMode ?? 'all_or_nothing',
        publishAt,
        status: publishAt ? 'scheduled' : 'draft',
        maintenanceWindow: (input.maintenanceWindow as object) ?? null,
        createdBy: this.deps.userId ?? null,
      })
      .returning();
    return row;
  }

  // ── list / get (Req 4) ───────────────────────────────────────────────────
  async list(params: { status?: string; page?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const page = Math.max(params.page ?? 1, 1);
    const where = params.status
      ? and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.status, params.status))
      : scopeSite(releases.siteId, this.deps.siteId);
    const rows = await this.deps.db
      .select()
      .from(releases)
      .where(where)
      .orderBy(desc(releases.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    return { data: rows, meta: { page, pageSize: limit } };
  }

  async get(id: string) {
    const release = await this.loadRelease(id);
    const itemRows = await this.deps.db
      .select()
      .from(releaseItems)
      .where(and(scopeSite(releaseItems.siteId, this.deps.siteId), eq(releaseItems.releaseId, id)))
      .orderBy(asc(releaseItems.createdAt));
    return { ...release, items: itemRows };
  }

  // ── patch / add / remove items (Req 2, 6.3) ───────────────────────────────
  async patch(id: string, input: PatchReleaseInput) {
    const release = await this.loadRelease(id);
    const mutatingItems = (input.addItems?.length ?? 0) > 0 || (input.removeItems?.length ?? 0) > 0;
    if (release.status === 'published' && mutatingItems) {
      throw new ReleaseServiceError('RELEASE_IMMUTABLE', 'Cannot modify items of a published release.', 409);
    }

    if (input.removeItems?.length) {
      for (const ri of input.removeItems) {
        await this.deps.db
          .delete(releaseItems)
          .where(
            and(
              scopeSite(releaseItems.siteId, this.deps.siteId),
              eq(releaseItems.releaseId, id),
              eq(releaseItems.collection, ri.collection),
              eq(releaseItems.itemId, ri.itemId),
            ),
          );
      }
    }

    if (input.addItems?.length) {
      for (const ri of input.addItems) {
        await this.addOneItem(id, ri);
      }
    }

    // Build the release patch.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.atomicityMode !== undefined) patch.atomicityMode = input.atomicityMode;
    if (input.maintenanceWindow !== undefined) patch.maintenanceWindow = input.maintenanceWindow;
    if (input.publishAt !== undefined) {
      const publishAt = this.normalizePublishAt(input.publishAt);
      patch.publishAt = publishAt;
      // Transition draft↔scheduled based on the schedule (Req 6.3).
      if (release.status === 'draft' && publishAt) patch.status = 'scheduled';
      else if (release.status === 'scheduled' && !publishAt) patch.status = 'draft';
    }

    const [updated] = await this.deps.db
      .update(releases)
      .set(patch)
      .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, id)))
      .returning();
    return updated;
  }

  private async addOneItem(releaseId: string, ri: ReleaseItemInput): Promise<void> {
    const targetStatus = ri.targetStatus ?? 'published';
    if (!VALID_TARGET_STATUS.has(targetStatus)) {
      throw new ReleaseServiceError('VALIDATION_FAILED', `Invalid targetStatus "${targetStatus}".`, 422);
    }
    // Verify the item exists in this site.
    const [item] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, ri.itemId)))
      .limit(1);
    if (!item) throw new ReleaseServiceError('ITEM_NOT_FOUND', `Item "${ri.itemId}" not found.`, 404);

    if (ri.revisionId) {
      const [rev] = await this.deps.db
        .select({ id: revisions.id, staged: revisions.staged })
        .from(revisions)
        .where(
          and(
            scopeSite(revisions.siteId, this.deps.siteId),
            eq(revisions.id, ri.revisionId),
            eq(revisions.itemId, ri.itemId),
          ),
        )
        .limit(1);
      if (!rev) throw new ReleaseServiceError('REVISION_NOT_FOUND', `Revision "${ri.revisionId}" not found for item.`, 404);
      if (rev.staged) throw new ReleaseServiceError('REVISION_STAGED', 'Cannot pin a staged (uncommitted) revision.', 409);
    }

    // Upsert by (releaseId, collection, itemId).
    await this.deps.db
      .insert(releaseItems)
      .values({
        siteId: this.deps.siteId,
        releaseId,
        collection: ri.collection,
        itemId: ri.itemId,
        targetStatus,
        revisionId: ri.revisionId ?? null,
      })
      .onConflictDoUpdate({
        target: [releaseItems.releaseId, releaseItems.collection, releaseItems.itemId],
        set: { targetStatus, revisionId: ri.revisionId ?? null },
      });
  }

  // ── delete (Req 9) ─────────────────────────────────────────────────────────
  async delete(id: string): Promise<void> {
    await this.loadRelease(id); // 404 if missing
    // release_items cascade via FK.
    await this.deps.db
      .delete(releases)
      .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, id)));
  }

  // ── publish (Req 5, 7) — shared by manual + scheduled ──────────────────────
  async publish(id: string, opts: { trigger: PublishTrigger } = { trigger: 'manual' }) {
    const release = await this.loadRelease(id);
    if (release.status === 'published') {
      throw new ReleaseServiceError('ALREADY_PUBLISHED', 'Release is already published.', 409);
    }
    const itemRows = await this.deps.db
      .select()
      .from(releaseItems)
      .where(and(scopeSite(releaseItems.siteId, this.deps.siteId), eq(releaseItems.releaseId, id)));
    if (itemRows.length === 0) {
      throw new ReleaseServiceError('EMPTY_RELEASE', 'Cannot publish a release with no items.', 422);
    }

    const svc = this.itemService();
    const mode = release.atomicityMode as AtomicityMode;
    let outcomes: PublishOutcome[];

    if (mode === 'all_or_nothing') {
      // Pre-flight: confirm every item can publish before mutating anything.
      const blockers = await this.preflight(itemRows, svc);
      if (blockers.length > 0) {
        await this.markStatus(id, 'failed', summarize(blockers));
        await this.persistOutcomes(blockers);
        return { release: await this.loadRelease(id), status: 'failed' as ReleaseStatus, outcomes: blockers };
      }
      outcomes = [];
      for (const ri of itemRows) {
        outcomes.push(await this.publishOneItem(ri, svc));
      }
    } else {
      outcomes = [];
      for (const ri of itemRows) {
        try {
          outcomes.push(await this.publishOneItem(ri, svc));
        } catch (err) {
          outcomes.push({
            collection: ri.collection,
            itemId: ri.itemId,
            outcome: 'failed',
            reason: errCode(err),
          });
        }
      }
    }

    await this.persistOutcomes(outcomes);
    const status = decideStatus(outcomes);
    await this.markStatus(id, status, status === 'published' ? null : summarize(outcomes), status === 'published');
    return { release: await this.loadRelease(id), status, outcomes };
  }

  /** Returns outcomes for any item that cannot publish (empty = all clear). */
  private async preflight(itemRows: ReleaseItemRow[], svc: ItemService): Promise<PublishOutcome[]> {
    const blockers: PublishOutcome[] = [];
    for (const ri of itemRows) {
      const live = await this.loadItem(ri);
      if (!live || live.deletedAt) {
        blockers.push({ collection: ri.collection, itemId: ri.itemId, outcome: 'failed', reason: 'ITEM_DELETED' });
        continue;
      }
      // Dry-run the editorial gate by attempting a no-op status validation via
      // the same check ItemService.patch uses. We approximate by checking the
      // collection's editorialWorkflow + the item's editorial state.
      const gateError = await this.checkEditorialGate(ri, live, svc);
      if (gateError) blockers.push(gateError);
    }
    return blockers;
  }

  private async publishOneItem(ri: ReleaseItemRow, svc: ItemService): Promise<PublishOutcome> {
    const live = await this.loadItem(ri);
    if (!live || live.deletedAt) {
      return { collection: ri.collection, itemId: ri.itemId, outcome: 'skipped', reason: 'ITEM_DELETED' };
    }
    // Materialize a pinned revision's snapshot, if any (revision.delta.after —
    // same shape ItemService.revertRevision reads).
    let data: Record<string, unknown> | undefined;
    if (ri.revisionId) {
      const [rev] = await this.deps.db
        .select({ delta: revisions.delta })
        .from(revisions)
        .where(and(scopeSite(revisions.siteId, this.deps.siteId), eq(revisions.id, ri.revisionId)))
        .limit(1);
      const snapshot = (rev?.delta as { after?: Record<string, unknown> } | undefined)?.after;
      if (snapshot) data = snapshot;
    }
    try {
      await svc.patch(ri.collection, ri.itemId, {
        ...(data ? { data } : {}),
        status: ri.targetStatus,
      });
      return { collection: ri.collection, itemId: ri.itemId, outcome: 'published' };
    } catch (err) {
      return { collection: ri.collection, itemId: ri.itemId, outcome: 'failed', reason: errCode(err) };
    }
  }

  /** Detect an editorial-gate blocker without mutating the item. */
  private async checkEditorialGate(
    ri: ReleaseItemRow,
    live: ItemRowLite,
    _svc: ItemService,
  ): Promise<PublishOutcome | null> {
    if (ri.targetStatus !== 'published' || live.status === 'published') return null;
    const [coll] = await this.deps.db
      .select({ meta: collections.meta })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, ri.collection)))
      .limit(1);
    const editorialWorkflow = (coll?.meta as Record<string, unknown> | null)?.editorialWorkflow === true;
    if (!editorialWorkflow) return null;
    // editorialState 'approved'/'scheduled' is required to reach published.
    const state = (live.editorialState as string | null) ?? 'draft';
    if (state === 'approved' || state === 'scheduled' || state === 'published') return null;
    return {
      collection: ri.collection,
      itemId: ri.itemId,
      outcome: 'failed',
      reason: 'EDITORIAL_GATE_REQUIRED',
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  private async loadRelease(id: string) {
    const [row] = await this.deps.db
      .select()
      .from(releases)
      .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, id)))
      .limit(1);
    if (!row) throw new ReleaseServiceError('NOT_FOUND', `Release "${id}" not found.`, 404);
    return row;
  }

  private async loadItem(ri: ReleaseItemRow): Promise<ItemRowLite | null> {
    const [row] = await this.deps.db
      .select({ id: items.id, status: items.status, deletedAt: items.deletedAt, editorialState: items.editorialState })
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, ri.itemId)))
      .limit(1);
    return row ?? null;
  }

  private async persistOutcomes(outcomes: PublishOutcome[]): Promise<void> {
    for (const o of outcomes) {
      await this.deps.db
        .update(releaseItems)
        .set({ outcome: o.outcome, outcomeReason: o.reason ?? null })
        .where(
          and(
            scopeSite(releaseItems.siteId, this.deps.siteId),
            eq(releaseItems.collection, o.collection),
            eq(releaseItems.itemId, o.itemId),
          ),
        );
    }
  }

  private async markStatus(id: string, status: ReleaseStatus, reason: string | null, published = false): Promise<void> {
    await this.deps.db
      .update(releases)
      .set({
        status,
        statusReason: reason,
        updatedAt: new Date(),
        ...(published ? { publishedAt: new Date() } : {}),
      })
      // Idempotent guard: never downgrade a release already published.
      .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, id), ne(releases.status, 'published')));
  }

  private normalizePublishAt(value: string | Date | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ReleaseServiceError('VALIDATION_FAILED', 'Invalid publishAt timestamp.', 422);
    }
    if (date.getTime() < Date.now() - 1000) {
      throw new ReleaseServiceError('VALIDATION_FAILED', 'publishAt cannot be in the past.', 422);
    }
    return date;
  }
}

// ── module helpers ───────────────────────────────────────────────────────────

type ReleaseItemRow = typeof releaseItems.$inferSelect;
interface ItemRowLite {
  id: string;
  status: string;
  deletedAt: Date | null;
  editorialState: string | null;
}

function errCode(err: unknown): string {
  if (err instanceof ItemServiceError) return err.code;
  if (err instanceof ReleaseServiceError) return err.code;
  return 'PUBLISH_ERROR';
}

function decideStatus(outcomes: PublishOutcome[]): ReleaseStatus {
  const failed = outcomes.filter((o) => o.outcome === 'failed').length;
  const published = outcomes.filter((o) => o.outcome === 'published').length;
  if (failed === 0) return 'published';
  if (published === 0) return 'failed';
  return 'partially_failed';
}

function summarize(outcomes: PublishOutcome[]): string {
  const failed = outcomes.filter((o) => o.outcome === 'failed');
  const reasons = [...new Set(failed.map((o) => o.reason ?? 'unknown'))];
  return `${failed.length} item(s) failed: ${reasons.join(', ')}`;
}

/**
 * Scheduler sweep — publish due scheduled releases. Mirrors `sweepDuePublish`
 * in scheduler-worker.ts (idempotent conditional guard, batch-bounded). Called
 * from the shared content-scheduler tick.
 */
export async function sweepDueReleases(
  deps: { db: Database },
  now = new Date(),
  publishFn?: (siteId: string, releaseId: string) => Promise<void>,
): Promise<number> {
  const due = await deps.db
    .select({ id: releases.id, siteId: releases.siteId, maintenanceWindow: releases.maintenanceWindow })
    .from(releases)
    .where(and(eq(releases.status, 'scheduled'), isNotNull(releases.publishAt), lte(releases.publishAt, now)))
    .orderBy(asc(releases.publishAt))
    .limit(100);
  if (due.length === 0) return 0;

  let count = 0;
  for (const row of due) {
    if (!withinMaintenanceWindow(row.maintenanceWindow, now)) continue;
    const publish =
      publishFn ??
      ((siteId: string, releaseId: string) =>
        new ReleaseService({ db: deps.db, siteId }).publish(releaseId, { trigger: 'scheduled' }).then(() => undefined));
    try {
      await publish(row.siteId, row.id);
      count++;
    } catch {
      // Transient failure (DB/queue glitch): leave 'scheduled' for the next
      // tick. Business failures are already captured as release 'failed' by
      // publish() itself, so they won't be re-attempted.
    }
  }
  return count;
}

interface MaintenanceWindow {
  tz?: string;
  windows?: Array<{ dow: number; start: string; end: string }>;
}

/** True when `now` falls inside a declared window (or no window is set). */
export function withinMaintenanceWindow(raw: unknown, now: Date): boolean {
  const mw = raw as MaintenanceWindow | null;
  if (!mw || !mw.windows || mw.windows.length === 0) return true;
  const dow = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const w of mw.windows) {
    if (w.dow !== dow) continue;
    const start = parseHm(w.start);
    const end = parseHm(w.end);
    if (start !== null && end !== null && minutes >= start && minutes <= end) return true;
  }
  return false;
}

function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
