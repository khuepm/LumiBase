import { and, eq, sql } from 'drizzle-orm';
import {
  collections,
  erasureRequests,
  items,
  settings,
  scopeSite,
  type Database,
} from '@lumibase/database';
import { AuditLogger } from '../modules/audit/logger';
import { ItemService } from './item-service';
import { dispatchRevalidation, parseTargets } from './revalidation';

/**
 * GDPR erasure & crypto-shredding (regulated-content-readiness Req 11).
 *
 * Manages the Erasure_Request lifecycle (pending → confirmed → executing →
 * completed | failed) with optional dual-control, executes hard-delete (or
 * crypto-shred) over a subject scope, and records a tamper-evident
 * `data_erased` audit entry that is never cascade-deleted (Req 11.3).
 */

export class ErasureError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ErasureError';
  }
}

export type ErasureAction = 'hard_delete' | 'crypto_shred';

export interface ErasureScope {
  collection: string;
  /** Equality filter matched against item JSONB data (subject identifier). */
  filter: Record<string, unknown>;
}

export interface ErasureServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  actorEmail?: string | null;
}

/** Stable sha256 hex of the subject identifier — never store plaintext (Req 11.3). */
async function hashSubject(scope: ErasureScope): Promise<string> {
  const canonical = JSON.stringify({ collection: scope.collection, filter: scope.filter });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ErasureService {
  constructor(private readonly deps: ErasureServiceDeps) {}

  private itemService(): ItemService {
    return new ItemService({ db: this.deps.db, siteId: this.deps.siteId, userId: this.deps.userId ?? null });
  }

  private async dualControlEnabled(): Promise<boolean> {
    const [row] = await this.deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'erasureDualControl')));
    return row?.value === true || (row?.value as { enabled?: boolean })?.enabled === true;
  }

  /** Create a pending Erasure_Request (Req 11.1). */
  async create(scope: ErasureScope, reason?: string) {
    if (!scope?.collection || !scope.filter || Object.keys(scope.filter).length === 0) {
      throw new ErasureError('INVALID_SCOPE', 'Scope requires a collection and a non-empty filter.', 422);
    }
    const subjectHash = await hashSubject(scope);
    const [row] = await this.deps.db
      .insert(erasureRequests)
      .values({
        siteId: this.deps.siteId,
        scope,
        subjectHash,
        reason: reason ?? null,
        requestedBy: this.deps.userId ?? null,
        status: 'pending',
      })
      .returning();
    return row;
  }

  private async load(id: string) {
    const [row] = await this.deps.db
      .select()
      .from(erasureRequests)
      .where(and(scopeSite(erasureRequests.siteId, this.deps.siteId), eq(erasureRequests.id, id)))
      .limit(1);
    if (!row) throw new ErasureError('NOT_FOUND', `Erasure request "${id}" not found.`, 404);
    return row;
  }

  /** Confirm a pending request; enforces a second admin under dual-control (Req 11.4). */
  async confirm(id: string) {
    const req = await this.load(id);
    if (req.status !== 'pending') {
      throw new ErasureError('INVALID_STATE', `Cannot confirm a request in "${req.status}".`, 409);
    }
    if (await this.dualControlEnabled()) {
      if (req.requestedBy && this.deps.userId && req.requestedBy === this.deps.userId) {
        throw new ErasureError(
          'DUAL_CONTROL_REQUIRED',
          'A second admin must confirm this erasure.',
          409,
        );
      }
    }
    const [row] = await this.deps.db
      .update(erasureRequests)
      .set({ status: 'confirmed', confirmedBy: this.deps.userId ?? null })
      .where(eq(erasureRequests.id, id))
      .returning();
    return row;
  }

  /**
   * Execute a confirmed request: hard-delete (or crypto-shred) every item in
   * scope, record the count + tamper-evident audit, and revalidate (Req 11.2,
   * 11.3, 11.5).
   */
  async execute(id: string, action: ErasureAction = 'hard_delete') {
    const req = await this.load(id);
    if (req.status !== 'confirmed') {
      throw new ErasureError('INVALID_STATE', `Request must be confirmed before execution (is "${req.status}").`, 409);
    }
    await this.deps.db
      .update(erasureRequests)
      .set({ status: 'executing' })
      .where(eq(erasureRequests.id, id));

    try {
      const scope = req.scope as ErasureScope;
      const [coll] = await this.deps.db
        .select({ id: collections.id, name: collections.name })
        .from(collections)
        .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, scope.collection)))
        .limit(1);
      if (!coll) throw new ErasureError('NOT_FOUND', `Collection "${scope.collection}" not found.`, 404);

      // Match subject rows by JSONB containment on item data.
      const matches = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            sql`${items.data} @> ${JSON.stringify(scope.filter)}::jsonb`,
          ),
        );

      const svc = this.itemService();
      let count = 0;
      for (const m of matches) {
        const ok = action === 'crypto_shred'
          ? await svc.cryptoShred(scope.collection, m.id)
          : await svc.hardDelete(scope.collection, m.id);
        if (ok) count += 1;
      }

      // Tamper-evident proof — scope + count + subject hash, no plaintext (Req 11.3).
      await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
        event: 'data_erased',
        actorEmail: this.deps.actorEmail ?? null,
        requestId: null,
        metadata: {
          siteId: this.deps.siteId,
          collection: scope.collection,
          action,
          recordCount: count,
          subjectHash: req.subjectHash,
          requestId: id,
        },
      });

      await this.revalidate(coll.name);

      const [row] = await this.deps.db
        .update(erasureRequests)
        .set({ status: 'completed', recordCount: count, completedAt: new Date() })
        .where(eq(erasureRequests.id, id))
        .returning();
      return row;
    } catch (err) {
      await this.deps.db
        .update(erasureRequests)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(erasureRequests.id, id));
      throw err;
    }
  }

  private async revalidate(collectionName: string): Promise<void> {
    try {
      const [row] = await this.deps.db
        .select()
        .from(settings)
        .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'revalidation.targets')));
      const targets = parseTargets(row?.value);
      if (targets.length > 0) await dispatchRevalidation(targets, [collectionName]);
    } catch {
      // best-effort
    }
  }
}
