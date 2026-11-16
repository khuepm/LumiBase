/**
 * Caller-scoped content access for draft review (Jev J05, #512).
 *
 * Reads go through an ItemService bound to the caller (`itemServiceForRequest`
 * on a request, `itemServiceForPrincipal` in a worker), so row rules, field
 * masks, decryption and site scope are exactly what the caller's own token
 * gets on `/items`. Field-level visibility is computed from the same compiled
 * permission (`PermissionService.canAccess` + `applyFieldMask`) so a masked
 * field is reported as omitted instead of silently reading as empty.
 */

import { revisions, type Database } from '@lumibase/database';
import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import { and, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { ItemServiceError, type ItemService } from './item-service';
import {
  itemServiceForPrincipal,
  itemServiceForRequest,
  itemServiceForSystem,
  permissionServiceForRequest,
} from './item-service-factory';
import { applyFieldMask, type MagicContext } from './permission-dsl';
import { PermissionService, type CompiledPermission } from './permission-service';
import { ReviewServiceError, type ReviewContentAccess } from './review-service';
import { SchemaService } from './schema-service';

function visibleFields(known: string[], perm: CompiledPermission): Set<string> {
  return new Set(perm.fields.length === 1 && perm.fields[0] === '*' ? known : applyFieldMask(known, perm.fields));
}

async function latestRevisionId(db: Database, siteId: string, itemId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.siteId, siteId), eq(revisions.itemId, itemId), eq(revisions.staged, false)))
    .orderBy(desc(revisions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

interface ContentAccessDeps {
  db: Database;
  siteId: string;
  permissions: PermissionService;
  /** A caller-bound ItemService, built lazily per read. */
  items: () => ItemService;
  schema: SchemaService;
}

function reviewContentAccess({ db, siteId, permissions, items, schema }: ContentAccessDeps): ReviewContentAccess {
  const knownFields = async (collection: string): Promise<string[]> => {
    const compiled = await schema.getCompiled(collection);
    if (!compiled) throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', `Collection "${collection}" not found.`);
    return compiled.fields.map((field) => field.name);
  };

  return {
    async readItem(collection, itemId, fields) {
      const known = await knownFields(collection);
      const perm = await permissions.canAccess(collection, 'read');
      if (!perm) throw new ReviewServiceError('FORBIDDEN', `Reading "${collection}" is not allowed.`);
      const readable = visibleFields(known, perm);
      const readableFields = fields.filter((field) => readable.has(field));
      const omittedFields = fields.filter((field) => !readable.has(field));

      let row: Record<string, unknown>;
      try {
        row = (await items().detail(
          collection,
          itemId,
          readableFields.length > 0 ? readableFields : ['id'],
        )) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ItemServiceError && error.status === 404) {
          throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', `Item "${itemId}" not found.`);
        }
        if (error instanceof ItemServiceError && error.status === 403) {
          throw new ReviewServiceError('FORBIDDEN', `Reading "${collection}" is not allowed.`);
        }
        throw error;
      }
      const values: Record<string, unknown> = {};
      for (const field of readableFields) if (row[field] !== undefined) values[field] = row[field];
      return { values, omittedFields };
    },

    async deniedSnapshotFields(collection, keys, action) {
      const known = await knownFields(collection);
      const read = await permissions.canAccess(collection, 'read');
      const write = await permissions.canAccess(collection, action);
      if (!read || !write) return [...keys];
      const readable = visibleFields(known, read);
      const writable = visibleFields(known, write);
      return keys.filter((key) => !readable.has(key) || !writable.has(key));
    },

    latestRevisionId: (itemId) => latestRevisionId(db, siteId, itemId),
  };
}

export function reviewContentAccessForRequest(c: Context<AppEnv>): ReviewContentAccess {
  const db = c.get('db');
  const siteId = c.get('siteId');
  return reviewContentAccess({
    db,
    siteId,
    permissions: permissionServiceForRequest(c),
    items: () => itemServiceForRequest(c),
    schema: new SchemaService({ db, siteId, cache: c.get('runtime').cache }),
  });
}

/**
 * Content access for the semantic drift pass (J12, #519). There is no caller
 * to scope by: the scan is a site job, so it reads through
 * `itemServiceForSystem(…, 'semantic-drift-scan')` (site scope, decryption,
 * soft-delete) and narrows the read itself. Only `include` is ever read:
 * the rule's fields minus the item's pinned fields, plus the context field.
 * Every other profile field is reported as omitted and never sent. Snapshot
 * reviews are not part of a scan, so every snapshot field is refused.
 */
export function reviewContentAccessForDriftScan(deps: {
  db: Database;
  siteId: string;
  include: readonly string[];
  cache?: CacheProvider;
  keys?: KeyProvider;
  encryptionKey?: string;
}): ReviewContentAccess {
  const { db, siteId } = deps;
  const include = new Set(deps.include);
  const items = () =>
    itemServiceForSystem(
      { db, siteId, cache: deps.cache, keyProvider: deps.keys, encryptionKey: deps.encryptionKey },
      'semantic-drift-scan',
    );
  return {
    async readItem(collection, itemId, fields) {
      const readable = fields.filter((field) => include.has(field));
      const omittedFields = fields.filter((field) => !include.has(field));
      let row: Record<string, unknown>;
      try {
        row = (await items().detail(collection, itemId, readable.length > 0 ? readable : ['id'])) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (error instanceof ItemServiceError && error.status === 404) {
          throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', `Item "${itemId}" not found.`);
        }
        throw error;
      }
      const values: Record<string, unknown> = {};
      for (const field of readable) if (row[field] !== undefined) values[field] = row[field];
      return { values, omittedFields };
    },
    async deniedSnapshotFields(_collection, keys) {
      return [...keys];
    },
    latestRevisionId: (itemId) => latestRevisionId(db, siteId, itemId),
  };
}

/**
 * The same access for a principal re-resolved off the request path (a Flows
 * worker, J10 #517). `permissionContext` comes from `EffectiveCapabilityService`
 * at execution time, so a role change or revoked key since the run was queued
 * is honoured; the site comes from that context, never from the job payload.
 */
export function reviewContentAccessForPrincipal(deps: {
  db: Database;
  permissionContext: MagicContext;
  cache?: CacheProvider;
  keys?: KeyProvider;
  encryptionKey?: string;
}): ReviewContentAccess {
  const { db, permissionContext, cache } = deps;
  const siteId = permissionContext.siteId;
  return reviewContentAccess({
    db,
    siteId,
    permissions: new PermissionService({ db, cache, ctx: permissionContext }),
    items: () =>
      itemServiceForPrincipal(
        {
          db,
          siteId,
          cache,
          userId: permissionContext.userId ?? null,
          keyProvider: deps.keys,
          encryptionKey: deps.encryptionKey,
        },
        permissionContext,
      ),
    schema: new SchemaService({ db, siteId, cache }),
  });
}
