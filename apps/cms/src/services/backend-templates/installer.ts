import { and, eq, sql } from 'drizzle-orm';
import {
  backendTemplateInstallations,
  backendTemplatePlans,
  type Database,
} from '@lumibase/database';
import {
  applyNamespace,
  templateDigest,
  validateBackendTemplate,
  type BackendTemplate,
  type TemplatePlanBinding,
} from '@lumibase/contracts/backend-templates';
import type { CacheProvider, EdgeCacheProvider, QueueProvider } from '@lumibase/runtime';
import { SchemaService, SchemaServiceError, type CollectionInput, type FieldInput, type RelationInput } from '../schema-service';
import { AuditLogger } from '../../modules/audit/logger';
import { invalidateDeliverTag } from '../content-invalidation';
import { CDC_DISPATCH_QUEUE } from '../../modules/cdc/change-feed/dispatcher';
import { PlanError, bindingMismatches, schemaFingerprint, type PlanRow } from './planner';

/**
 * Template installer (#904, BT04).
 *
 * One plan → one atomic install: schema (collections, fields, relations), the
 * optional seed (BT05 hook) and the installation provenance commit together
 * in ONE database transaction, or nothing does. There is no
 * non-transactional fallback: a runtime without `db.transaction` is refused.
 *
 * Inside the transaction a per-site advisory lock serialises installs; under
 * it the plan, its expiry, the target schema fingerprint and the caller's
 * authorization are checked again, so a schema change or a revoked admin
 * between preview and apply is refused before any write. Create-only is
 * enforced by SchemaService itself (an existing name is COLLECTION_EXISTS →
 * NAME_CONFLICT) inside the lock.
 *
 * The idempotency key is bound to the plan payload: a retry with the same key
 * and payload returns the committed installation (no new rows, no new
 * events); the same key with another payload is IDEMPOTENCY_CONFLICT.
 *
 * Effects that leave the database — cache invalidation, CDC dispatch, the
 * success audit — run only after commit. Schema change events are outbox rows
 * written in the transaction, so a rollback leaves none.
 */

export type InstallStep = 'locked' | 'collections' | 'fields' | 'relations' | 'seed' | 'provenance';

/** Writes the selected seed pack inside the install transaction (BT05). */
export type SeedHook = (ctx: {
  tx: Database;
  siteId: string;
  template: BackendTemplate;
  pack: string;
}) => Promise<{ records: number; keys: Record<string, string> }>;

export interface InstallerDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  cache?: CacheProvider;
  edgeCache?: EdgeCacheProvider;
  queue?: QueueProvider;
  /** Re-checked under the lock: may the caller still install into this site? */
  authorize?: () => Promise<boolean>;
  seed?: SeedHook;
  /** Fault-injection seam for tests; runs inside the transaction after each step. */
  onStep?: (step: InstallStep) => void | Promise<void>;
  now?: () => Date;
  requestId?: string | null;
}

export type InstallationRow = typeof backendTemplateInstallations.$inferSelect;

export class InstallError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'IDEMPOTENCY_CONFLICT' | 'NAME_CONFLICT' | 'INCOMPATIBLE_RUNTIME' | 'BINDING_MISMATCH',
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

async function sha256(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The payload an idempotency key is bound to. */
export function installPayloadDigest(plan: Pick<PlanRow, 'id' | 'siteId' | 'digest' | 'namespaceMap' | 'seedPack'>): Promise<string> {
  return sha256(JSON.stringify([plan.siteId, plan.id, plan.digest, plan.namespaceMap, plan.seedPack ?? null]));
}

type TxDatabase = Database & { transaction?: <T>(fn: (tx: Database) => Promise<T>) => Promise<T> };

export class BackendTemplateInstaller {
  constructor(private readonly deps: InstallerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The installation a plan produced (#906: an agent reads the result of an approved install by planId). */
  async getByPlan(planId: string): Promise<InstallationRow> {
    const [row] = await this.deps.db
      .select()
      .from(backendTemplateInstallations)
      .where(and(eq(backendTemplateInstallations.siteId, this.deps.siteId), eq(backendTemplateInstallations.planId, planId)))
      .limit(1);
    if (!row) throw new InstallError('NOT_FOUND', 'Installation not found.', 404);
    return row;
  }

  async get(installationId: string): Promise<InstallationRow> {
    const [row] = await this.deps.db
      .select()
      .from(backendTemplateInstallations)
      .where(and(eq(backendTemplateInstallations.siteId, this.deps.siteId), eq(backendTemplateInstallations.id, installationId)))
      .limit(1);
    if (!row) throw new InstallError('NOT_FOUND', 'Installation not found.', 404);
    return row;
  }

  private async byKey(db: Database, key: string): Promise<InstallationRow | null> {
    const [row] = await db
      .select()
      .from(backendTemplateInstallations)
      .where(and(eq(backendTemplateInstallations.siteId, this.deps.siteId), eq(backendTemplateInstallations.idempotencyKey, key)))
      .limit(1);
    return row ?? null;
  }

  private replay(existing: InstallationRow, payloadDigest: string): { installation: InstallationRow; replayed: true } {
    if (existing.payloadDigest !== payloadDigest) {
      throw new InstallError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different install.', 409);
    }
    return { installation: existing, replayed: true };
  }

  /**
   * Applies a plan. @returns the installation; `replayed` when the same key
   * and payload had already committed.
   */
  /**
   * `expect` (#906): the binding an approval was granted for. When given, the
   * plan must still match it exactly — target site, template, version, digest,
   * seed choice, namespace and target fingerprint — and its stored snapshot
   * must still hash to its digest, checked under the install lock. A mismatch
   * is BINDING_MISMATCH: nothing is written and the plan is invalidated, so a
   * new plan and a new approval are needed.
   */
  async install(input: { planId: string; idempotencyKey: string; expect?: TemplatePlanBinding }): Promise<{ installation: InstallationRow; replayed: boolean }> {
    if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
      throw new InstallError('VALIDATION', 'idempotencyKey must be 1-128 characters of [A-Za-z0-9_.:-].', 400);
    }
    const db = this.deps.db as TxDatabase;
    if (typeof db.transaction !== 'function') {
      throw new InstallError('INCOMPATIBLE_RUNTIME', 'This runtime cannot install a template in one transaction.', 422);
    }
    const [plan] = await db
      .select()
      .from(backendTemplatePlans)
      .where(and(eq(backendTemplatePlans.siteId, this.deps.siteId), eq(backendTemplatePlans.id, input.planId)))
      .limit(1);
    if (!plan) throw new InstallError('NOT_FOUND', 'Plan not found.', 404);
    const payloadDigest = await installPayloadDigest(plan);

    const committed = await this.byKey(db, input.idempotencyKey);
    if (committed) return this.replay(committed, payloadDigest);

    let created: string[] = [];
    let staleMark: 'expired' | 'invalidated' | null = null;
    try {
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`backend-template-install:${this.deps.siteId}`}))`);
        await this.deps.onStep?.('locked');

        // A duplicate that waited for the lock finds the committed install.
        const raced = await this.byKey(tx, input.idempotencyKey);
        if (raced) return this.replay(raced, payloadDigest);

        const [current] = await tx
          .select()
          .from(backendTemplatePlans)
          .where(and(eq(backendTemplatePlans.siteId, this.deps.siteId), eq(backendTemplatePlans.id, plan.id)))
          .limit(1);
        if (!current || !['planned', 'awaiting_approval'].includes(current.status)) {
          throw new PlanError('STALE_PLAN', `The plan is ${current?.status ?? 'gone'}; plan again.`, 409);
        }
        if (input.expect) {
          const mismatched = bindingMismatches(current, input.expect);
          if (mismatched.length === 0 && (await templateDigest(current.snapshot as BackendTemplate)) !== current.digest) {
            mismatched.push('snapshot');
          }
          if (mismatched.length > 0) {
            staleMark = 'invalidated';
            throw new InstallError('BINDING_MISMATCH', `The approved install no longer matches the plan (${mismatched.join(', ')}); plan and approve again.`, 409);
          }
        }
        if (current.expiresAt.getTime() <= this.now().getTime()) {
          staleMark = 'expired';
          throw new PlanError('STALE_PLAN', 'The plan expired; plan again.', 409);
        }
        if (this.deps.authorize && !(await this.deps.authorize())) {
          throw new InstallError('FORBIDDEN', 'You may no longer install into this site.', 403);
        }
        const { fingerprint } = await schemaFingerprint(tx, this.deps.siteId);
        if (fingerprint !== current.targetFingerprint) {
          staleMark = 'invalidated';
          throw new PlanError('STALE_PLAN', 'The target schema changed since the plan was made; plan again.', 409);
        }

        const mapped = applyNamespace(current.snapshot as BackendTemplate, current.namespaceMap as Record<string, string>);
        const valid = validateBackendTemplate(mapped);
        if (!valid.ok) throw new PlanError('INVALID_TEMPLATE', 'The planned template is no longer valid.', 422, { errors: valid.errors });
        const template = valid.template;

        // Transaction-bound schema writes: no cache and no queue here, so
        // nothing outside the database sees an uncommitted install.
        const schema = new SchemaService({ db: tx, siteId: this.deps.siteId });
        try {
          for (const { ...collection } of template.config.collections) {
            await schema.createCollection(collection as unknown as CollectionInput);
          }
          await this.deps.onStep?.('collections');
          for (const { collection, field, ...rest } of template.config.fields) {
            await schema.createField(collection, { name: field, ...rest } as unknown as FieldInput);
          }
          await this.deps.onStep?.('fields');
          for (const relation of template.config.relations) {
            await schema.createRelation({ ...relation } as unknown as RelationInput);
          }
          await this.deps.onStep?.('relations');
        } catch (err) {
          if (err instanceof SchemaServiceError && err.code === 'COLLECTION_EXISTS') {
            throw new InstallError('NAME_CONFLICT', err.message, 409);
          }
          throw err;
        }

        let seed = { records: 0, keys: {} as Record<string, string> };
        if (current.seedPack) {
          if (!this.deps.seed) throw new InstallError('INCOMPATIBLE_RUNTIME', 'Seed installation is not available here.', 422);
          seed = await this.deps.seed({ tx, siteId: this.deps.siteId, template, pack: current.seedPack });
          await this.deps.onStep?.('seed');
        }

        const [installation] = await tx
          .insert(backendTemplateInstallations)
          .values({
            siteId: this.deps.siteId,
            planId: current.id,
            idempotencyKey: input.idempotencyKey,
            payloadDigest,
            sourceKind: current.sourceKind,
            sourceSiteId: current.sourceSiteId,
            slug: current.slug,
            templateVersion: current.templateVersion,
            digest: current.digest,
            namespaceMap: current.namespaceMap,
            seedPack: current.seedPack,
            baseline: template,
            resources: {
              collections: template.config.collections.map((c) => c.name),
              fields: template.config.fields.length,
              relations: template.config.relations.length,
              seedRecords: seed.records,
              seedKeys: seed.keys,
            },
            createdBy: this.deps.userId ?? null,
          })
          .returning();
        await this.deps.onStep?.('provenance');
        await tx
          .update(backendTemplatePlans)
          .set({ status: 'completed', updatedAt: this.now() })
          .where(and(eq(backendTemplatePlans.siteId, this.deps.siteId), eq(backendTemplatePlans.id, current.id)));
        created = template.config.collections.map((c) => c.name);
        return { installation: installation!, replayed: false as const };
      });

      if (!outcome.replayed) await this.afterCommit(outcome.installation, created);
      return outcome;
    } catch (err) {
      if (staleMark) {
        await db
          .update(backendTemplatePlans)
          .set({ status: staleMark, updatedAt: this.now() })
          .where(and(eq(backendTemplatePlans.siteId, this.deps.siteId), eq(backendTemplatePlans.id, plan.id), eq(backendTemplatePlans.status, 'planned')))
          .catch(() => undefined);
      }
      // Failure audit is separate from the rolled-back install. No seed payloads.
      await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
        siteId: this.deps.siteId,
        event: 'backend_template_install_failed',
        requestId: this.deps.requestId ?? null,
        metadata: {
          planId: plan.id,
          slug: plan.slug,
          templateVersion: plan.templateVersion,
          code: (err as { code?: unknown }).code ?? 'ERROR',
          actorUserId: this.deps.userId ?? null,
        },
      }).catch(() => undefined);
      throw err;
    }
  }

  /** Effects outside the database, strictly after commit. */
  private async afterCommit(installation: InstallationRow, collectionNames: string[]): Promise<void> {
    const { cache, edgeCache, queue, siteId } = this.deps;
    if (cache) {
      const live = new SchemaService({ db: this.deps.db, siteId, cache, edgeCache });
      const { forgetNegative, negativeCollectionKey } = await import('../negative-cache');
      for (const name of collectionNames) {
        await live.invalidate(name).catch(() => undefined);
        await forgetNegative(cache, negativeCollectionKey(siteId, name)).catch(() => undefined);
      }
      await cache.delete(`typegen:${siteId}`).catch(() => undefined);
      await cache.delete(`typegen:${siteId}:schema`).catch(() => undefined);
      await cache.delete(`perm:${siteId}:schema`).catch(() => undefined);
      await invalidateDeliverTag(cache, siteId, edgeCache).catch(() => undefined);
    }
    if (queue) {
      await queue.enqueue(CDC_DISPATCH_QUEUE, 'dispatch', { siteId }).catch(() => undefined);
    }
    await new AuditLogger({ db: this.deps.db, siteId }).write({
      siteId,
      event: 'backend_template_installed',
      requestId: this.deps.requestId ?? null,
      metadata: {
        installationId: installation.id,
        planId: installation.planId,
        slug: installation.slug,
        templateVersion: installation.templateVersion,
        digest: installation.digest,
        seedPack: installation.seedPack,
        collections: collectionNames,
        actorUserId: this.deps.userId ?? null,
      },
    }).catch(() => undefined);
  }
}
