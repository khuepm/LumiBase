/**
 * Preview service — site-scoped preview secrets and signed preview URLs
 * (epic #667: V01 #679, V04 #682).
 *
 * A preview token is a compact HS256 JWT. Its signing key is derived per site:
 *
 *     key = HMAC-SHA256(JWT_SECRET, "lumibase:preview:v1|" + siteId)
 *
 * so a token minted for site A fails signature verification on site B before
 * any database lookup (Sanity #12794: a preview secret must never be valid on
 * another dataset/workspace). The audience claim pins the site a second time.
 *
 * Every minted token also gets a `lumibase_preview_secrets` row holding only
 * the SHA-256 of the token. A read requires BOTH a valid signature for the
 * requesting site AND a live row (not revoked, not expired) on that site, so
 * tokens are revocable individually or all at once (rotation).
 *
 * Reads run with the token creator's permissions, re-evaluated on every read:
 * a token never reads more than the editor who clicked "Preview" can read
 * today. Every failure mode answers the same 401 (no oracle); valid-signature
 * failures (expired, revoked, creator lost access) are audited.
 *
 * Threat model: docs/en/architecture/decisions/adr-014-preview-bridge-threat-model.md
 */

import {
  collections,
  contentVersions,
  items,
  previewSecrets,
  releaseItems,
  releases,
  revisions,
  scopeSite,
  settings,
  type Database,
} from '@lumibase/database';
import {
  PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  type PreviewTarget,
  type PreviewTokenMintInput,
} from '@lumibase/contracts';
import type { CacheProvider } from '@lumibase/runtime';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { nanoid } from 'nanoid';
import { PermissionService, type CompiledPermission } from './permission-service';
import { SchemaService } from './schema-service';

export class PreviewServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'PreviewServiceError';
  }
}

const ISSUER = 'lumibase';
const KEY_INFO_PREFIX = 'lumibase:preview:v1|';
/** Fixed key for tests/local dev only; production requires JWT_SECRET. */
const DEV_FALLBACK_SECRET = 'lumibase-dev-preview-secret-not-for-production';
/** Upper bound on items returned by one preview list read. */
export const PREVIEW_LIST_MAX_LIMIT = 100;

const encoder = new TextEncoder();
let warnedDevSecret = false;

/**
 * The deployment secret preview keys are derived from: `JWT_SECRET` from the
 * bindings, then `process.env`. Outside production a fixed development key is
 * used (with a one-time warning); in production `null` disables preview.
 */
export function previewSigningSecret(env: { JWT_SECRET?: string; NODE_ENV?: string } | undefined): string | null {
  const fromBinding = env?.JWT_SECRET;
  if (fromBinding) return fromBinding;
  let fromProcess: string | undefined;
  let nodeEnv: string | undefined = env?.NODE_ENV;
  try {
    if (typeof process !== 'undefined') {
      fromProcess = process.env.JWT_SECRET;
      nodeEnv = nodeEnv ?? process.env.NODE_ENV;
    }
  } catch {
    fromProcess = undefined;
  }
  if (fromProcess) return fromProcess;
  if (nodeEnv === 'production') return null;
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn('[preview] JWT_SECRET is not set; preview tokens use a fixed development key.');
  }
  return DEV_FALLBACK_SECRET;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 hex of a token — the only form a token is stored in. */
export async function hashPreviewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return bytesToHex(new Uint8Array(digest));
}

/** Per-site HS256 key: HMAC-SHA256(secret, "lumibase:preview:v1|" + siteId). */
export async function derivePreviewSiteKey(secret: string, siteId: string): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(`${KEY_INFO_PREFIX}${siteId}`));
  return new Uint8Array(derived);
}

const audienceFor = (siteId: string) => `lumibase-preview:${siteId}`;

export interface PreviewClaims extends PreviewTarget {
  readonly siteId: string;
  readonly userId: string;
  readonly jti: string;
  readonly expiresAt: Date;
}

export async function signPreviewToken(input: {
  secret: string;
  siteId: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  target: PreviewTarget;
}): Promise<string> {
  const key = await derivePreviewSiteKey(input.secret, input.siteId);
  const claims: Record<string, string> = {};
  if (input.target.collection) claims.col = input.target.collection;
  if (input.target.itemId) claims.item = input.target.itemId;
  if (input.target.versionKey) claims.ver = input.target.versionKey;
  if (input.target.releaseId) claims.rel = input.target.releaseId;
  if (input.target.locale) claims.loc = input.target.locale;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(audienceFor(input.siteId))
    .setSubject(input.userId)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(key);
}

export type PreviewVerifyFailure = 'malformed' | 'signature' | 'expired' | 'claims';

export type PreviewVerifyResult =
  | { readonly ok: true; readonly claims: PreviewClaims }
  | { readonly ok: false; readonly reason: PreviewVerifyFailure; readonly userId?: string };

const optionalString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Verify a token for `siteId`. Signature first (a token for another site fails
 * here), then issuer/audience/expiry. Never throws.
 */
export async function verifyPreviewToken(input: {
  secret: string;
  siteId: string;
  token: string;
  now?: Date;
}): Promise<PreviewVerifyResult> {
  if (typeof input.token !== 'string' || input.token.length === 0 || input.token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  if (input.token.split('.').length !== 3) return { ok: false, reason: 'malformed' };
  const key = await derivePreviewSiteKey(input.secret, input.siteId);
  try {
    const { payload } = await jwtVerify(input.token, key, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: audienceFor(input.siteId),
      currentDate: input.now,
      requiredClaims: ['sub', 'jti', 'exp'],
    });
    const userId = optionalString(payload.sub);
    const jti = optionalString(payload.jti);
    if (!userId || !jti || typeof payload.exp !== 'number') return { ok: false, reason: 'claims' };
    const target: PreviewTarget = {
      collection: optionalString(payload.col),
      itemId: optionalString(payload.item),
      versionKey: optionalString(payload.ver),
      releaseId: optionalString(payload.rel),
      locale: optionalString(payload.loc),
    };
    if (!(target.collection && target.itemId) && !target.releaseId) return { ok: false, reason: 'claims' };
    return {
      ok: true,
      claims: { ...target, siteId: input.siteId, userId, jti, expiresAt: new Date(payload.exp * 1000) },
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired', userId: optionalString(err.payload.sub) ?? undefined };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) return { ok: false, reason: 'signature' };
    if (err instanceof joseErrors.JWTClaimValidationFailed) return { ok: false, reason: 'claims' };
    return { ok: false, reason: 'malformed' };
  }
}

type PreviewSecretRow = typeof previewSecrets.$inferSelect;
export type PreviewSecretView = Omit<PreviewSecretRow, 'tokenHash'>;

export function redactPreviewSecret(row: PreviewSecretRow): PreviewSecretView {
  const { tokenHash: _tokenHash, ...safe } = row;
  return safe;
}

/** A preview read that failed. `reason` is for audit/logs only, never the response. */
export type PreviewAuthFailure =
  | PreviewVerifyFailure
  | 'not_configured'
  | 'unknown_token'
  | 'site_mismatch'
  | 'revoked'
  | 'creator_mismatch';

export type PreviewAuthResult =
  | { readonly ok: true; readonly row: PreviewSecretRow; readonly claims: PreviewClaims }
  | { readonly ok: false; readonly reason: PreviewAuthFailure; readonly row?: PreviewSecretRow; readonly userId?: string };

export interface PreviewItem {
  id: string;
  collection: string;
  status: string;
  sort: number;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** How the preview changed this item relative to live. */
  preview?: { source: 'draft' | 'version' | 'release'; versionKey?: string; releaseId?: string };
}

export interface PreviewServiceDeps {
  db: Database;
  siteId: string;
  /** Deployment secret ({@link previewSigningSecret}); null → preview disabled. */
  secret: string | null;
  cache?: CacheProvider;
  now?: () => Date;
}

interface ItemRow {
  id: string;
  collectionId: string;
  status: string;
  sort: number;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const itemColumns = {
  id: items.id,
  collectionId: items.collectionId,
  status: items.status,
  sort: items.sort,
  data: items.data,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

/** Publish window: `publishAt` unset/past and `unpublishAt` unset/future. */
function liveClause(now: Date): SQL | undefined {
  return and(
    eq(items.status, 'published'),
    or(isNull(items.publishAt), lte(items.publishAt, now)),
    or(isNull(items.unpublishAt), gt(items.unpublishAt, now)),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export class PreviewService {
  constructor(private readonly deps: PreviewServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private requireSecret(): string {
    if (!this.deps.secret) {
      throw new PreviewServiceError('PREVIEW_NOT_CONFIGURED', 'Preview signing is not configured (JWT_SECRET).', 503);
    }
    return this.deps.secret;
  }

  private permissionsFor(userId: string): PermissionService {
    return new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: {
        userId,
        siteId: this.deps.siteId,
        roleId: null,
        ip: null,
        headers: {},
        now: this.now(),
      },
    });
  }

  private async collectionId(name: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    return row?.id ?? null;
  }

  /** Supported locales from the site's `locales` setting, or null when unset. */
  private async supportedLocales(): Promise<string[] | null> {
    const [row] = await this.deps.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(scopeSite(settings.siteId, this.deps.siteId), eq(settings.key, 'locales')))
      .limit(1);
    const supported = (row?.value as { supported?: unknown } | undefined)?.supported;
    return Array.isArray(supported) ? supported.filter((l): l is string => typeof l === 'string') : null;
  }

  // ── mint / manage (staff, authenticated) ───────────────────────────────

  async mint(input: PreviewTokenMintInput & { userId: string; defaultTtlSeconds?: number }) {
    const secret = this.requireSecret();
    const perms = this.permissionsFor(input.userId);

    if (input.collection && input.itemId) {
      const read = await perms.canAccess(input.collection, 'read');
      if (!read) {
        throw new PreviewServiceError('FORBIDDEN', `Action "read" on "${input.collection}" is required to preview it.`, 403);
      }
      const collId = await this.collectionId(input.collection);
      if (!collId) throw new PreviewServiceError('NOT_FOUND', `Collection "${input.collection}" not found.`, 404);
      const [item] = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, collId),
            eq(items.id, input.itemId),
            isNull(items.deletedAt),
            perms.whereFor(read),
          ),
        )
        .limit(1);
      if (!item) throw new PreviewServiceError('NOT_FOUND', `Item "${input.itemId}" not found.`, 404);
      if (input.versionKey) {
        const [version] = await this.deps.db
          .select({ id: contentVersions.id })
          .from(contentVersions)
          .where(
            and(
              scopeSite(contentVersions.siteId, this.deps.siteId),
              eq(contentVersions.collectionId, collId),
              eq(contentVersions.itemId, input.itemId),
              eq(contentVersions.key, input.versionKey),
            ),
          )
          .limit(1);
        if (!version) throw new PreviewServiceError('NOT_FOUND', `Version "${input.versionKey}" not found.`, 404);
      }
    }

    if (input.releaseId) {
      const [release] = await this.deps.db
        .select({ id: releases.id })
        .from(releases)
        .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, input.releaseId)))
        .limit(1);
      if (!release) throw new PreviewServiceError('NOT_FOUND', `Release "${input.releaseId}" not found.`, 404);
    }

    if (input.locale) {
      const supported = await this.supportedLocales();
      if (supported && !supported.includes(input.locale)) {
        throw new PreviewServiceError('VALIDATION', `Locale "${input.locale}" is not enabled for this site.`, 400);
      }
    }

    const ttl = Math.min(
      input.ttlSeconds ?? input.defaultTtlSeconds ?? PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
      PREVIEW_TOKEN_MAX_TTL_SECONDS,
    );
    const now = this.now();
    // Whole seconds: the JWT `exp` is in seconds and the row must agree.
    const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + ttl * 1000);
    const target: PreviewTarget = {
      collection: input.collection ?? null,
      itemId: input.itemId ?? null,
      versionKey: input.versionKey ?? null,
      releaseId: input.releaseId ?? null,
      locale: input.locale ?? null,
    };
    const id = nanoid();
    const token = await signPreviewToken({ secret, siteId: this.deps.siteId, userId: input.userId, jti: id, expiresAt, target });
    const [row] = await this.deps.db
      .insert(previewSecrets)
      .values({
        id,
        siteId: this.deps.siteId,
        tokenHash: await hashPreviewToken(token),
        collection: target.collection,
        itemId: target.itemId,
        versionKey: target.versionKey,
        releaseId: target.releaseId,
        locale: target.locale,
        createdBy: input.userId,
        expiresAt,
      })
      .returning();
    if (!row) throw new PreviewServiceError('CREATE_FAILED', 'Failed to mint preview token.', 500);
    return { ...redactPreviewSecret(row), token };
  }

  /** Active (unrevoked, unexpired) tokens of the site, newest first. */
  async listActive(opts: { createdBy?: string; limit?: number } = {}): Promise<PreviewSecretView[]> {
    const limit = opts.limit ?? 100;
    const rows = await this.deps.db
      .select()
      .from(previewSecrets)
      .where(
        and(
          scopeSite(previewSecrets.siteId, this.deps.siteId),
          opts.createdBy ? eq(previewSecrets.createdBy, opts.createdBy) : undefined,
          isNull(previewSecrets.revokedAt),
          gt(previewSecrets.expiresAt, this.now()),
        ),
      )
      .orderBy(desc(previewSecrets.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(redactPreviewSecret);
  }

  /** Revoke one token. `ownerOnly` restricts it to tokens `userId` minted. */
  async revoke(id: string, userId: string, opts: { ownerOnly?: boolean } = {}): Promise<PreviewSecretView> {
    const [row] = await this.deps.db
      .update(previewSecrets)
      .set({ revokedAt: this.now(), revokedBy: userId })
      .where(
        and(
          scopeSite(previewSecrets.siteId, this.deps.siteId),
          eq(previewSecrets.id, id),
          isNull(previewSecrets.revokedAt),
          opts.ownerOnly ? eq(previewSecrets.createdBy, userId) : undefined,
        ),
      )
      .returning();
    if (!row) throw new PreviewServiceError('NOT_FOUND', 'Preview token not found or already revoked.', 404);
    return redactPreviewSecret(row);
  }

  /** Rotation: revoke every live token of this site. Returns how many. */
  async revokeAll(userId: string): Promise<number> {
    const rows = await this.deps.db
      .update(previewSecrets)
      .set({ revokedAt: this.now(), revokedBy: userId })
      .where(and(scopeSite(previewSecrets.siteId, this.deps.siteId), isNull(previewSecrets.revokedAt)))
      .returning({ id: previewSecrets.id });
    return rows.length;
  }

  // ── public read ────────────────────────────────────────────────────────

  /**
   * Authenticate a token presented on this site. Signature (per-site key),
   * then the row by hash ON THIS SITE, then revocation/expiry. The caller
   * maps every failure to the same 401.
   */
  async authenticate(token: string): Promise<PreviewAuthResult> {
    if (!this.deps.secret) return { ok: false, reason: 'not_configured' };
    const verified = await verifyPreviewToken({ secret: this.deps.secret, siteId: this.deps.siteId, token, now: this.now() });
    if (!verified.ok) return { ok: false, reason: verified.reason, userId: verified.userId };
    const tokenHash = await hashPreviewToken(token);
    const [row] = await this.deps.db
      .select()
      .from(previewSecrets)
      .where(and(scopeSite(previewSecrets.siteId, this.deps.siteId), eq(previewSecrets.tokenHash, tokenHash)))
      .limit(1);
    if (!row) return { ok: false, reason: 'unknown_token', userId: verified.claims.userId };
    if (row.siteId !== this.deps.siteId) return { ok: false, reason: 'site_mismatch', row };
    if (row.createdBy !== verified.claims.userId || row.id !== verified.claims.jti) {
      return { ok: false, reason: 'creator_mismatch', row };
    }
    if (row.revokedAt) return { ok: false, reason: 'revoked', row };
    if (row.expiresAt <= this.now()) return { ok: false, reason: 'expired', row };
    return { ok: true, row, claims: verified.claims };
  }

  /** Record a successful read (best-effort counters). */
  async markUsed(row: PreviewSecretRow): Promise<void> {
    await this.deps.db
      .update(previewSecrets)
      .set({ useCount: sql`${previewSecrets.useCount} + 1`, lastUsedAt: this.now() })
      .where(and(scopeSite(previewSecrets.siteId, this.deps.siteId), eq(previewSecrets.id, row.id)));
  }

  /** Overlay map (collection → itemId → overlay) the token applies to reads. */
  private async overlayFor(
    row: PreviewSecretRow,
    collection: string,
    collId: string,
    candidateIds: readonly string[],
  ): Promise<Map<string, { data?: Record<string, unknown>; status?: string; source: NonNullable<PreviewItem['preview']> }>> {
    const overlay = new Map<string, { data?: Record<string, unknown>; status?: string; source: NonNullable<PreviewItem['preview']> }>();
    const siteId = this.deps.siteId;

    // Item target: the item reads at its current (draft) state.
    if (row.collection === collection && row.itemId) {
      overlay.set(row.itemId, { source: { source: 'draft' } });
    }

    // Version target: the named branch overlays EVERY item in this collection
    // that has a version with the same key — so relations resolve to the
    // branch when the related item has one (V04 AC 2).
    if (row.versionKey) {
      const ids = row.collection === collection && row.itemId ? [...new Set([row.itemId, ...candidateIds])] : [...candidateIds];
      if (ids.length > 0) {
        const versions = await this.deps.db
          .select({ itemId: contentVersions.itemId, data: contentVersions.data })
          .from(contentVersions)
          .where(
            and(
              scopeSite(contentVersions.siteId, siteId),
              eq(contentVersions.collectionId, collId),
              eq(contentVersions.key, row.versionKey),
              inArray(contentVersions.itemId, ids),
            ),
          );
        for (const v of versions) {
          overlay.set(v.itemId, { data: asRecord(v.data), source: { source: 'version', versionKey: row.versionKey } });
        }
      }
    }

    // Release target: every item in the release reads as it will once the
    // release publishes (pinned revision snapshot + target status).
    if (row.releaseId) {
      const members = await this.deps.db
        .select({ itemId: releaseItems.itemId, targetStatus: releaseItems.targetStatus, revisionId: releaseItems.revisionId })
        .from(releaseItems)
        .where(
          and(
            scopeSite(releaseItems.siteId, siteId),
            eq(releaseItems.releaseId, row.releaseId),
            eq(releaseItems.collection, collection),
          ),
        );
      const revisionIds = members.map((m) => m.revisionId).filter((r): r is string => typeof r === 'string');
      const snapshots = new Map<string, Record<string, unknown>>();
      if (revisionIds.length > 0) {
        const revs = await this.deps.db
          .select({ id: revisions.id, delta: revisions.delta })
          .from(revisions)
          .where(and(scopeSite(revisions.siteId, siteId), inArray(revisions.id, revisionIds)));
        for (const rev of revs) {
          const after = (rev.delta as { after?: unknown } | null)?.after;
          if (after && typeof after === 'object') snapshots.set(rev.id, asRecord(after));
        }
      }
      for (const m of members) {
        const data = m.revisionId ? snapshots.get(m.revisionId) : undefined;
        overlay.set(m.itemId, {
          ...(data ? { data } : {}),
          status: m.targetStatus,
          source: { source: 'release', releaseId: row.releaseId },
        });
      }
    }
    return overlay;
  }

  private async readContext(row: PreviewSecretRow, collection: string) {
    const perms = this.permissionsFor(row.createdBy);
    const read: CompiledPermission | null = await perms.canAccess(collection, 'read');
    if (!read) return null;
    const collId = await this.collectionId(collection);
    if (!collId) return null;
    const compiled = await new SchemaService({ db: this.deps.db, siteId: this.deps.siteId, cache: this.deps.cache }).getCompiled(
      collection,
    );
    const knownFields = compiled?.fields.map((f) => f.name) ?? [];
    // Encrypted fields are stored as ciphertext envelopes; preview never
    // decrypts, so they are dropped rather than shipped to a frontend.
    const encrypted = new Set(compiled?.fields.filter((f) => f.encrypted).map((f) => f.name) ?? []);
    return { perms, read, collId, knownFields, encrypted };
  }

  private shape(
    ctx: NonNullable<Awaited<ReturnType<PreviewService['readContext']>>>,
    collection: string,
    item: ItemRow,
    overlay?: { data?: Record<string, unknown>; status?: string; source: NonNullable<PreviewItem['preview']> },
  ): PreviewItem {
    const data = overlay?.data ?? asRecord(item.data);
    for (const name of ctx.encrypted) delete data[name];
    const masked = ctx.perms.maskItem(ctx.read, { data }, ctx.knownFields);
    return {
      id: item.id,
      collection,
      status: overlay?.status ?? item.status,
      sort: item.sort,
      data: masked.data ?? {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(overlay ? { preview: overlay.source } : {}),
    };
  }

  /**
   * Items of `collection` as the token sees them: live (published, in window)
   * items, with the token's overlay applied — the previewed draft/version, or
   * every release member as it will publish. Overlay items whose preview status
   * is not `published` (e.g. a release that archives them) are left out.
   */
  async listItems(
    row: PreviewSecretRow,
    collection: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<PreviewItem[] | null> {
    const ctx = await this.readContext(row, collection);
    if (!ctx) return null;
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), PREVIEW_LIST_MAX_LIMIT);
    const offset = Math.max(opts.offset ?? 0, 0);
    const now = this.now();

    // Seed the overlay with targets only (no candidates yet) to know which
    // non-live ids must also be fetched.
    const seed = await this.overlayFor(row, collection, ctx.collId, []);
    const forcedIds = [...seed.keys()];
    const rows = (await this.deps.db
      .select(itemColumns)
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, ctx.collId),
          isNull(items.deletedAt),
          forcedIds.length > 0 ? or(liveClause(now), inArray(items.id, forcedIds)) : liveClause(now),
          ctx.perms.whereFor(ctx.read),
        ),
      )
      .orderBy(desc(items.updatedAt))
      .limit(limit)
      .offset(offset)) as ItemRow[];

    const overlay = row.versionKey
      ? await this.overlayFor(row, collection, ctx.collId, rows.map((r) => r.id))
      : seed;
    const out: PreviewItem[] = [];
    for (const item of rows) {
      const o = overlay.get(item.id);
      const shaped = this.shape(ctx, collection, item, o);
      // Draft/version previews always show their target; a release member
      // shows only if it will be published by the release.
      if (o?.source.source === 'release' && shaped.status !== 'published') continue;
      out.push(shaped);
    }
    return out;
  }

  /** One item as the token sees it, or null when not visible. */
  async getItem(row: PreviewSecretRow, collection: string, id: string): Promise<PreviewItem | null> {
    const ctx = await this.readContext(row, collection);
    if (!ctx) return null;
    const overlay = await this.overlayFor(row, collection, ctx.collId, [id]);
    const o = overlay.get(id);
    const [item] = (await this.deps.db
      .select(itemColumns)
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, ctx.collId),
          eq(items.id, id),
          isNull(items.deletedAt),
          o ? undefined : liveClause(this.now()),
          ctx.perms.whereFor(ctx.read),
        ),
      )
      .limit(1)) as ItemRow[];
    if (!item) return null;
    const shaped = this.shape(ctx, collection, item, o);
    if (o?.source.source === 'release' && shaped.status !== 'published') return null;
    return shaped;
  }

  /** What the token targets, resolved for the response envelope. */
  async describeTarget(row: PreviewSecretRow): Promise<{
    target: PreviewTarget;
    item: PreviewItem | null;
    release: { id: string; name: string; status: string; items: Array<{ collection: string; itemId: string; targetStatus: string }> } | null;
  }> {
    const target: PreviewTarget = {
      collection: row.collection,
      itemId: row.itemId,
      versionKey: row.versionKey,
      releaseId: row.releaseId,
      locale: row.locale,
    };
    const item = row.collection && row.itemId ? await this.getItem(row, row.collection, row.itemId) : null;
    let release: Awaited<ReturnType<PreviewService['describeTarget']>>['release'] = null;
    if (row.releaseId) {
      const [rel] = await this.deps.db
        .select({ id: releases.id, name: releases.name, status: releases.status })
        .from(releases)
        .where(and(scopeSite(releases.siteId, this.deps.siteId), eq(releases.id, row.releaseId)))
        .limit(1);
      if (rel) {
        const members = await this.deps.db
          .select({ collection: releaseItems.collection, itemId: releaseItems.itemId, targetStatus: releaseItems.targetStatus })
          .from(releaseItems)
          .where(and(scopeSite(releaseItems.siteId, this.deps.siteId), eq(releaseItems.releaseId, row.releaseId)));
        // Only members the creator can still read are listed.
        const visible: typeof members = [];
        const readable = new Map<string, boolean>();
        const perms = this.permissionsFor(row.createdBy);
        for (const m of members) {
          if (!readable.has(m.collection)) readable.set(m.collection, Boolean(await perms.canAccess(m.collection, 'read')));
          if (readable.get(m.collection)) visible.push(m);
        }
        release = { ...rel, items: visible };
      }
    }
    return { target, item, release };
  }
}
