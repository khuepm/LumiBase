import {
  collections,
  items,
  roles,
  scopeSite,
  shares,
  type Database,
} from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hashPassword, verifyPassword } from './auth/password';
import { PermissionService, type CompiledPermission } from './permission-service';
import { SchemaService } from './schema-service';
import type { MagicContext } from './permission-dsl';

export class ShareServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ShareServiceError';
  }
}

export interface ShareServiceDeps {
  db: Database;
  cache?: CacheProvider;
  siteId?: string;
  now?: Date;
}

export interface CreateShareInput {
  collection: string;
  itemId: string;
  roleId: string;
  password?: string;
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxUses?: number | null;
  actor: {
    userId: string;
    email?: string | null;
    roles?: string[];
    raw?: Record<string, unknown>;
    ip?: string | null;
    headers?: Record<string, string>;
  };
}

export interface ReadShareInput {
  token: string;
  password?: string | null;
  ip?: string | null;
  headers?: Record<string, string>;
}

export function redactShareSecrets<T extends { tokenHash: string; passwordHash: string | null }>(share: T) {
  const { tokenHash: _tokenHash, passwordHash: _passwordHash, ...safe } = share;
  return safe;
}

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function assertActiveShare(row: typeof shares.$inferSelect, now: Date): void {
  if (row.revokedAt) throw new ShareServiceError('SHARE_REVOKED', 'Share link has been revoked.', 403);
  if (row.validFrom && row.validFrom > now) throw new ShareServiceError('SHARE_NOT_YET_VALID', 'Share link is not active yet.', 403);
  if (row.validUntil && row.validUntil < now) throw new ShareServiceError('SHARE_EXPIRED', 'Share link has expired.', 401);
  if (row.maxUses !== null && row.usedCount >= row.maxUses) {
    throw new ShareServiceError('SHARE_MAX_USES_REACHED', 'Share link has reached its maximum number of uses.', 403);
  }
}

function intersectPermissionFields(a: CompiledPermission, b: CompiledPermission): string[] {
  if (a.fields.includes('*')) return b.fields;
  if (b.fields.includes('*')) return a.fields;
  return a.fields.filter((field) => b.fields.includes(field));
}

function baseMagicContext(input: {
  siteId: string;
  roleId: string | null;
  userId?: string | null;
  user?: Record<string, unknown> | null;
  ip?: string | null;
  headers?: Record<string, string>;
  now: Date;
}): MagicContext {
  return {
    userId: input.userId ?? null,
    siteId: input.siteId,
    roleId: input.roleId,
    user: input.user ?? null,
    ip: input.ip ?? null,
    headers: input.headers ?? {},
    now: input.now,
  };
}

export class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  async create(input: CreateShareInput) {
    if (!this.deps.siteId) {
      throw new ShareServiceError('SITE_REQUIRED', 'Authenticated share creation requires a site context.', 500);
    }
    if (input.maxUses !== undefined && input.maxUses !== null && input.maxUses < 1) {
      throw new ShareServiceError('VALIDATION', 'maxUses must be greater than zero.', 400);
    }

    const now = this.deps.now ?? new Date();
    const actorPerms = new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: baseMagicContext({
        siteId: this.deps.siteId,
        roleId: null,
        userId: input.actor.userId,
        user: {
          id: input.actor.userId,
          email: input.actor.email ?? null,
          roles: input.actor.roles ?? [],
          ...(input.actor.raw ?? {}),
        },
        ip: input.actor.ip,
        headers: input.actor.headers,
        now,
      }),
    });
    const sharePerm = await actorPerms.canAccess(input.collection, 'share');
    if (!sharePerm) {
      throw new ShareServiceError('FORBIDDEN', `Action "share" on "${input.collection}" is not allowed.`, 403);
    }
    const actorReadPerm = await actorPerms.canAccess(input.collection, 'read');
    if (!actorReadPerm) {
      throw new ShareServiceError('FORBIDDEN', `Action "read" on "${input.collection}" is required to create a share.`, 403);
    }

    const [targetCollection] = await this.deps.db
      .select()
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, input.collection)))
      .limit(1);
    if (!targetCollection) throw new ShareServiceError('NOT_FOUND', `Collection "${input.collection}" not found.`, 404);

    const [targetItem] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, targetCollection.id),
          eq(items.id, input.itemId),
          isNull(items.deletedAt),
          actorPerms.whereFor(sharePerm),
          actorPerms.whereFor(actorReadPerm),
        ),
      )
      .limit(1);
    if (!targetItem) throw new ShareServiceError('NOT_FOUND', `Item "${input.itemId}" not found.`, 404);

    await this.assertShareRoleCanRead(input.roleId, input.collection, this.deps.siteId, now);

    const token = randomToken();
    const [row] = await this.deps.db
      .insert(shares)
      .values({
        siteId: this.deps.siteId,
        collection: input.collection,
        itemId: input.itemId,
        roleId: input.roleId,
        tokenHash: await hashShareToken(token),
        passwordHash: input.password ? await hashPassword(input.password) : null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        maxUses: input.maxUses ?? null,
        createdBy: input.actor.userId,
      })
      .returning();
    if (!row) throw new ShareServiceError('CREATE_FAILED', 'Failed to create share link.', 500);
    return { ...redactShareSecrets(row), token, url: `/api/v1/shares/${token}` };
  }

  async revoke(id: string, userId: string, siteId = this.deps.siteId) {
    if (!siteId) throw new ShareServiceError('SITE_REQUIRED', 'Revoking a share requires a site context.', 500);
    const [row] = await this.deps.db
      .update(shares)
      .set({ revokedAt: this.deps.now ?? new Date(), revokedBy: userId })
      .where(and(scopeSite(shares.siteId, siteId), eq(shares.id, id)))
      .returning();
    if (!row) throw new ShareServiceError('NOT_FOUND', 'Share link not found.', 404);
    return redactShareSecrets(row);
  }

  async read(input: ReadShareInput) {
    const tokenHash = await hashShareToken(input.token);
    const [share] = await this.deps.db
      .select()
      .from(shares)
      .where(eq(shares.tokenHash, tokenHash))
      .limit(1);
    if (!share) throw new ShareServiceError('NOT_FOUND', 'Share link not found.', 404);

    const now = this.deps.now ?? new Date();
    assertActiveShare(share, now);
    if (share.passwordHash) {
      const ok = input.password ? await verifyPassword(input.password, share.passwordHash) : false;
      if (!ok) throw new ShareServiceError('SHARE_PASSWORD_REQUIRED', 'Share password is required.', 401);
    }

    const ctx = baseMagicContext({
      siteId: share.siteId,
      roleId: share.roleId,
      ip: input.ip,
      headers: input.headers,
      now,
    });
    const permissionService = new PermissionService({ db: this.deps.db, cache: this.deps.cache, ctx });
    const readPerm = await permissionService.canAccess(share.collection, 'read');
    if (!readPerm) {
      throw new ShareServiceError('FORBIDDEN', 'Share role cannot read this collection.', 403);
    }
    const creatorPermissionService = new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: baseMagicContext({
        siteId: share.siteId,
        roleId: null,
        userId: share.createdBy,
        ip: input.ip,
        headers: input.headers,
        now,
      }),
    });
    const creatorReadPerm = await creatorPermissionService.canAccess(share.collection, 'read');
    if (!creatorReadPerm) {
      throw new ShareServiceError('FORBIDDEN', 'Share creator cannot read this collection.', 403);
    }

    const [targetCollection] = await this.deps.db
      .select()
      .from(collections)
      .where(and(scopeSite(collections.siteId, share.siteId), eq(collections.name, share.collection)))
      .limit(1);
    if (!targetCollection) throw new ShareServiceError('NOT_FOUND', `Collection "${share.collection}" not found.`, 404);

    const [row] = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, share.siteId),
          eq(items.collectionId, targetCollection.id),
          eq(items.id, share.itemId),
          isNull(items.deletedAt),
          permissionService.whereFor(readPerm),
          creatorPermissionService.whereFor(creatorReadPerm),
        ),
      )
      .limit(1);
    if (!row) throw new ShareServiceError('NOT_FOUND', `Item "${share.itemId}" not found.`, 404);

    const compiled = await new SchemaService({
      db: this.deps.db,
      siteId: share.siteId,
      cache: this.deps.cache,
    }).getCompiled(share.collection);
    const knownFields = compiled?.fields.map((f) => f.name) ?? [];
    const effectiveReadPerm = { ...readPerm, fields: intersectPermissionFields(readPerm, creatorReadPerm) };
    const masked = permissionService.maskItem(effectiveReadPerm, row as typeof row & { data: Record<string, unknown> }, knownFields);

    await this.deps.db
      .update(shares)
      .set({ usedCount: sql`${shares.usedCount} + 1`, lastUsedAt: now })
      .where(eq(shares.id, share.id));

    return { share, item: masked };
  }

  private async assertShareRoleCanRead(roleId: string, collection: string, siteId: string, now: Date) {
    const [role] = await this.deps.db
      .select()
      .from(roles)
      .where(and(scopeSite(roles.siteId, siteId), eq(roles.id, roleId)))
      .limit(1);
    if (!role) throw new ShareServiceError('VALIDATION', 'Share role not found.', 400);
    if (role.adminAccess || role.appAccess) {
      throw new ShareServiceError('VALIDATION', 'Share role must not have admin or Studio access.', 400);
    }

    const service = new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: baseMagicContext({ siteId, roleId, now }),
    });
    const bundle = await service.bundle();
    if (bundle.admin || bundle.appAccess) {
      throw new ShareServiceError('VALIDATION', 'Share role policies must not grant admin or Studio access.', 400);
    }
    const read = await service.canAccess(collection, 'read');
    if (!read) {
      throw new ShareServiceError('VALIDATION', 'Share role must grant read permission for this collection.', 400);
    }
  }
}
