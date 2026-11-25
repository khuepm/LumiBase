/**
 * Content_Promote — one-way, conflict-aware (#853 task 7, design §8, §10,
 * Req 8 + 10). The v1 stopping point: an item whose origin moved away from the
 * base is NEVER overwritten; it is reported as a conflict and left alone.
 *
 * Per item (classify.ts): base snapshot (lineage), environment now, origin
 * now — all in the origin's id space (file ids mapped back via lineage) and
 * with encrypted fields compared by hash.
 *
 * Writes go through the CALLER's origin ItemService (`itemServiceForRequest`):
 * permissions, validation, editorial gate, pinned fields, hooks and revisions
 * behave exactly as for a normal edit (Req 8.7). Every update carries the
 * origin version the plan was computed against (`If-Match`, Req 6.5), so an
 * origin edit that lands between plan and write turns the item into a
 * `conflict` instead of being overwritten.
 *
 * Atomic per item, resumable per run (design §10.2): ItemService takes no
 * transaction across items, so a run that dies half-way leaves the applied
 * items applied — their lineage base already moved, so the next run classifies
 * them `unchanged` and writes nothing twice.
 *
 * What is promoted: `data`. Status, publish window and sort stay the origin's
 * (an item CREATED in the origin takes the environment's status through the
 * editorial gate). Files referenced by a promoted item that exist only in the
 * environment are registered in the origin as metadata rows on the same
 * storage object, so the reference resolves there (Req 3.3).
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  collections,
  environmentLineage,
  environmentMergeRuns,
  environments,
  fields,
  files,
  items,
  relations,
  revisions,
  type Database,
} from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { nanoid } from 'nanoid';
import { AuditLogger } from '../../modules/audit/logger';
import { itemServiceForSystem } from '../item-service-factory';
import { ItemServiceError, type ItemService } from '../item-service';
import { baseOf, type ItemData } from './base';
import { classify, type PromoteAction } from './classify';
import { EnvironmentError } from './errors';
import type { EnvironmentRow } from './environment-service';
import { collectFileIds, fileFieldsOf, rewriteFileIds, type FileFieldKind } from './file-refs';
import { lineageMap } from './fork';
import { acquireMergeLock, releaseMergeLock } from './lock';
import { buildSchemaPlan } from './schema-promote';

/** Items looked at per run; more → `truncated`, run again. */
export const MAX_ITEMS_PER_RUN = 2_000;

export type ContentOutcome = 'promoted' | 'created' | 'deleted' | 'conflict' | 'skipped' | 'failed' | 'unchanged';

export interface ContentPlanItem {
  collection: string;
  itemId: string;
  action: PromoteAction | 'blocked';
  reason?: string;
  /** Top-level fields that differ between environment and origin (names only). */
  changedFields?: string[];
}

export interface ContentPlan {
  items: ContentPlanItem[];
  counts: Record<string, number>;
  truncated: boolean;
}

export interface ContentOutcomeRow {
  collection: string;
  itemId: string;
  action: string;
  outcome: ContentOutcome;
  reason?: string;
  revisionId?: string | null;
}

export interface ContentPromoteOptions {
  dryRun: boolean;
  /** Only these items; omitted = every item changed in the environment. */
  items?: Array<{ collection: string; itemId: string }>;
}

export interface ContentPromoteDeps {
  /** Origin-scoped request connection. */
  db: Database;
  /** Reads the child site and writes lineage. */
  systemDb: Database;
  /** The CALLER's ItemService for the origin (RBAC enforced). Built per run with the run's provenance. */
  originItems: (provenance: { environmentId: string; mergeRunId: string | null }) => ItemService;
  keyProvider?: KeyProvider;
  encryptionKey?: string;
  userId: string;
}

interface Candidate {
  collection: string;
  id: string;
  envDeleted: boolean;
  envStatus: string;
  /** Environment plaintext mapped to origin file ids. */
  data: ItemData;
  envHash: string;
  envSnapshot: ItemData;
  origin: { version: number; hash: string; data: ItemData } | null;
  lineage: { id: string; baseHash: string | null; external: boolean } | null;
  /** Environment-only files the data references (need a row in the origin). */
  newFiles: string[];
  m2oRefs: string[];
  encrypted: Set<string>;
}

interface Prepared {
  candidates: Candidate[];
  plan: ContentPlan;
  /** env file id → origin file id. */
  fileMap: Map<string, string>;
  truncated: boolean;
}

function systemSvc(deps: ContentPromoteDeps, siteId: string): ItemService {
  return itemServiceForSystem(
    { db: deps.systemDb, siteId, keyProvider: deps.keyProvider, encryptionKey: deps.encryptionKey, suppressExtensionHooks: true },
    'environment-fork',
  );
}

function changedFields(a: ItemData, b: ItemData): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).sort();
}

async function prepare(deps: ContentPromoteDeps, env: EnvironmentRow, opts: ContentPromoteOptions): Promise<Prepared> {
  const db = deps.systemDb;
  const child = env.environmentSiteId;
  const origin = env.siteId;
  const schemaPlan = await buildSchemaPlan(deps, env);
  const pending = new Set(schemaPlan.pendingCollections);

  const [envColls, originColls] = await Promise.all([
    db.select().from(collections).where(eq(collections.siteId, child)),
    db.select().from(collections).where(eq(collections.siteId, origin)),
  ]);
  const envCollById = new Map(envColls.map((c) => [c.id, c]));
  const originCollByName = new Map(originColls.map((c) => [c.name, c]));

  // Candidates: env items written after the fork, or deleted, or explicitly named.
  const selected = opts.items && opts.items.length > 0 ? opts.items : null;
  const since = env.forkedAt ?? new Date(0);
  const rows = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.siteId, child),
        selected
          ? inArray(items.id, [...new Set(selected.map((s) => s.itemId))])
          : or(gt(items.updatedAt, since), isNotNull(items.deletedAt)),
      ),
    )
    .orderBy(asc(items.id))
    .limit(MAX_ITEMS_PER_RUN + 1);
  const truncated = rows.length > MAX_ITEMS_PER_RUN;
  const scoped = rows
    .slice(0, MAX_ITEMS_PER_RUN)
    .filter((r) => !selected || selected.some((s) => s.itemId === r.id && s.collection === envCollById.get(r.collectionId)?.name));

  const ids = scoped.map((r) => r.id);
  const lineageRows = ids.length
    ? await db
        .select()
        .from(environmentLineage)
        .where(and(eq(environmentLineage.siteId, child), eq(environmentLineage.environmentId, env.id), eq(environmentLineage.kind, 'item'), inArray(environmentLineage.envRowId, ids)))
    : [];
  const lineageById = new Map(lineageRows.map((l) => [l.envRowId, l]));
  const originRows = ids.length ? await db.select().from(items).where(and(eq(items.siteId, origin), inArray(items.id, ids))) : [];
  const originById = new Map(originRows.map((r) => [r.id, r]));

  // env file id → origin file id, from file lineage.
  const originToEnvFile = await lineageMap(db, env.id, child, 'file');
  const fileMap = new Map([...originToEnvFile].map(([o, e]) => [e, o]));

  const envSvc = systemSvc(deps, child);
  const originSvc = systemSvc(deps, origin);
  const fieldCache = new Map<string, { fileFields: Map<string, FileFieldKind>; m2o: string[]; encrypted: Set<string> }>();
  const shapeOf = async (collectionId: string, name: string) => {
    const hit = fieldCache.get(collectionId);
    if (hit) return hit;
    const fieldRows = await db.select({ name: fields.name, interface: fields.interface }).from(fields).where(and(eq(fields.siteId, child), eq(fields.collectionId, collectionId)));
    const rels = await db.select({ manyField: relations.manyField }).from(relations).where(and(eq(relations.siteId, child), eq(relations.manyCollection, name), eq(relations.type, 'm2o')));
    const shape = { fileFields: fileFieldsOf(fieldRows), m2o: rels.map((r) => r.manyField), encrypted: await envSvc.encryptedFieldNames(name) };
    fieldCache.set(collectionId, shape);
    return shape;
  };

  const candidates: Candidate[] = [];
  const planItems: ContentPlanItem[] = [];
  for (const row of scoped) {
    const coll = envCollById.get(row.collectionId);
    if (!coll) continue;
    const shape = await shapeOf(row.collectionId, coll.name);
    const plain = await envSvc.decryptStoredData(coll.name, row.id, row.data as ItemData, row.dekWrapped ?? null);
    const data = rewriteFileIds(plain, shape.fileFields, fileMap);
    const env_ = await baseOf(data, shape.encrypted);
    const o = originById.get(row.id);
    const originAlive = o && !o.deletedAt && originCollByName.get(coll.name)?.id === o.collectionId ? o : null;
    let originState: Candidate['origin'] = null;
    if (originAlive) {
      const oPlain = await originSvc.decryptStoredData(coll.name, o!.id, o!.data as ItemData, o!.dekWrapped ?? null);
      originState = { version: originAlive.version, hash: (await baseOf(oPlain, shape.encrypted)).hash, data: oPlain };
    } else if (o && !o.deletedAt) {
      // Same id taken by another collection of the origin.
      originState = { version: o.version, hash: 'other-collection', data: {} };
    }
    const lin = lineageById.get(row.id);
    const lineage = lin ? { id: lin.id, baseHash: lin.baseHash, external: lin.external } : null;
    const c: Candidate = {
      collection: coll.name,
      id: row.id,
      envDeleted: !!row.deletedAt,
      envStatus: row.status,
      data,
      envHash: env_.hash,
      envSnapshot: env_.snapshot,
      origin: originState,
      lineage,
      newFiles: collectFileIds(data, shape.fileFields).filter((f) => !fileMap.has(f) && ![...fileMap.values()].includes(f)),
      m2oRefs: shape.m2o.map((f) => data[f]).filter((v): v is string => typeof v === 'string' && v.length > 0),
      encrypted: shape.encrypted,
    };
    const cls = classify({ lineage, origin: originState ? { hash: originState.hash } : null, env: { hash: c.envHash, deleted: c.envDeleted } });
    let item: ContentPlanItem = { collection: c.collection, itemId: c.id, action: cls.action, reason: cls.reason };
    if ((cls.action === 'promote' || cls.action === 'create' || cls.action === 'delete') && (pending.has(c.collection) || !originCollByName.has(c.collection))) {
      item = { ...item, action: 'blocked', reason: 'SCHEMA_NOT_PROMOTED' };
    }
    if (item.action === 'promote' || item.action === 'conflict') item.changedFields = changedFields(originState?.data ?? {}, data);
    candidates.push(c);
    planItems.push(item);
  }

  // Dependencies: an m2o reference must resolve in the origin, or be created in this run.
  const creating = new Set(planItems.filter((p) => p.action === 'create').map((p) => p.itemId));
  const refIds = [...new Set(candidates.flatMap((c) => c.m2oRefs))];
  const originHas = new Set(
    refIds.length ? (await db.select({ id: items.id }).from(items).where(and(eq(items.siteId, origin), inArray(items.id, refIds), sql`${items.deletedAt} is null`))).map((r) => r.id) : [],
  );
  for (let i = 0; i < planItems.length; i += 1) {
    const p = planItems[i]!;
    if (p.action !== 'promote' && p.action !== 'create') continue;
    const missing = candidates[i]!.m2oRefs.filter((r) => !originHas.has(r) && !creating.has(r));
    if (missing.length > 0) planItems[i] = { ...p, action: 'blocked', reason: 'DEPENDENCY_NOT_PROMOTED' };
  }
  // A blocked create can no longer satisfy others: iterate to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    const stillCreating = new Set(planItems.filter((p) => p.action === 'create').map((p) => p.itemId));
    for (let i = 0; i < planItems.length; i += 1) {
      const p = planItems[i]!;
      if (p.action !== 'promote' && p.action !== 'create') continue;
      if (candidates[i]!.m2oRefs.some((r) => !originHas.has(r) && !stillCreating.has(r))) {
        planItems[i] = { ...p, action: 'blocked', reason: 'DEPENDENCY_NOT_PROMOTED' };
        changed = true;
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const p of planItems) counts[p.action] = (counts[p.action] ?? 0) + 1;
  return { candidates, plan: { items: planItems, counts, truncated }, fileMap, truncated };
}

/** Creates in dependency order; references inside a cycle are written in a second pass. */
export function orderCreates(creates: Array<{ id: string; refs: string[] }>): { order: string[]; deferred: Map<string, string[]> } {
  const ids = new Set(creates.map((c) => c.id));
  const refsOf = new Map(creates.map((c) => [c.id, c.refs.filter((r) => ids.has(r) && r !== c.id)]));
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const deferred = new Map<string, string[]>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    visiting.add(id);
    for (const r of refsOf.get(id) ?? []) {
      if (done.has(r)) continue;
      if (visiting.has(r)) {
        deferred.set(id, [...(deferred.get(id) ?? []), r]);
        continue;
      }
      visit(r);
    }
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const c of creates) visit(c.id);
  return { order, deferred };
}

export interface ContentPromoteResult {
  dryRun: boolean;
  plan: ContentPlan;
  mergeRunId?: string;
  outcomes?: ContentOutcomeRow[];
  counts?: Record<string, number>;
}

export async function promoteContent(deps: ContentPromoteDeps, env: EnvironmentRow, opts: ContentPromoteOptions): Promise<ContentPromoteResult> {
  if (env.status !== 'ready') throw new EnvironmentError(env.status === 'merging' ? 'ENVIRONMENT_BUSY' : 'ENVIRONMENT_NOT_READY', `Environment is ${env.status}.`, 409);
  if (opts.dryRun) {
    const { plan } = await prepare(deps, env, opts);
    return { dryRun: true, plan };
  }

  await acquireMergeLock(deps.db, env);
  let mergeRunId: string | null = null;
  try {
    const prepared = await prepare(deps, env, opts);
    const [run] = await deps.db
      .insert(environmentMergeRuns)
      .values({
        siteId: env.siteId,
        environmentId: env.id,
        kind: 'content',
        status: 'running',
        plan: { counts: prepared.plan.counts, truncated: prepared.truncated, items: prepared.plan.items.map(({ collection, itemId, action, reason }) => ({ collection, itemId, action, reason })) },
        startedBy: deps.userId,
      })
      .returning();
    mergeRunId = run!.id;
    const outcomes = await applyPlan(deps, env, prepared, mergeRunId);
    const counts: Record<string, number> = {};
    for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    await deps.db
      .update(environmentMergeRuns)
      .set({ status: 'succeeded', outcomes, counts, finishedAt: new Date() })
      .where(and(eq(environmentMergeRuns.siteId, env.siteId), eq(environmentMergeRuns.id, mergeRunId)));
    await new AuditLogger({ db: deps.db, siteId: env.siteId }).write({
      event: 'environment_content_promoted',
      siteId: env.siteId,
      metadata: { environmentId: env.id, originSiteId: env.siteId, mergeRunId, counts, truncated: prepared.truncated, actorUserId: deps.userId },
    });
    await releaseMergeLock(deps.db, env, (counts.promoted ?? 0) + (counts.created ?? 0) + (counts.deleted ?? 0) > 0 ? { mergedAt: new Date() } : {});
    return { dryRun: false, plan: prepared.plan, mergeRunId, outcomes, counts };
  } catch (err) {
    if (mergeRunId) {
      await deps.db
        .update(environmentMergeRuns)
        .set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'failed', finishedAt: new Date() })
        .where(and(eq(environmentMergeRuns.siteId, env.siteId), eq(environmentMergeRuns.id, mergeRunId)))
        .catch(() => undefined);
    }
    await releaseMergeLock(deps.db, env).catch(() => undefined);
    throw err;
  }
}

function failureReason(err: unknown): string {
  if (err instanceof ItemServiceError) return err.code;
  if (err instanceof EnvironmentError) return err.code;
  return 'WRITE_FAILED';
}

async function applyPlan(deps: ContentPromoteDeps, env: EnvironmentRow, prepared: Prepared, mergeRunId: string): Promise<ContentOutcomeRow[]> {
  const svc = deps.originItems({ environmentId: env.id, mergeRunId });
  const outcomes: ContentOutcomeRow[] = [];
  const byIndex = prepared.plan.items.map((p, i) => ({ p, c: prepared.candidates[i]! }));
  const fileMap = prepared.fileMap;

  // Files that exist only in the environment: register them in the origin first.
  const neededFiles = [...new Set(byIndex.filter(({ p }) => p.action === 'promote' || p.action === 'create').flatMap(({ c }) => c.newFiles))];
  if (neededFiles.length > 0) await promoteFiles(deps, env, neededFiles, fileMap);
  const remap = (c: Candidate) => {
    // Re-map the env ids of files registered just now.
    if (c.newFiles.length === 0) return c.data;
    const swap = new Map(c.newFiles.filter((f) => fileMap.has(f)).map((f) => [f, fileMap.get(f)!]));
    return Object.fromEntries(
      Object.entries(c.data).map(([k, v]) => [k, typeof v === 'string' && swap.has(v) ? swap.get(v) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' && swap.has(x) ? swap.get(x) : x)) : v]),
    );
  };

  for (const { p, c } of byIndex) {
    if (!['promote', 'create', 'delete'].includes(p.action)) {
      outcomes.push({ collection: p.collection, itemId: p.itemId, action: p.action, outcome: p.action === 'unchanged' || p.action === 'origin-only' ? 'unchanged' : p.action === 'conflict' ? 'conflict' : p.action === 'blocked' ? 'failed' : 'skipped', reason: p.reason });
    }
  }

  // 1. Creates, dependency order; cyclic references patched afterwards.
  const creates = byIndex.filter(({ p }) => p.action === 'create');
  const createById = new Map(creates.map((x) => [x.c.id, x]));
  const { order, deferred } = orderCreates(creates.map(({ c }) => ({ id: c.id, refs: c.m2oRefs })));
  const created = new Set<string>();
  for (const id of order) {
    const { p, c } = createById.get(id)!;
    const data = remap(c);
    const deferredFields = Object.keys(data).filter((k) => typeof data[k] === 'string' && (deferred.get(id) ?? []).includes(data[k] as string));
    const first = Object.fromEntries(Object.entries(data).filter(([k]) => !deferredFields.includes(k)));
    try {
      await svc.create(p.collection, { data: first, status: c.envStatus }, { fixedId: c.id });
      created.add(id);
      outcomes.push({ collection: p.collection, itemId: id, action: 'create', outcome: 'created', revisionId: await latestRevision(deps, env.siteId, id) });
      if (deferredFields.length === 0) await recordBase(deps, env, c, 'create');
    } catch (err) {
      outcomes.push({ collection: p.collection, itemId: id, action: 'create', outcome: 'failed', reason: failureReason(err) });
    }
  }
  for (const [id, refs] of deferred) {
    if (!created.has(id)) continue;
    const { p, c } = createById.get(id)!;
    const data = remap(c);
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string' && refs.includes(v)));
    try {
      await svc.patch(p.collection, id, { data: patch });
      await recordBase(deps, env, c, 'create');
    } catch (err) {
      const row = outcomes.find((o) => o.itemId === id && o.action === 'create');
      if (row) Object.assign(row, { outcome: 'failed', reason: `CYCLE_PATCH_${failureReason(err)}` });
    }
  }

  // 2. Updates with the plan's origin version as precondition.
  for (const { p, c } of byIndex.filter(({ p }) => p.action === 'promote')) {
    const data = remap(c);
    const cleared = Object.fromEntries(Object.keys(c.origin?.data ?? {}).filter((k) => !(k in data)).map((k) => [k, null]));
    try {
      await svc.patch(p.collection, c.id, { data: { ...cleared, ...data } }, { expectedVersions: [c.origin!.version] });
      outcomes.push({ collection: p.collection, itemId: c.id, action: 'promote', outcome: 'promoted', revisionId: await latestRevision(deps, env.siteId, c.id) });
      await recordBase(deps, env, c, 'promote');
    } catch (err) {
      const reason = failureReason(err);
      outcomes.push({ collection: p.collection, itemId: c.id, action: 'promote', outcome: reason === 'PRECONDITION_FAILED' ? 'conflict' : 'failed', reason: reason === 'PRECONDITION_FAILED' ? 'ORIGIN_CHANGED' : reason });
    }
  }

  // 3. Deletes: soft delete, only while the origin is still at the planned version.
  for (const { p, c } of byIndex.filter(({ p }) => p.action === 'delete')) {
    try {
      const [now] = await deps.systemDb.select({ version: items.version }).from(items).where(and(eq(items.siteId, env.siteId), eq(items.id, c.id))).limit(1);
      if (!now || now.version !== c.origin?.version) {
        outcomes.push({ collection: p.collection, itemId: c.id, action: 'delete', outcome: 'conflict', reason: 'ORIGIN_CHANGED' });
        continue;
      }
      await svc.softDelete(p.collection, c.id);
      outcomes.push({ collection: p.collection, itemId: c.id, action: 'delete', outcome: 'deleted' });
    } catch (err) {
      outcomes.push({ collection: p.collection, itemId: c.id, action: 'delete', outcome: 'failed', reason: failureReason(err) });
    }
  }
  return outcomes;
}

async function latestRevision(deps: ContentPromoteDeps, siteId: string, itemId: string): Promise<string | null> {
  const [row] = await deps.systemDb
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.siteId, siteId), eq(revisions.itemId, itemId), eq(revisions.staged, false)))
    .orderBy(desc(revisions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The origin's state after the write is the new base (Req 8.8): read back the
 * stored row (ItemService may normalise what it was given) and hash that.
 */
async function recordBase(deps: ContentPromoteDeps, env: EnvironmentRow, c: Candidate, action: 'promote' | 'create'): Promise<void> {
  const [row] = await deps.systemDb
    .select({ data: items.data, dekWrapped: items.dekWrapped })
    .from(items)
    .where(and(eq(items.siteId, env.siteId), eq(items.id, c.id)))
    .limit(1);
  if (!row) return;
  const plain = await systemSvc(deps, env.siteId).decryptStoredData(c.collection, c.id, row.data as ItemData, row.dekWrapped ?? null);
  const base = await baseOf(plain, c.encrypted);
  const values = { baseHash: base.hash, baseSnapshot: base.snapshot, baseRevisionId: await latestRevision(deps, env.siteId, c.id), updatedAt: new Date() };
  if (action === 'promote' && c.lineage) {
    await deps.systemDb.update(environmentLineage).set(values).where(and(eq(environmentLineage.siteId, env.environmentSiteId), eq(environmentLineage.id, c.lineage.id)));
    return;
  }
  await deps.systemDb
    .insert(environmentLineage)
    .values({ siteId: env.environmentSiteId, environmentId: env.id, kind: 'item', collection: c.collection, envRowId: c.id, originRowId: c.id, ...values })
    .onConflictDoUpdate({ target: [environmentLineage.environmentId, environmentLineage.kind, environmentLineage.envRowId], set: { ...values, originRowId: c.id } });
}

/** Register environment-only files in the origin: metadata row, same storage object. */
async function promoteFiles(deps: ContentPromoteDeps, env: EnvironmentRow, envFileIds: string[], fileMap: Map<string, string>): Promise<void> {
  const rows = await deps.systemDb.select().from(files).where(and(eq(files.siteId, env.environmentSiteId), inArray(files.id, envFileIds)));
  for (const f of rows) {
    const originId = nanoid();
    const { id: _id, siteId: _s, folder: _folder, ...rest } = f;
    await deps.systemDb.insert(files).values({ ...rest, id: originId, siteId: env.siteId, folder: null });
    await deps.systemDb
      .insert(environmentLineage)
      .values({ siteId: env.environmentSiteId, environmentId: env.id, kind: 'file', envRowId: f.id, originRowId: originId })
      .onConflictDoNothing();
    fileMap.set(f.id, originId);
  }
}

/** Fresh environment row (status may have moved since the caller loaded it). */
export async function reloadEnvironment(db: Database, env: EnvironmentRow): Promise<EnvironmentRow> {
  const [row] = await db.select().from(environments).where(and(eq(environments.siteId, env.siteId), eq(environments.id, env.id))).limit(1);
  if (!row) throw new EnvironmentError('NOT_FOUND', 'Environment not found.', 404);
  return row;
}
