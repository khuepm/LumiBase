/**
 * Request-scoped content access for draft review (Jev J05, #512).
 *
 * Reads go through `itemServiceForRequest`, so row rules, field masks,
 * decryption and site scope are exactly what the caller's own token gets on
 * `/items`. Field-level visibility is computed from the same compiled
 * permission (`PermissionService.canAccess` + `applyFieldMask`) so a masked
 * field is reported as omitted instead of silently reading as empty.
 */

import { revisions } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { ItemServiceError } from './item-service';
import { itemServiceForRequest, permissionServiceForRequest } from './item-service-factory';
import { applyFieldMask } from './permission-dsl';
import type { CompiledPermission } from './permission-service';
import { ReviewServiceError, type ReviewContentAccess } from './review-service';
import { SchemaService } from './schema-service';

function visibleFields(known: string[], perm: CompiledPermission): Set<string> {
  return new Set(perm.fields.length === 1 && perm.fields[0] === '*' ? known : applyFieldMask(known, perm.fields));
}

export function reviewContentAccessForRequest(c: Context<AppEnv>): ReviewContentAccess {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const permissions = permissionServiceForRequest(c);
  const schema = new SchemaService({ db, siteId, cache: c.get('runtime').cache });

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
        row = (await itemServiceForRequest(c).detail(
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

    async latestRevisionId(itemId) {
      const [row] = await db
        .select({ id: revisions.id })
        .from(revisions)
        .where(and(eq(revisions.siteId, siteId), eq(revisions.itemId, itemId), eq(revisions.staged, false)))
        .orderBy(desc(revisions.createdAt))
        .limit(1);
      return row?.id ?? null;
    },
  };
}
