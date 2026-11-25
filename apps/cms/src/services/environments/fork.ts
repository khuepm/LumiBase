/**
 * Environment fork worker (#853 tasks 4.1–4.6, 5.1; design §3, §4).
 *
 * A fork copies the origin's schema, access model, non-sensitive settings,
 * side systems (disabled), file metadata and — within `contentScope` — items
 * into the environment's child site, writing a lineage row for every copied
 * row. It runs in steps under a short lease, exactly like background imports
 * (#726) and locale generation (#714): the creating request drives the first
 * steps, the minute tick resumes whatever is left on both runtimes. Every step
 * is idempotent (`ON CONFLICT DO NOTHING` on the copied row and on the lineage
 * unique keys), so a step that died before moving the cursor is simply re-run.
 *
 * Deviation from design §3.1: no `QueueProvider` job — the lease + tick shape
 * needs no new queue binding on Workers and is the pattern the codebase already
 * uses for resumable batch work on both runtimes.
 *
 * Never copied (design §3.5, Req 2.8): API keys, secrets, sessions, audit,
 * revisions, agent memory / trust ledger, releases, content versions,
 * materialized collections, Firebase Sync pipelines, CDC subscriptions and
 * deployments, intents, extensions (the child gets none: official extensions
 * are NOT reconciled into an environment, design §4 item 1a), and settings
 * whose key looks like a secret or an outbound target (`revalidation.*`, …).
 *
 * Runs on the system connection: it reads the origin and writes the child in
 * one job, and every statement names its site explicitly.
 */

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  collections,
  environmentLineage,
  environments,
  fields,
  files,
  flows,
  folders,
  items,
  operations,
  permissions,
  policies,
  relations,
  revisions,
  rolePolicies,
  roles,
  settings,
  webhooks,
  type Database,
} from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { nanoid } from 'nanoid';
import { AuditLogger } from '../../modules/audit/logger';
import { itemServiceForSystem } from '../item-service-factory';
import type { ItemService } from '../item-service';
import { baseOf, canonicalJson, sha256Hex } from './base';
import { fileFieldsOf, rewriteFileIds } from './file-refs';
import { NOTIFICATIONS_KEY } from './isolation';

export const ITEM_BATCH = 100;
export const FILE_BATCH = 500;
const LEASE_MS = 60_000;

export type ContentScope =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'collections'; collections: string[] };

export type ForkPhase = 'schema' | 'access' | 'config' | 'folders' | 'files' | 'items' | 'external' | 'done';
const PHASES: ForkPhase[] = ['schema', 'access', 'config', 'folders', 'files', 'items', 'external', 'done'];

export interface ForkCursor {
  phase: ForkPhase;
  /** Index into the ordered in-scope collection list (phase `items`). */
  collectionIndex?: number;
  /** Last processed id within the current batch scan. */
  afterId?: string | null;
  counts?: Partial<Record<'collections' | 'fields' | 'relations' | 'folders' | 'files' | 'items' | 'external', number>>;
}

export interface ForkDeps {
  /** System connection (crosses the two sites; every statement filters by site). */
  db: Database;
  keyProvider?: KeyProvider;
  encryptionKey?: string;
  now?: () => Date;
}

type EnvironmentRow = typeof environments.$inferSelect;

/**
 * Settings never copied: secrets, outbound targets and per-site machinery.
 * `revalidation.targets` would make environment writes revalidate the
 * production frontend (design §3.5).
 */
const EXCLUDED_SETTING = /(secret|token|password|passwd|credential|api[_-]?key|private|smtp|oauth|saml|sso|scim|webhook|revalidation|firebase|encryption|release|billing|stripe|deploy|domain)/i;

export function isCopyableSetting(key: string): boolean {
  return !EXCLUDED_SETTING.test(key);
}


export function inScope(scope: ContentScope, collection: string): boolean {
  if (scope.mode === 'all') return true;
  if (scope.mode === 'collections') return scope.collections.includes(collection);
  return false;
}

export function parseScope(value: unknown): ContentScope {
  const v = (value ?? {}) as { mode?: unknown; collections?: unknown };
  if (v.mode === 'all') return { mode: 'all' };
  if (v.mode === 'collections' && Array.isArray(v.collections)) {
    return { mode: 'collections', collections: v.collections.filter((c): c is string => typeof c === 'string') };
  }
  return { mode: 'none' };
}

function cursorOf(env: EnvironmentRow): ForkCursor {
  const c = (env.forkCursor ?? {}) as ForkCursor;
  return { phase: PHASES.includes(c.phase) ? c.phase : 'schema', collectionIndex: c.collectionIndex ?? 0, afterId: c.afterId ?? null, counts: c.counts ?? {} };
}

function nextPhase(phase: ForkPhase): ForkPhase {
  return PHASES[Math.min(PHASES.indexOf(phase) + 1, PHASES.length - 1)]!;
}

// ── lease ───────────────────────────────────────────────────────────────────

async function claim(deps: ForkDeps, envId: string, owner: string): Promise<EnvironmentRow | null> {
  const now = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .update(environments)
    .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(
      and(
        eq(environments.id, envId),
        eq(environments.status, 'forking'),
        or(isNull(environments.leaseUntil), lt(environments.leaseUntil, now), eq(environments.leaseOwner, owner)),
      ),
    )
    .returning();
  return row ?? null;
}

async function saveCursor(deps: ForkDeps, env: EnvironmentRow, owner: string, cursor: ForkCursor, extra: Partial<EnvironmentRow> = {}): Promise<boolean> {
  const [row] = await deps.db
    .update(environments)
    .set({ forkCursor: cursor, updatedAt: deps.now?.() ?? new Date(), ...extra })
    .where(and(eq(environments.id, env.id), eq(environments.leaseOwner, owner)))
    .returning({ id: environments.id });
  return !!row;
}

async function release(deps: ForkDeps, envId: string, owner: string): Promise<void> {
  await deps.db
    .update(environments)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(environments.id, envId), eq(environments.leaseOwner, owner)));
}

// ── item services ───────────────────────────────────────────────────────────

function systemItems(deps: ForkDeps, siteId: string): ItemService {
  // Fork copies already-authorised content between two sites of one
  // organization; the admin check ran on the request that created the job.
  return itemServiceForSystem(
    { db: deps.db, siteId, keyProvider: deps.keyProvider, encryptionKey: deps.encryptionKey, suppressExtensionHooks: true },
    'environment-fork',
  );
}

// ── lineage maps ────────────────────────────────────────────────────────────

/** origin row id → environment row id for one lineage kind. */
export async function lineageMap(db: Database, environmentId: string, envSiteId: string, kind: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ envRowId: environmentLineage.envRowId, originRowId: environmentLineage.originRowId })
    .from(environmentLineage)
    .where(and(eq(environmentLineage.siteId, envSiteId), eq(environmentLineage.environmentId, environmentId), eq(environmentLineage.kind, kind)));
  const map = new Map<string, string>();
  for (const r of rows) if (r.originRowId) map.set(r.originRowId, r.envRowId);
  return map;
}

function lineageRow(env: EnvironmentRow, kind: string, envRowId: string, originRowId: string | null, extra: Partial<typeof environmentLineage.$inferInsert> = {}) {
  return { siteId: env.environmentSiteId, environmentId: env.id, kind, envRowId, originRowId, ...extra };
}

/** Canonical schema snapshot of a collection/field/relation row (ids and timestamps dropped). */
export function schemaSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, siteId: _site, collectionId: _coll, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

export async function schemaHash(row: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(schemaSnapshot(row)));
}

// ── phases ──────────────────────────────────────────────────────────────────

async function forkSchema(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  await deps.db.transaction(async (tx) => {
    const done = await lineageMap(tx as unknown as Database, env.id, child, 'collection');
    const originCollections = await tx.select().from(collections).where(eq(collections.siteId, origin)).orderBy(asc(collections.name));
    for (const c of originCollections) {
      if (done.has(c.id)) continue;
      const newId = nanoid();
      const { id: _id, siteId: _s, createdAt: _c, updatedAt: _u, ...rest } = c;
      await tx.insert(collections).values({ ...rest, id: newId, siteId: child });
      await tx.insert(environmentLineage).values(
        lineageRow(env, 'collection', newId, c.id, { collection: c.name, baseHash: await schemaHash(c as Record<string, unknown>), baseSnapshot: schemaSnapshot(c as Record<string, unknown>) }),
      );
      done.set(c.id, newId);
    }
    const nameById = new Map(originCollections.map((c) => [c.id, c.name]));
    const fieldDone = await lineageMap(tx as unknown as Database, env.id, child, 'field');
    const originFields = await tx.select().from(fields).where(eq(fields.siteId, origin));
    for (const f of originFields) {
      if (fieldDone.has(f.id)) continue;
      const collectionId = done.get(f.collectionId);
      if (!collectionId) continue;
      const newId = nanoid();
      const { id: _id, siteId: _s, collectionId: _cid, createdAt: _c, updatedAt: _u, ...rest } = f;
      await tx.insert(fields).values({ ...rest, id: newId, siteId: child, collectionId });
      await tx.insert(environmentLineage).values(
        lineageRow(env, 'field', newId, f.id, {
          collection: nameById.get(f.collectionId) ?? null,
          baseHash: await schemaHash(f as Record<string, unknown>),
          baseSnapshot: schemaSnapshot(f as Record<string, unknown>),
        }),
      );
    }
    const relDone = await lineageMap(tx as unknown as Database, env.id, child, 'relation');
    const originRelations = await tx.select().from(relations).where(eq(relations.siteId, origin));
    for (const r of originRelations) {
      if (relDone.has(r.id)) continue;
      const newId = nanoid();
      const { id: _id, siteId: _s, createdAt: _c, ...rest } = r;
      await tx.insert(relations).values({ ...rest, id: newId, siteId: child });
      await tx.insert(environmentLineage).values(
        lineageRow(env, 'relation', newId, r.id, {
          collection: r.manyCollection,
          baseHash: await schemaHash(r as Record<string, unknown>),
          baseSnapshot: schemaSnapshot(r as Record<string, unknown>),
        }),
      );
    }
    cursor.counts = { ...cursor.counts, collections: originCollections.length, fields: originFields.length, relations: originRelations.length };
  });
  return { ...cursor, phase: nextPhase('schema'), afterId: null };
}

/**
 * Roles, policies, role↔policy links and permissions. The child's
 * administrator/member roles already exist (`provisionSite`); the origin's
 * system roles map onto them, custom roles are copied. Only the fork's creator
 * is a member of the child (Req 2.9): no `user_sites` row is copied.
 */
async function forkAccess(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  await deps.db.transaction(async (tx) => {
    // Idempotency marker: a copied access model leaves a policy in the child.
    const [already] = await tx.select({ id: policies.id }).from(policies).where(eq(policies.siteId, child)).limit(1);
    if (already) return;

    const childRoles = await tx.select().from(roles).where(eq(roles.siteId, child));
    const childBySystemKey = new Map(childRoles.filter((r) => r.systemKey).map((r) => [r.systemKey!, r.id]));
    const originRoles = await tx.select().from(roles).where(eq(roles.siteId, origin));
    const roleMap = new Map<string, string>();
    for (const r of originRoles) {
      const mapped = r.systemKey ? childBySystemKey.get(r.systemKey) : undefined;
      roleMap.set(r.id, mapped ?? nanoid());
    }
    for (const r of originRoles) {
      if (r.systemKey && childBySystemKey.has(r.systemKey)) continue;
      const { id, siteId: _s, createdAt: _c, parentId, ...rest } = r;
      await tx.insert(roles).values({ ...rest, id: roleMap.get(id)!, siteId: child, parentId: parentId ? roleMap.get(parentId) ?? null : null });
    }
    const originPolicies = await tx.select().from(policies).where(eq(policies.siteId, origin));
    const policyMap = new Map(originPolicies.map((p) => [p.id, nanoid()]));
    for (const p of originPolicies) {
      const { id, siteId: _s, createdAt: _c, ...rest } = p;
      await tx.insert(policies).values({ ...rest, id: policyMap.get(id)!, siteId: child });
    }
    if (originPolicies.length > 0) {
      const links = await tx.select().from(rolePolicies).where(inArray(rolePolicies.policyId, [...policyMap.keys()]));
      for (const l of links) {
        const roleId = roleMap.get(l.roleId);
        const policyId = policyMap.get(l.policyId);
        if (roleId && policyId) await tx.insert(rolePolicies).values({ ...l, roleId, policyId }).onConflictDoNothing();
      }
    }
    const originPermissions = await tx.select().from(permissions).where(eq(permissions.siteId, origin));
    for (const p of originPermissions) {
      const policyId = policyMap.get(p.policyId);
      if (!policyId) continue;
      const { id: _id, siteId: _s, ...rest } = p;
      await tx.insert(permissions).values({ ...rest, id: nanoid(), siteId: child, policyId });
    }
  });
  return { ...cursor, phase: nextPhase('access'), afterId: null };
}

/** Settings (filtered), webhooks (inactive, no secret, no headers), flows (inactive). */
async function forkConfig(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  await deps.db.transaction(async (tx) => {
    const originSettings = await tx.select().from(settings).where(eq(settings.siteId, origin));
    for (const s of originSettings) {
      if (!isCopyableSetting(s.key)) continue;
      await tx.insert(settings).values({ siteId: child, key: s.key, value: s.value as object, scope: s.scope }).onConflictDoNothing();
    }
    await tx.insert(settings).values({ siteId: child, key: NOTIFICATIONS_KEY, value: false as unknown as object, scope: 'site' }).onConflictDoNothing();

    const [hasWebhooks] = await tx.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.siteId, child)).limit(1);
    if (!hasWebhooks) {
      const originWebhooks = await tx.select().from(webhooks).where(eq(webhooks.siteId, origin));
      for (const w of originWebhooks) {
        await tx.insert(webhooks).values({
          siteId: child, name: w.name, url: w.url, actions: w.actions, collections: w.collections,
          headers: {}, status: 'inactive', secret: null,
        });
      }
    }
    const [hasFlows] = await tx.select({ id: flows.id }).from(flows).where(eq(flows.siteId, child)).limit(1);
    if (!hasFlows) {
      const originFlows = await tx.select().from(flows).where(eq(flows.siteId, origin));
      for (const f of originFlows) {
        const newId = nanoid();
        const { id, siteId: _s, createdAt: _c, updatedAt: _u, nextRunAt: _n, ...rest } = f;
        await tx.insert(flows).values({ ...rest, id: newId, siteId: child, status: 'inactive', nextRunAt: null });
        const ops = await tx.select().from(operations).where(and(eq(operations.siteId, origin), eq(operations.flowId, id)));
        for (const o of ops) {
          const { id: _oid, siteId: _os, flowId: _f, createdAt: _oc, ...orest } = o;
          await tx.insert(operations).values({ ...orest, id: nanoid(), siteId: child, flowId: newId });
        }
      }
    }
  });
  return { ...cursor, phase: nextPhase('config'), afterId: null };
}

async function forkFolders(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  await deps.db.transaction(async (tx) => {
    const done = await lineageMap(tx as unknown as Database, env.id, child, 'folder');
    const originFolders = await tx.select().from(folders).where(eq(folders.siteId, origin));
    const map = new Map(done);
    for (const f of originFolders) if (!map.has(f.id)) map.set(f.id, nanoid());
    for (const f of originFolders) {
      if (done.has(f.id)) continue;
      await tx.insert(folders).values({ id: map.get(f.id)!, siteId: child, name: f.name, parent: f.parent ? map.get(f.parent) ?? null : null, createdAt: f.createdAt });
      await tx.insert(environmentLineage).values(lineageRow(env, 'folder', map.get(f.id)!, f.id));
    }
    cursor.counts = { ...cursor.counts, folders: originFolders.length };
  });
  return { ...cursor, phase: nextPhase('folders'), afterId: null };
}

/**
 * File metadata only: the copy points at the SAME storage object
 * (`filename_disk`), so no bytes are duplicated (Req 3.1). Deleting a file row
 * never deletes its object today (`DELETE /files/:id`), which keeps the
 * origin's object safe (Req 3.2, design §3.4). Objects that live only in the
 * site-prefixed `/media` library are not shared (v1 limit).
 */
async function forkFiles(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  const folderMap = await lineageMap(deps.db, env.id, child, 'folder');
  const batch = await deps.db
    .select()
    .from(files)
    .where(and(eq(files.siteId, origin), cursor.afterId ? gt(files.id, cursor.afterId) : undefined))
    .orderBy(asc(files.id))
    .limit(FILE_BATCH);
  if (batch.length > 0) {
    await deps.db.transaction(async (tx) => {
      const ids = batch.map((f) => f.id);
      const existing = await tx
        .select({ originRowId: environmentLineage.originRowId })
        .from(environmentLineage)
        .where(and(eq(environmentLineage.siteId, child), eq(environmentLineage.environmentId, env.id), eq(environmentLineage.kind, 'file'), inArray(environmentLineage.originRowId, ids)));
      const skip = new Set(existing.map((e) => e.originRowId));
      for (const f of batch) {
        if (skip.has(f.id)) continue;
        const newId = nanoid();
        const { id: _id, siteId: _s, folder, ...rest } = f;
        await tx.insert(files).values({ ...rest, id: newId, siteId: child, folder: folder ? folderMap.get(folder) ?? null : null });
        await tx.insert(environmentLineage).values(lineageRow(env, 'file', newId, f.id));
      }
    });
  }
  const counts = { ...cursor.counts, files: (cursor.counts?.files ?? 0) + batch.length };
  if (batch.length < FILE_BATCH) return { ...cursor, counts, phase: nextPhase('files'), afterId: null };
  return { ...cursor, counts, afterId: batch[batch.length - 1]!.id };
}

async function scopedCollectionNames(db: Database, siteId: string, scope: ContentScope): Promise<string[]> {
  if (scope.mode === 'none') return [];
  const rows = await db.select({ name: collections.name }).from(collections).where(eq(collections.siteId, siteId)).orderBy(asc(collections.name));
  return rows.map((r) => r.name).filter((n) => inScope(scope, n));
}

/**
 * Items of one in-scope collection, one batch. Each item keeps its id; its
 * encrypted fields are decrypted under the origin's AAD and re-encrypted under
 * the child's (design §2.1); file ids are mapped to the child's file rows; the
 * lineage row carries the base snapshot + SHA-256 (design §14.4).
 */
async function forkItems(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const origin = env.siteId;
  const child = env.environmentSiteId;
  const names = await scopedCollectionNames(deps.db, origin, parseScope(env.contentScope));
  const index = cursor.collectionIndex ?? 0;
  const name = names[index];
  if (!name) return { ...cursor, phase: nextPhase('items'), collectionIndex: 0, afterId: null };

  const [originColl] = await deps.db.select().from(collections).where(and(eq(collections.siteId, origin), eq(collections.name, name))).limit(1);
  const [childColl] = await deps.db.select().from(collections).where(and(eq(collections.siteId, child), eq(collections.name, name))).limit(1);
  if (!originColl || !childColl) return { ...cursor, collectionIndex: index + 1, afterId: null };

  const batch = await deps.db
    .select()
    .from(items)
    .where(and(eq(items.siteId, origin), eq(items.collectionId, originColl.id), isNull(items.deletedAt), cursor.afterId ? gt(items.id, cursor.afterId) : undefined))
    .orderBy(asc(items.id))
    .limit(ITEM_BATCH);

  if (batch.length > 0) {
    const originSvc = systemItems(deps, origin);
    const childSvc = systemItems(deps, child);
    const encrypted = await originSvc.encryptedFieldNames(name);
    const fieldRows = await deps.db.select({ name: fields.name, interface: fields.interface }).from(fields).where(and(eq(fields.siteId, child), eq(fields.collectionId, childColl.id)));
    const fileFields = fileFieldsOf(fieldRows);
    const fileMap = fileFields.size > 0 ? await lineageMap(deps.db, env.id, child, 'file') : new Map<string, string>();
    const ids = batch.map((i) => i.id);
    const latestRevisions = await deps.db
      .selectDistinctOn([revisions.itemId], { itemId: revisions.itemId, id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.siteId, origin), inArray(revisions.itemId, ids), eq(revisions.staged, false)))
      .orderBy(revisions.itemId, sql`${revisions.createdAt} desc`);
    const revisionOf = new Map(latestRevisions.map((r) => [r.itemId, r.id]));

    const prepared: Array<{ row: (typeof batch)[number]; base: { snapshot: Record<string, unknown>; hash: string }; stored: { data: Record<string, unknown>; dekWrapped: string | null } }> = [];
    for (const row of batch) {
      const plain = await originSvc.decryptStoredData(name, row.id, row.data as Record<string, unknown>, row.dekWrapped ?? null);
      const base = await baseOf(plain, encrypted);
      const childPlain = rewriteFileIds(plain, fileFields, fileMap);
      const stored = await childSvc.encryptDataForStorage(name, row.id, childPlain);
      prepared.push({ row, base, stored });
    }

    await deps.db.transaction(async (tx) => {
      for (const { row, base, stored } of prepared) {
        const { siteId: _s, collectionId: _c, data: _d, dekWrapped: _k, version: _v, ...rest } = row;
        await tx
          .insert(items)
          .values({ ...rest, siteId: child, collectionId: childColl.id, data: stored.data, dekWrapped: stored.dekWrapped, version: 0 })
          .onConflictDoNothing();
        await tx
          .insert(environmentLineage)
          .values(lineageRow(env, 'item', row.id, row.id, { collection: name, baseHash: base.hash, baseSnapshot: base.snapshot, baseRevisionId: revisionOf.get(row.id) ?? null }))
          .onConflictDoNothing();
      }
    });
  }

  const counts = { ...cursor.counts, items: (cursor.counts?.items ?? 0) + batch.length };
  if (batch.length < ITEM_BATCH) return { ...cursor, counts, collectionIndex: index + 1, afterId: null };
  return { ...cursor, counts, afterId: batch[batch.length - 1]!.id };
}

/**
 * Mark m2o references from in-scope items to items outside the scope as
 * external (read-only, Req 2.5). The ids are unchanged (identity mapping), so
 * nothing in `data` is rewritten; the lineage row only records that the target
 * is not part of the environment and must never be promoted.
 */
async function forkExternal(deps: ForkDeps, env: EnvironmentRow, cursor: ForkCursor): Promise<ForkCursor> {
  const child = env.environmentSiteId;
  const scope = parseScope(env.contentScope);
  let marked = 0;
  if (scope.mode === 'collections') {
    const rels = await deps.db.select().from(relations).where(and(eq(relations.siteId, child), eq(relations.type, 'm2o')));
    for (const r of rels) {
      if (!inScope(scope, r.manyCollection) || inScope(scope, r.oneCollection)) continue;
      const [coll] = await deps.db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, child), eq(collections.name, r.manyCollection))).limit(1);
      if (!coll) continue;
      const refs = await deps.db
        .selectDistinct({ ref: sql<string>`${items.data} ->> ${r.manyField}` })
        .from(items)
        .where(and(eq(items.siteId, child), eq(items.collectionId, coll.id), sql`${items.data} ->> ${r.manyField} is not null`));
      for (const { ref } of refs) {
        if (!ref) continue;
        const inserted = await deps.db
          .insert(environmentLineage)
          .values(lineageRow(env, 'item', ref, ref, { collection: r.oneCollection, external: true }))
          .onConflictDoNothing()
          .returning({ id: environmentLineage.id });
        marked += inserted.length;
      }
    }
  }
  return { ...cursor, counts: { ...cursor.counts, external: marked }, phase: nextPhase('external'), afterId: null };
}

async function finish(deps: ForkDeps, env: EnvironmentRow, owner: string, cursor: ForkCursor): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const ok = await saveCursor(deps, env, owner, { ...cursor, phase: 'done' }, { status: 'ready', statusReason: null, forkedAt: now, leaseOwner: null, leaseUntil: null });
  if (!ok) return;
  await new AuditLogger({ db: deps.db, siteId: env.siteId }).write({
    event: 'environment_forked',
    siteId: env.siteId,
    metadata: {
      environmentId: env.id,
      environmentSiteId: env.environmentSiteId,
      originSiteId: env.siteId,
      contentScope: env.contentScope,
      itemCount: cursor.counts?.items ?? 0,
      counts: cursor.counts ?? {},
      actorUserId: env.forkedBy,
    },
  });
}

export type ForkStepOutcome = 'progressed' | 'done' | 'busy' | 'failed';

/** Claim the lease, run one chunk of the current phase, move the cursor, release. */
export async function runForkStep(deps: ForkDeps, environmentId: string, owner = nanoid()): Promise<ForkStepOutcome> {
  const env = await claim(deps, environmentId, owner);
  if (!env) return 'busy';
  const cursor = cursorOf(env);
  try {
    let next: ForkCursor;
    switch (cursor.phase) {
      case 'schema': next = await forkSchema(deps, env, cursor); break;
      case 'access': next = await forkAccess(deps, env, cursor); break;
      case 'config': next = await forkConfig(deps, env, cursor); break;
      case 'folders': next = await forkFolders(deps, env, cursor); break;
      case 'files': next = await forkFiles(deps, env, cursor); break;
      case 'items': next = await forkItems(deps, env, cursor); break;
      case 'external': next = await forkExternal(deps, env, cursor); break;
      case 'done': next = cursor; break;
    }
    if (next.phase === 'done') {
      await finish(deps, env, owner, next);
      return 'done';
    }
    const ok = await saveCursor(deps, env, owner, next);
    await release(deps, env.id, owner);
    return ok ? 'progressed' : 'busy';
  } catch (err) {
    // A failed step leaves the cursor where it was: the job is resumable once
    // the cause is fixed (POST /environments/:key/retry re-arms it).
    const reason = err instanceof Error ? err.message.slice(0, 500) : 'Fork step failed.';
    await saveCursor(deps, env, owner, cursor, { status: 'failed', statusReason: reason, leaseOwner: null, leaseUntil: null }).catch(() => undefined);
    console.error('[environments] fork step failed', { environmentId, phase: cursor.phase });
    return 'failed';
  }
}

/** Run steps until the fork ends, another worker holds it, or `budgetMs` is spent. */
export async function driveFork(deps: ForkDeps, environmentId: string, budgetMs: number): Promise<ForkStepOutcome> {
  const started = Date.now();
  const owner = nanoid();
  let outcome: ForkStepOutcome = 'progressed';
  while (outcome === 'progressed' && Date.now() - started < budgetMs) {
    outcome = await runForkStep(deps, environmentId, owner);
  }
  return outcome;
}

/**
 * Minute tick: resume forks whose lease is free (crash, restart, a request
 * that ran out of budget). One job per origin site first, so one site's fork
 * cannot starve another's.
 */
export async function runEnvironmentForkTick(deps: ForkDeps, opts: { budgetMs?: number; limit?: number } = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.status, 'forking'), or(isNull(environments.leaseUntil), lt(environments.leaseUntil, now))))
    .orderBy(asc(environments.updatedAt))
    .limit(opts.limit ?? 5);
  const budget = opts.budgetMs ?? 45_000;
  const started = Date.now();
  let stepped = 0;
  for (const { id } of due) {
    const left = budget - (Date.now() - started);
    if (left <= 0) break;
    try {
      await driveFork(deps, id, left);
      stepped += 1;
    } catch (err) {
      console.error('[environments] fork tick failed', { environmentId: id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return stepped;
}
