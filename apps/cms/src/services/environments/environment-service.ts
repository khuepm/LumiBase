/**
 * EnvironmentService — create, list, read and delete the environments of one
 * origin site (#853 task 3, design §5, §11).
 *
 * Tenancy (Req 11): the service is constructed with the ORIGIN site id from the
 * request context and never accepts a second site id from a caller. An
 * environment is always loaded as `(site_id = origin, key)`, and only then is
 * its child site id read from the row. Both sites must belong to the same
 * organization; that is asserted before any cross-site operation.
 *
 * Connections: `db` is the request connection scoped to the origin; `systemDb`
 * is used for the few statements that must see both sites (provisioning the
 * child site, reading the child while promoting). Every one of those names its
 * site explicitly.
 */

import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { collections, environments, items, settings, sites, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { AuditLogger } from '../../modules/audit/logger';
import { provisionSite } from '../site-provisioning';
import { forgetNegative, negativeSiteKey } from '../negative-cache';
import { invalidateSiteExists } from '../domains/site-exists-cache';
import { invalidateSiteOrganization } from '../domains/site-organization-cache';
import { EnvironmentError } from './errors';
import { parseScope, type ContentScope, type ForkCursor } from './fork';
import { ENVIRONMENT_MARKER_KEY, environmentOriginOf, forgetEnvironmentSite } from './isolation';

export const ENVIRONMENT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const DEFAULT_MAX_PER_SITE = 3;
export const DEFAULT_MAX_ITEMS_PER_FORK = 50_000;
/** Above this many changed items the detail view reports `truncated` instead of counting on. */
export const CHANGED_ITEMS_CAP = 1_000;

export type EnvironmentRow = typeof environments.$inferSelect;

export interface EnvironmentView {
  id: string;
  key: string;
  name: string;
  status: EnvironmentRow['status'];
  statusReason: string | null;
  /** The child site id: what Studio selects to work inside the environment. */
  siteId: string;
  originSiteId: string;
  contentScope: ContentScope;
  progress: { phase: string; counts: Record<string, number> };
  forkedBy: string | null;
  forkedAt: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentDetail extends EnvironmentView {
  /** Origin content or schema written after the fork (timestamp based, capped). */
  originChanged: boolean;
  /** Environment items written after the fork (capped at {@link CHANGED_ITEMS_CAP}). */
  changedItems: number | null;
  truncated: boolean;
}

export function toEnvironmentView(row: EnvironmentRow): EnvironmentView {
  const cursor = (row.forkCursor ?? {}) as ForkCursor;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    statusReason: row.statusReason,
    siteId: row.environmentSiteId,
    originSiteId: row.siteId,
    contentScope: parseScope(row.contentScope),
    progress: { phase: cursor.phase ?? 'schema', counts: (cursor.counts ?? {}) as Record<string, number> },
    forkedBy: row.forkedBy,
    forkedAt: row.forkedAt?.toISOString() ?? null,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface EnvironmentServiceDeps {
  /** Request connection, scoped to the origin. */
  db: Database;
  /** Connection that may read and write both sites (system role under RLS enforce). */
  systemDb: Database;
  /** The origin site: always the request's own site. */
  siteId: string;
  /** Signed-in staff user (API keys are refused at the route). */
  userId: string;
  cache?: CacheProvider;
}

export interface CreateEnvironmentInput {
  key: string;
  name: string;
  contentScope: ContentScope;
}

async function numberSetting(db: Database, siteId: string, key: string, fallback: number): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(and(eq(settings.siteId, siteId), eq(settings.key, key))).limit(1);
  const raw = row?.value as unknown;
  const n = typeof raw === 'number' ? raw : typeof raw === 'object' && raw && typeof (raw as { value?: unknown }).value === 'number' ? (raw as { value: number }).value : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  get originSiteId(): string {
    return this.deps.siteId;
  }

  /** Load an environment of THIS origin by key; 404 for any other origin's key (no existence leak). */
  async load(key: string): Promise<EnvironmentRow> {
    const [row] = await this.deps.db
      .select()
      .from(environments)
      .where(and(eq(environments.siteId, this.deps.siteId), eq(environments.key, key)))
      .limit(1);
    if (!row) throw new EnvironmentError('NOT_FOUND', `Environment "${key}" not found.`, 404);
    return row;
  }

  /** The pair (origin, child) with the same-organization assertion (Req 11.1). */
  async loadPair(key: string): Promise<{ env: EnvironmentRow; originOrganizationId: string }> {
    const env = await this.load(key);
    const pair = await this.deps.systemDb
      .select({ id: sites.id, organizationId: sites.organizationId })
      .from(sites)
      .where(inArray(sites.id, [env.siteId, env.environmentSiteId]));
    const origin = pair.find((s) => s.id === env.siteId);
    const child = pair.find((s) => s.id === env.environmentSiteId);
    if (!origin || !child || origin.organizationId !== child.organizationId) {
      throw new EnvironmentError('ENVIRONMENT_ORGANIZATION_MISMATCH', 'Environment and origin belong to different organizations.', 403);
    }
    return { env, originOrganizationId: origin.organizationId };
  }

  async list(): Promise<EnvironmentView[]> {
    const rows = await this.deps.db
      .select()
      .from(environments)
      .where(eq(environments.siteId, this.deps.siteId))
      .orderBy(asc(environments.createdAt));
    return rows.map(toEnvironmentView);
  }

  async get(key: string): Promise<EnvironmentDetail> {
    const { env } = await this.loadPair(key);
    const view = toEnvironmentView(env);
    if (!env.forkedAt) return { ...view, originChanged: false, changedItems: null, truncated: false };
    const sys = this.deps.systemDb;
    const [originItem] = await sys
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.siteId, env.siteId), gt(items.updatedAt, env.forkedAt)))
      .limit(1);
    const [originSchema] = originItem
      ? [originItem]
      : await sys
          .select({ id: collections.id })
          .from(collections)
          .where(and(eq(collections.siteId, env.siteId), gt(collections.updatedAt, env.forkedAt)))
          .limit(1);
    const changed = await sys
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.siteId, env.environmentSiteId), gt(items.updatedAt, env.forkedAt)))
      .limit(CHANGED_ITEMS_CAP + 1);
    const truncated = changed.length > CHANGED_ITEMS_CAP;
    return {
      ...view,
      originChanged: !!originSchema,
      changedItems: truncated ? null : changed.length,
      truncated,
    };
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRow> {
    const { db, systemDb, siteId, userId } = this.deps;
    if (!ENVIRONMENT_KEY_PATTERN.test(input.key)) {
      throw new EnvironmentError('VALIDATION', 'Key must be 2–40 lower-case letters, digits or hyphens, starting with a letter.', 400);
    }
    // v1 is one level deep (Req 1.3): an environment cannot be forked.
    const nestedAsChild = await systemDb
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.environmentSiteId, siteId))
      .limit(1);
    if (nestedAsChild.length > 0 || (await environmentOriginOf(db, siteId))) {
      throw new EnvironmentError('ENVIRONMENT_NESTING_UNSUPPORTED', 'An environment cannot be forked.', 409);
    }
    const [taken] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.siteId, siteId), eq(environments.key, input.key)))
      .limit(1);
    if (taken) throw new EnvironmentError('ENVIRONMENT_KEY_TAKEN', `An environment with key "${input.key}" already exists.`, 409);

    const maxPerSite = await numberSetting(db, siteId, 'environments.maxPerSite', DEFAULT_MAX_PER_SITE);
    const [active] = await db
      .select({ n: count() })
      .from(environments)
      .where(and(eq(environments.siteId, siteId), ne(environments.status, 'archived')));
    if ((active?.n ?? 0) >= maxPerSite) {
      throw new EnvironmentError('ENVIRONMENT_LIMIT_REACHED', `This site already has ${maxPerSite} environment(s).`, 409, { maxPerSite });
    }

    const scope = input.contentScope;
    const originCollections = await db.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId));
    if (scope.mode === 'collections') {
      const known = new Set(originCollections.map((c) => c.name));
      const unknown = scope.collections.filter((c) => !known.has(c));
      if (scope.collections.length === 0 || unknown.length > 0) {
        throw new EnvironmentError('UNKNOWN_COLLECTION', unknown.length > 0 ? `Unknown collection(s): ${unknown.join(', ')}.` : 'List at least one collection.', 400, { unknown });
      }
    }
    if (scope.mode !== 'none') {
      const ids = originCollections.filter((c) => scope.mode === 'all' || scope.collections.includes(c.name)).map((c) => c.id);
      const maxItems = await numberSetting(db, siteId, 'environments.maxItemsPerFork', DEFAULT_MAX_ITEMS_PER_FORK);
      if (ids.length > 0) {
        const [n] = await db
          .select({ n: count() })
          .from(items)
          .where(and(eq(items.siteId, siteId), inArray(items.collectionId, ids), isNull(items.deletedAt)));
        if ((n?.n ?? 0) > maxItems) {
          throw new EnvironmentError('ENVIRONMENT_TOO_LARGE', `The content scope holds ${n?.n} items; the limit is ${maxItems}. Fork fewer collections.`, 409, { items: n?.n, maxItems });
        }
      }
    }

    const [origin] = await systemDb.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!origin) throw new EnvironmentError('NOT_FOUND', 'Site not found.', 404);

    const env = await systemDb.transaction(async (tx) => {
      const { site } = await provisionSite(tx as unknown as Database, {
        name: `${origin.name} · ${input.name}`.slice(0, 200),
        organizationId: origin.organizationId,
        creatorUserId: userId,
        displayTitle: origin.displayTitle ?? undefined,
        defaultLanguage: origin.defaultLanguage ?? undefined,
      });
      // The marker the side-effect guards read (isolation.ts), written with the site.
      await tx.insert(settings).values({ siteId: site.id, key: ENVIRONMENT_MARKER_KEY, value: { originSiteId: siteId, key: input.key }, scope: 'system' });
      const [row] = await tx
        .insert(environments)
        .values({
          siteId,
          environmentSiteId: site.id,
          key: input.key,
          name: input.name,
          status: 'forking',
          contentScope: scope,
          forkCursor: { phase: 'schema', counts: {} },
          forkedBy: userId,
        })
        .returning();
      return row!;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new EnvironmentError('ENVIRONMENT_KEY_TAKEN', `An environment with key "${input.key}" already exists.`, 409);
      throw err;
    });

    // Deliberately NOT finalizeSiteProvisioning: it reconciles official
    // extensions with `enabled = enabledByDefault`, and an environment must
    // start with no extension enabled (design §4 item 1a). Only the caches.
    if (this.deps.cache) {
      await Promise.all([
        forgetNegative(this.deps.cache, negativeSiteKey(env.environmentSiteId)),
        invalidateSiteExists(this.deps.cache, env.environmentSiteId),
        invalidateSiteOrganization(this.deps.cache, env.environmentSiteId),
      ]).catch(() => undefined);
    }
    return env;
  }

  /** Re-arm a failed fork from its saved cursor. */
  async retry(key: string): Promise<EnvironmentRow> {
    const env = await this.load(key);
    if (env.status !== 'failed' || env.forkedAt) {
      throw new EnvironmentError('ENVIRONMENT_NOT_RETRYABLE', 'Only a fork that failed can be retried.', 409);
    }
    const [row] = await this.deps.db
      .update(environments)
      .set({ status: 'forking', statusReason: null, leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(environments.id, env.id), eq(environments.siteId, this.deps.siteId), eq(environments.status, 'failed')))
      .returning();
    if (!row) throw new EnvironmentError('ENVIRONMENT_BUSY', 'The environment changed state; reload and retry.', 409);
    return row;
  }

  /**
   * Delete the environment: its child site and everything in it (cascade).
   * Never touches the origin. File rows go with the site; storage objects are
   * never deleted with a file row, so the origin keeps every file (Req 3.2).
   */
  async delete(key: string): Promise<void> {
    const { env } = await this.loadPair(key);
    // A fork is busy only while a worker holds its lease; one whose worker died
    // (expired lease) may be deleted — the claim below stops the tick taking it.
    const leaseHeld = env.leaseUntil !== null && env.leaseUntil > new Date();
    if (env.status === 'merging' || (env.status === 'forking' && leaseHeld)) {
      throw new EnvironmentError('ENVIRONMENT_BUSY', `Environment is ${env.status}.`, 409);
    }
    // Claim it so a concurrent fork step or promote cannot start meanwhile.
    const [claimed] = await this.deps.db
      .update(environments)
      .set({ status: 'archived', statusReason: 'deleting', updatedAt: new Date() })
      .where(and(eq(environments.id, env.id), eq(environments.siteId, this.deps.siteId), sql`${environments.status} <> 'merging'`))
      .returning({ id: environments.id });
    if (!claimed) throw new EnvironmentError('ENVIRONMENT_BUSY', 'Environment is merging.', 409);

    await this.deps.systemDb.delete(sites).where(eq(sites.id, env.environmentSiteId));
    forgetEnvironmentSite(env.environmentSiteId);
    if (this.deps.cache) {
      await Promise.all([
        invalidateSiteExists(this.deps.cache, env.environmentSiteId),
        invalidateSiteOrganization(this.deps.cache, env.environmentSiteId),
      ]).catch(() => undefined);
    }
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'environment_deleted',
      siteId: this.deps.siteId,
      metadata: { environmentId: env.id, environmentSiteId: env.environmentSiteId, originSiteId: this.deps.siteId, key: env.key, actorUserId: this.deps.userId },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
