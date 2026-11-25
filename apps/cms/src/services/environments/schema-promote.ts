/**
 * Schema_Promote (#853 task 6, design §7, Req 7).
 *
 * Brings the environment's schema changes back to its origin. Rows are matched
 * by LINEAGE, not by name, so a field renamed in the environment is promoted
 * as a rename (`renameFrom`) instead of a delete + create, and the origin's
 * data under the old key moves with it.
 *
 * Per row (collection, field, relation) three hashes decide the action, with
 * the same table as content (design §8.1): base (lineage, at fork / last
 * promote), environment now, origin now.
 *
 *   env = base, origin = base → unchanged       env ≠ base, origin = base → apply
 *   env = base, origin ≠ base → origin-only     env ≠ base, origin ≠ base → conflict
 *   env row, no lineage       → create          lineage, env row gone     → delete
 *
 * A conflict blocks the apply until the caller resolves it (`take: 'origin'`
 * keeps the origin, `take: 'environment'` applies the environment's row).
 * Risky changes (type change, rename, delete) need `confirmRiskyChange`, and a
 * type change also a `migrationPlan` naming a `strategy` (Req 7.3) — the plan
 * is passed to SchemaService's guard, which does not execute plans (B213), so a
 * type change does not convert existing values (documented v1 limit).
 *
 * The apply runs in ONE transaction on the origin through SchemaService, so it
 * is all-or-nothing. Lineage is updated afterwards on the system connection: if
 * that update is lost, the next dry-run sees origin = environment and reports
 * `unchanged`, so nothing is applied twice.
 *
 * Not undoable (design §10.3): the UI says so before it lets anyone apply.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  collections,
  environmentLineage,
  environmentMergeRuns,
  fields,
  items,
  relations,
  type Database,
} from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { AuditLogger } from '../../modules/audit/logger';
import { SchemaService, SchemaServiceError, type CollectionInput, type FieldInput, type RelationInput } from '../schema-service';
import { EnvironmentError } from './errors';
import type { EnvironmentRow } from './environment-service';
import { schemaHash, schemaSnapshot } from './fork';
import { acquireMergeLock, releaseMergeLock } from './lock';

export type SchemaKind = 'collection' | 'field' | 'relation';
export type SchemaAction = 'unchanged' | 'origin-only' | 'create' | 'update' | 'rename' | 'delete' | 'conflict' | 'blocked';

export interface SchemaPlanEntry {
  kind: SchemaKind;
  /** `collection` | `collection.field` | `manyCollection.manyField` — in the environment's names. */
  key: string;
  /** Collection the entry belongs to. */
  collection: string;
  action: SchemaAction;
  /** Origin name of a field being renamed. */
  renameFrom?: string;
  /** Changed properties (update / rename / conflict). */
  changes?: string[];
  risk: 'low' | 'medium' | 'high';
  /** What an apply needs for this entry. */
  requires?: Array<'confirmRiskyChange' | 'migrationPlan'>;
  /** Why it is a conflict or blocked. */
  reason?: string;
  /** How the caller resolved a conflict. */
  resolution?: 'origin' | 'environment';
  envRowId?: string;
  originRowId?: string;
  lineageId?: string;
}

export interface SchemaPlan {
  entries: SchemaPlanEntry[];
  counts: Record<SchemaAction, number>;
  /** Collections whose schema differs between environment and origin (content gate, Req 8.5). */
  pendingCollections: string[];
  clean: boolean;
}

export interface SchemaResolution {
  kind: SchemaKind;
  key: string;
  take: 'origin' | 'environment';
}

export interface SchemaPromoteOptions {
  dryRun: boolean;
  resolutions?: SchemaResolution[];
  confirmRiskyChange?: boolean;
  /** `{ "posts.author": { strategy: "..." } }` for type changes. */
  migrationPlans?: Record<string, Record<string, unknown>>;
}

export interface SchemaPromoteDeps {
  /** Origin-scoped connection (the request's). */
  db: Database;
  /** Reads the child site and writes lineage. */
  systemDb: Database;
  userId: string;
  cache?: CacheProvider;
}

type CollectionRow = typeof collections.$inferSelect;
type FieldRow = typeof fields.$inferSelect;
type RelationRow = typeof relations.$inferSelect;
type LineageRow = typeof environmentLineage.$inferSelect;

const ACTIONS: SchemaAction[] = ['unchanged', 'origin-only', 'create', 'update', 'rename', 'delete', 'conflict', 'blocked'];

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).sort();
}

interface SchemaState {
  collections: CollectionRow[];
  fields: FieldRow[];
  relations: RelationRow[];
}

async function loadState(db: Database, siteId: string): Promise<SchemaState> {
  const [c, f, r] = await Promise.all([
    db.select().from(collections).where(eq(collections.siteId, siteId)),
    db.select().from(fields).where(eq(fields.siteId, siteId)),
    db.select().from(relations).where(eq(relations.siteId, siteId)),
  ]);
  return { collections: c, fields: f, relations: r };
}

interface Row {
  id: string;
  key: string;
  collection: string;
  name: string;
  hash: string;
  snapshot: Record<string, unknown>;
  raw: Record<string, unknown>;
}

async function rowsOf(kind: SchemaKind, state: SchemaState): Promise<Row[]> {
  const nameById = new Map(state.collections.map((c) => [c.id, c.name]));
  const out: Row[] = [];
  if (kind === 'collection') {
    for (const c of state.collections) {
      out.push({ id: c.id, key: c.name, collection: c.name, name: c.name, hash: await schemaHash(c), snapshot: schemaSnapshot(c), raw: c });
    }
  } else if (kind === 'field') {
    for (const f of state.fields) {
      const collection = nameById.get(f.collectionId) ?? '';
      out.push({ id: f.id, key: `${collection}.${f.name}`, collection, name: f.name, hash: await schemaHash(f), snapshot: schemaSnapshot(f), raw: f });
    }
  } else {
    for (const r of state.relations) {
      out.push({ id: r.id, key: `${r.manyCollection}.${r.manyField}`, collection: r.manyCollection, name: r.manyField, hash: await schemaHash(r), snapshot: schemaSnapshot(r), raw: r });
    }
  }
  return out;
}

/**
 * Build the plan. Pure apart from reads: the environment's and the origin's
 * schema rows and the environment's schema lineage.
 */
export async function buildSchemaPlan(deps: Pick<SchemaPromoteDeps, 'systemDb'>, env: EnvironmentRow): Promise<SchemaPlan> {
  const db = deps.systemDb;
  const [envState, originState, lineage] = await Promise.all([
    loadState(db, env.environmentSiteId),
    loadState(db, env.siteId),
    db
      .select()
      .from(environmentLineage)
      .where(
        and(
          eq(environmentLineage.siteId, env.environmentSiteId),
          eq(environmentLineage.environmentId, env.id),
          inArray(environmentLineage.kind, ['collection', 'field', 'relation']),
        ),
      ),
  ]);
  const entries: SchemaPlanEntry[] = [];
  for (const kind of ['collection', 'field', 'relation'] as const) {
    const envRows = await rowsOf(kind, envState);
    const originRows = await rowsOf(kind, originState);
    const originById = new Map(originRows.map((r) => [r.id, r]));
    const originByKey = new Map(originRows.map((r) => [r.key, r]));
    const lin = lineage.filter((l) => l.kind === kind);
    const linByEnv = new Map(lin.map((l) => [l.envRowId, l]));
    const envIds = new Set(envRows.map((r) => r.id));

    for (const e of envRows) {
      entries.push(classifySchemaRow(kind, e, linByEnv.get(e.id) ?? null, originById, originByKey));
    }
    // Lineage whose environment row is gone: deleted in the environment.
    for (const l of lin) {
      if (envIds.has(l.envRowId) || !l.originRowId) continue;
      const o = originById.get(l.originRowId);
      const base = (l.baseSnapshot ?? {}) as Record<string, unknown>;
      const key = o?.key ?? keyFromSnapshot(kind, l, base);
      const collection = o?.collection ?? l.collection ?? key.split('.')[0] ?? '';
      if (!o) {
        entries.push({ kind, key, collection, action: 'unchanged', risk: 'low', lineageId: l.id });
      } else if (o.hash !== l.baseHash) {
        entries.push({ kind, key, collection, action: 'conflict', reason: 'DELETED_IN_ENVIRONMENT_CHANGED_IN_ORIGIN', risk: 'high', originRowId: o.id, lineageId: l.id });
      } else {
        entries.push({ kind, key, collection, action: 'delete', risk: kind === 'relation' ? 'medium' : 'high', requires: ['confirmRiskyChange'], originRowId: o.id, lineageId: l.id });
      }
    }
  }
  entries.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.key.localeCompare(b.key));
  return summarize(entries);
}

function keyFromSnapshot(kind: SchemaKind, l: LineageRow, base: Record<string, unknown>): string {
  if (kind === 'collection') return String(base.name ?? l.collection ?? '');
  if (kind === 'field') return `${l.collection ?? ''}.${String(base.name ?? '')}`;
  return `${String(base.manyCollection ?? '')}.${String(base.manyField ?? '')}`;
}

function kindOrder(kind: SchemaKind): number {
  return kind === 'collection' ? 0 : kind === 'field' ? 1 : 2;
}

function summarize(entries: SchemaPlanEntry[]): SchemaPlan {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<SchemaAction, number>;
  for (const e of entries) counts[e.action] += 1;
  const pending = new Set<string>();
  for (const e of entries) if (!['unchanged', 'origin-only'].includes(e.action)) pending.add(e.collection);
  return { entries, counts, pendingCollections: [...pending].sort(), clean: pending.size === 0 };
}

function classifySchemaRow(
  kind: SchemaKind,
  e: Row,
  lin: LineageRow | null,
  originById: Map<string, Row>,
  originByKey: Map<string, Row>,
): SchemaPlanEntry {
  const common = { kind, key: e.key, collection: e.collection, envRowId: e.id };
  if (!lin || !lin.originRowId) {
    const taken = originByKey.get(e.key);
    if (taken) {
      return taken.hash === e.hash
        ? { ...common, action: 'unchanged', risk: 'low', originRowId: taken.id, lineageId: lin?.id }
        : { ...common, action: 'conflict', reason: 'NAME_TAKEN_IN_ORIGIN', risk: 'medium', originRowId: taken.id, changes: changedKeys(taken.snapshot, e.snapshot), lineageId: lin?.id };
    }
    const requiresNonNull = kind === 'field' && e.raw.nullable === false;
    return { ...common, action: 'create', risk: requiresNonNull ? 'medium' : 'low', lineageId: lin?.id };
  }
  const base = (lin.baseSnapshot ?? {}) as Record<string, unknown>;
  const o = originById.get(lin.originRowId);
  const envChanged = e.hash !== lin.baseHash;
  const withLin = { ...common, lineageId: lin.id, originRowId: lin.originRowId };
  if (!o) {
    return envChanged
      ? { ...withLin, action: 'conflict', reason: 'DELETED_IN_ORIGIN', risk: 'high' }
      : { ...withLin, action: 'origin-only', risk: 'low' };
  }
  const originChanged = o.hash !== lin.baseHash;
  if (!envChanged) return { ...withLin, action: originChanged ? 'origin-only' : 'unchanged', risk: 'low' };
  const changes = changedKeys(base, e.snapshot);
  if (originChanged) {
    if (o.hash === e.hash) return { ...withLin, action: 'unchanged', risk: 'low' };
    return { ...withLin, action: 'conflict', reason: 'CHANGED_IN_BOTH', risk: 'high', changes };
  }
  return applyEntry(kind, withLin, e, o, changes);
}

function applyEntry(kind: SchemaKind, common: Omit<SchemaPlanEntry, 'action' | 'risk'>, e: Row, o: Row, changes: string[]): SchemaPlanEntry {
  if (kind === 'collection' && e.name !== o.name) {
    return { ...common, action: 'blocked', reason: 'COLLECTION_RENAME_UNSUPPORTED', risk: 'high', changes };
  }
  if (kind === 'relation' && (e.raw.manyCollection !== o.raw.manyCollection || e.raw.manyField !== o.raw.manyField)) {
    return { ...common, action: 'blocked', reason: 'RELATION_IDENTITY_CHANGED', risk: 'high', changes };
  }
  if (kind === 'field') {
    if (e.raw.encrypted !== o.raw.encrypted) {
      return { ...common, action: 'blocked', reason: 'ENCRYPTION_CHANGE_UNSUPPORTED', risk: 'high', changes };
    }
    const renamed = e.name !== o.name;
    if (renamed && o.raw.encrypted) {
      // The field name is part of the ciphertext's AAD: moving the values would break them.
      return { ...common, action: 'blocked', reason: 'ENCRYPTED_FIELD_RENAME_UNSUPPORTED', risk: 'high', changes };
    }
    const typeChanged = e.raw.type !== o.raw.type;
    const requires: Array<'confirmRiskyChange' | 'migrationPlan'> = [];
    if (renamed || typeChanged) requires.push('confirmRiskyChange');
    if (typeChanged) requires.push('migrationPlan');
    return {
      ...common,
      action: renamed ? 'rename' : 'update',
      renameFrom: renamed ? o.name : undefined,
      risk: typeChanged || renamed ? 'high' : 'low',
      changes,
      requires: requires.length > 0 ? requires : undefined,
    };
  }
  if (kind === 'relation' && e.raw.onDelete === 'cascade' && o.raw.onDelete !== 'cascade') {
    return { ...common, action: 'update', risk: 'high', requires: ['confirmRiskyChange'], changes };
  }
  return { ...common, action: 'update', risk: kind === 'collection' ? 'medium' : 'low', changes };
}

/** Fold resolutions into the plan; unresolved conflicts stay conflicts. */
export function resolvePlan(plan: SchemaPlan, resolutions: SchemaResolution[] = []): SchemaPlan {
  const byKey = new Map(resolutions.map((r) => [`${r.kind}:${r.key}`, r.take]));
  const entries = plan.entries.map((e): SchemaPlanEntry => {
    if (e.action !== 'conflict') return e;
    const take = byKey.get(`${e.kind}:${e.key}`);
    if (!take) return e;
    if (take === 'origin') return { ...e, action: 'origin-only', resolution: 'origin' };
    if (!e.envRowId) return { ...e, action: 'delete', resolution: 'environment', requires: ['confirmRiskyChange'] };
    if (e.reason === 'DELETED_IN_ORIGIN' || e.reason === 'NAME_TAKEN_IN_ORIGIN') {
      return e.reason === 'DELETED_IN_ORIGIN'
        ? { ...e, action: 'create', resolution: 'environment', originRowId: undefined }
        : { ...e, action: 'update', resolution: 'environment' };
    }
    return { ...e, action: 'update', resolution: 'environment', requires: ['confirmRiskyChange'] };
  });
  return summarize(entries);
}

/** Every reason an apply must not start (Req 7.3, 7.4). Empty = go. */
export function applyBlockers(plan: SchemaPlan, opts: SchemaPromoteOptions): Array<{ code: string; key: string; kind: SchemaKind; message: string }> {
  const out: Array<{ code: string; key: string; kind: SchemaKind; message: string }> = [];
  for (const e of plan.entries) {
    if (e.action === 'blocked') out.push({ code: e.reason ?? 'BLOCKED', key: e.key, kind: e.kind, message: `${e.kind} "${e.key}" cannot be promoted (${e.reason}).` });
    if (e.action === 'conflict') out.push({ code: 'UNRESOLVED_CONFLICTS', key: e.key, kind: e.kind, message: `${e.kind} "${e.key}" changed in both sites; resolve it with take: origin | environment.` });
    if (['create', 'update', 'rename', 'delete'].includes(e.action)) {
      if (e.requires?.includes('confirmRiskyChange') && opts.confirmRiskyChange !== true) {
        out.push({ code: 'RISKY_CHANGE_UNCONFIRMED', key: e.key, kind: e.kind, message: `${e.action} of ${e.kind} "${e.key}" needs confirmRiskyChange: true.` });
      }
      if (e.requires?.includes('migrationPlan')) {
        const plan = opts.migrationPlans?.[e.key];
        if (!plan || typeof plan.strategy !== 'string' || plan.strategy.trim() === '') {
          out.push({ code: 'MIGRATION_PLAN_REQUIRED', key: e.key, kind: e.kind, message: `Type change of "${e.key}" needs migrationPlans["${e.key}"].strategy.` });
        }
      }
    }
  }
  return out;
}

function collectionInput(raw: Record<string, unknown>): CollectionInput {
  const { id: _id, siteId: _s, createdAt: _c, updatedAt: _u, ...rest } = raw;
  return rest as unknown as CollectionInput;
}

function fieldInput(raw: Record<string, unknown>): FieldInput {
  const { id: _id, siteId: _s, collectionId: _cid, createdAt: _c, updatedAt: _u, ...rest } = raw;
  return rest as unknown as FieldInput;
}

function relationInput(raw: Record<string, unknown>): RelationInput {
  const { id: _id, siteId: _s, createdAt: _c, ...rest } = raw;
  return rest as unknown as RelationInput;
}

export interface SchemaPromoteResult {
  dryRun: boolean;
  plan: SchemaPlan;
  mergeRunId?: string;
  applied?: Record<string, number>;
}

/**
 * Dry-run (`dryRun: true`, writes nothing) or apply. Apply: lock → plan →
 * blockers (422) → one origin transaction → lineage → merge run + audit.
 */
export async function promoteSchema(deps: SchemaPromoteDeps, env: EnvironmentRow, opts: SchemaPromoteOptions): Promise<SchemaPromoteResult> {
  if (env.status !== 'ready' && env.status !== 'merging') {
    throw new EnvironmentError('ENVIRONMENT_NOT_READY', `Environment is ${env.status}.`, 409);
  }
  if (opts.dryRun) {
    const plan = resolvePlan(await buildSchemaPlan(deps, env), opts.resolutions);
    return { dryRun: true, plan };
  }

  await acquireMergeLock(deps.db, env);
  try {
    const plan = resolvePlan(await buildSchemaPlan(deps, env), opts.resolutions);
    const blockers = applyBlockers(plan, opts);
    if (blockers.length > 0) {
      throw new EnvironmentError(blockers.some((b) => b.code === 'UNRESOLVED_CONFLICTS') ? 'UNRESOLVED_CONFLICTS' : blockers[0]!.code, blockers[0]!.message, 422, { blockers, plan });
    }
    const work = plan.entries.filter((e) => ['create', 'update', 'rename', 'delete'].includes(e.action));
    const [run] = await deps.db
      .insert(environmentMergeRuns)
      .values({ siteId: env.siteId, environmentId: env.id, kind: 'schema', status: 'running', plan: { entries: work.map(({ kind, key, action, renameFrom, changes, resolution }) => ({ kind, key, action, renameFrom, changes, resolution })) }, startedBy: deps.userId })
      .returning();
    try {
      if (work.length > 0) await applyWithin(deps, env, work, opts);
    } catch (err) {
      await deps.db
        .update(environmentMergeRuns)
        .set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'failed', finishedAt: new Date() })
        .where(and(eq(environmentMergeRuns.siteId, env.siteId), eq(environmentMergeRuns.id, run!.id)));
      if (err instanceof SchemaServiceError) {
        throw new EnvironmentError(err.code, err.message, 422);
      }
      throw err;
    }
    await refreshSchemaLineage(deps, env, work);
    const applied = Object.fromEntries(['create', 'update', 'rename', 'delete'].map((a) => [a, work.filter((w) => w.action === a).length]));
    await deps.db
      .update(environmentMergeRuns)
      .set({ status: 'succeeded', counts: applied, outcomes: work.map((w) => ({ kind: w.kind, key: w.key, action: w.action, outcome: 'applied' })), finishedAt: new Date() })
      .where(and(eq(environmentMergeRuns.siteId, env.siteId), eq(environmentMergeRuns.id, run!.id)));
    await new AuditLogger({ db: deps.db, siteId: env.siteId }).write({
      event: 'environment_schema_promoted',
      siteId: env.siteId,
      metadata: { environmentId: env.id, originSiteId: env.siteId, mergeRunId: run!.id, counts: applied, keys: work.map((w) => `${w.kind}:${w.key}:${w.action}`).slice(0, 200), actorUserId: deps.userId },
    });
    return { dryRun: false, plan, mergeRunId: run!.id, applied };
  } finally {
    await releaseMergeLock(deps.db, env);
  }
}

async function applyWithin(deps: SchemaPromoteDeps, env: EnvironmentRow, work: SchemaPlanEntry[], opts: SchemaPromoteOptions): Promise<void> {
  const envState = await loadState(deps.systemDb, env.environmentSiteId);
  const envById = new Map<string, Record<string, unknown>>([
    ...envState.collections.map((c) => [c.id, c] as const),
    ...envState.fields.map((f) => [f.id, f] as const),
    ...envState.relations.map((r) => [r.id, r] as const),
  ]);
  const envCollectionName = new Map(envState.collections.map((c) => [c.id, c.name]));

  await deps.db.transaction(async (tx) => {
    const schema = new SchemaService({ db: tx as unknown as Database, siteId: env.siteId });
    const originState = await loadState(tx as unknown as Database, env.siteId);
    const originById = new Map<string, Record<string, unknown>>([
      ...originState.collections.map((c) => [c.id, c] as const),
      ...originState.fields.map((f) => [f.id, f] as const),
      ...originState.relations.map((r) => [r.id, r] as const),
    ]);
    const originCollectionName = new Map(originState.collections.map((c) => [c.id, c.name]));
    const by = (kind: SchemaKind, actions: SchemaAction[]) => work.filter((w) => w.kind === kind && actions.includes(w.action));

    // 1. Collections: create and update first, so fields have a home.
    for (const w of by('collection', ['create', 'update'])) {
      const raw = envById.get(w.envRowId!)!;
      const input = collectionInput(raw);
      if (w.action === 'create') await schema.createCollection(input);
      else {
        const { name: _n, ...patch } = input;
        await schema.updateCollection(String(originById.get(w.originRowId!)?.name ?? raw.name), patch);
      }
    }
    // 2. Fields.
    for (const w of by('field', ['create', 'update', 'rename'])) {
      const raw = envById.get(w.envRowId!)!;
      const collection = envCollectionName.get(String(raw.collectionId))!;
      const input = { ...fieldInput(raw), confirmRiskyChange: opts.confirmRiskyChange === true, migrationPlan: opts.migrationPlans?.[w.key] };
      if (w.action === 'create') {
        await schema.createField(collection, input);
      } else if (w.action === 'update') {
        await schema.updateField(collection, String(originById.get(w.originRowId!)!.name), input);
      } else {
        const from = w.renameFrom!;
        await schema.renameField(collection, from, input);
        await moveDataKey(tx as unknown as Database, env.siteId, collection, from, input.name);
      }
    }
    // 3. Relations (no in-place update in SchemaService: replace the row).
    for (const w of by('relation', ['create', 'update'])) {
      const input = relationInput(envById.get(w.envRowId!)!);
      if (w.action === 'update') await schema.deleteRelation(w.originRowId!);
      await schema.createRelation(input);
    }
    // 4. Deletes, most dependent first.
    for (const w of by('relation', ['delete'])) await schema.deleteRelation(w.originRowId!);
    for (const w of by('field', ['delete'])) {
      const raw = originById.get(w.originRowId!)!;
      await schema.deleteField(originCollectionName.get(String(raw.collectionId))!, String(raw.name), { confirmRiskyChange: true, force: true });
    }
    for (const w of by('collection', ['delete'])) {
      await schema.deleteCollection(String(originById.get(w.originRowId!)!.name));
    }
  });
}

/**
 * A promoted rename keeps the origin's values: `data[from]` moves to
 * `data[to]` in every origin item of the collection (SchemaService renames
 * the field row only). Counts as a content change: `version` moves.
 */
async function moveDataKey(db: Database, siteId: string, collection: string, from: string, to: string): Promise<void> {
  const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, collection))).limit(1);
  if (!coll) return;
  await db
    .update(items)
    .set({
      data: sql`(${items.data} - ${from}::text) || jsonb_build_object(${to}::text, ${items.data} -> ${from}::text)`,
      version: sql`${items.version} + 1`,
    })
    .where(and(eq(items.siteId, siteId), eq(items.collectionId, coll.id), sql`${items.data} ? ${from}::text`));
}

/** After a successful apply, the origin row IS the new base for every applied entry. */
async function refreshSchemaLineage(deps: SchemaPromoteDeps, env: EnvironmentRow, work: SchemaPlanEntry[]): Promise<void> {
  const db = deps.systemDb;
  const originState = await loadState(db, env.siteId);
  const envState = await loadState(db, env.environmentSiteId);
  for (const kind of ['collection', 'field', 'relation'] as const) {
    const originRows = await rowsOf(kind, originState);
    const envRows = await rowsOf(kind, envState);
    const originByKey = new Map(originRows.map((r) => [r.key, r]));
    const envById = new Map(envRows.map((r) => [r.id, r]));
    for (const w of work.filter((x) => x.kind === kind)) {
      if (w.action === 'delete') {
        if (w.lineageId) await db.delete(environmentLineage).where(and(eq(environmentLineage.siteId, env.environmentSiteId), eq(environmentLineage.id, w.lineageId)));
        continue;
      }
      const e = envById.get(w.envRowId!);
      const o = e ? originByKey.get(e.key) : undefined;
      if (!e || !o) continue;
      const values = { originRowId: o.id, baseHash: o.hash, baseSnapshot: o.snapshot, collection: o.collection, updatedAt: new Date() };
      if (w.lineageId) {
        await db.update(environmentLineage).set(values).where(and(eq(environmentLineage.siteId, env.environmentSiteId), eq(environmentLineage.id, w.lineageId)));
      } else {
        await db
          .insert(environmentLineage)
          .values({ siteId: env.environmentSiteId, environmentId: env.id, kind, envRowId: e.id, ...values })
          .onConflictDoUpdate({ target: [environmentLineage.environmentId, environmentLineage.kind, environmentLineage.envRowId], set: values });
      }
    }
  }
}
