/**
 * PreviewEnvManager — ephemeral preview sites for pull requests.
 *
 * Each open PR gets a derived site (`${baseSiteId}__pr-${number}`) seeded with a
 * copy of the base site's collections/fields/items/pages. The preview is served
 * by the existing public delivery route `GET /api/v1/deliver/page/:site_id/:slug`.
 * Teardown is a cascade-delete of the ephemeral `sites` row.
 *
 * RLS note: provisioning is a *cross-site* operation — it reads the base site
 * then writes a different (ephemeral) site, which the `site_isolation` RLS
 * policy would reject under one scope. Each query therefore runs on
 * `deps.scopedDb(<the site it acts on>)` (B130): base-site reads and the
 * lifecycle rows on the base site, ephemeral writes/deletes on the ephemeral
 * site, so the WITH CHECK passes. With `LUMIBASE_DB_RLS` off, `scopedDb`
 * returns the request db unchanged. See `.kiro/specs/git-integration/design.md`
 * §11 and `.kiro/specs/rls-request-scope/`.
 */
import type { Database } from '@lumibase/database';
import {
  collections as collectionsTable,
  fields as fieldsTable,
  items as itemsTable,
  pages as pagesTable,
  sites as sitesTable,
  gitPreviewEnvs,
  gitPullRequests,
} from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/** Default lifetime of a preview environment. */
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_BATCH = 500;

/** Deterministic ephemeral site id for a PR (pure). */
export function ephemeralSiteId(baseSiteId: string, prNumber: number): string {
  return `${baseSiteId}__pr-${prNumber}`;
}

/** Build an old-id → new-id remap from a list of source rows (pure). */
export function remapIds(rows: { id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, nanoid());
  return map;
}

export interface PreviewEnvDeps {
  db: Database;
  /**
   * The db scoped to a given site (B130); the webhook handler passes
   * `(id) => scopedDbFor(c, id)`. Defaults to `db` for every site.
   */
  scopedDb?: (siteId: string) => Database;
  runtime: RuntimeContext;
  siteId: string;
  integrationId: string;
  publicBaseUrl: string;
  isDev: boolean;
}

export interface PreviewPrInput {
  prId: string;
  number: number;
  state: string;
}

export class PreviewEnvManager {
  constructor(private readonly deps: PreviewEnvDeps) {}

  private previewUrl(ephemeralId: string): string {
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    return `${base}/api/v1/deliver/page/${ephemeralId}/home`;
  }

  /** The db for queries that act on `siteId` (B130). */
  private at(siteId: string): Database {
    return this.deps.scopedDb?.(siteId) ?? this.deps.db;
  }

  /** The base site's db: lifecycle rows and reads of the source content. */
  private get base(): Database {
    return this.at(this.deps.siteId);
  }

  /** Create (or refresh) the preview environment for an opened/updated PR. */
  async ensureForPullRequest(pr: PreviewPrInput): Promise<void> {
    const ephemeralId = ephemeralSiteId(this.deps.siteId, pr.number);

    // Upsert lifecycle row (status pending/updating).
    const [existing] = await this.base
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, pr.prId))
      .limit(1);

    if (existing) {
      await this.base
        .update(gitPreviewEnvs)
        .set({ status: 'updating', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.id, existing.id));
      // Clear prior ephemeral content before re-seeding.
      await this.purgeEphemeral(ephemeralId);
    } else {
      await this.base.insert(gitPreviewEnvs).values({
        siteId: this.deps.siteId,
        integrationId: this.deps.integrationId,
        prId: pr.prId,
        ephemeralSiteId: ephemeralId,
        status: 'pending',
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
      });
    }

    try {
      await this.provision(ephemeralId, pr.number);
      const url = this.previewUrl(ephemeralId);
      await this.base
        .update(gitPreviewEnvs)
        .set({ status: 'ready', url, updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      await this.base
        .update(gitPullRequests)
        .set({ previewUrl: url, updatedAt: new Date() })
        .where(eq(gitPullRequests.id, pr.prId));
    } catch (err) {
      await this.base
        .update(gitPreviewEnvs)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      throw err;
    }
  }

  /** Tear down a preview when its PR closes or merges (idempotent). */
  async destroy(prId: string): Promise<void> {
    const [row] = await this.base
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, prId))
      .limit(1);
    if (!row) return;
    await this.purgeEphemeral(row.ephemeralSiteId);
    // Remove the ephemeral site row itself (content already purged).
    await this.base
      .delete(sitesTable)
      .where(eq(sitesTable.id, row.ephemeralSiteId));
    await this.base
      .update(gitPreviewEnvs)
      .set({ status: 'destroyed', updatedAt: new Date() })
      .where(eq(gitPreviewEnvs.id, row.id));
  }

  /** Destroy any preview whose TTL has elapsed. */
  async cleanupExpired(): Promise<number> {
    const stale = await this.base
      .select()
      .from(gitPreviewEnvs)
      .where(
        and(
          eq(gitPreviewEnvs.siteId, this.deps.siteId),
          lt(gitPreviewEnvs.expiresAt, new Date()),
        ),
      );
    let destroyed = 0;
    for (const row of stale) {
      if (row.status === 'destroyed') continue;
      await this.destroy(row.prId);
      destroyed += 1;
    }
    return destroyed;
  }

  /** Create the ephemeral site row + copy base content into it. */
  private async provision(ephemeralId: string, prNumber: number): Promise<void> {
    const [base] = await this.base
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, this.deps.siteId))
      .limit(1);

    // sites is excluded from RLS, so this insert is unaffected by context.
    await this.base
      .insert(sitesTable)
      .values({
        id: ephemeralId,
        name: `${base?.name ?? this.deps.siteId} (PR #${prNumber})`,
        defaultLanguage: base?.defaultLanguage ?? 'en',
      })
      .onConflictDoNothing();

    await this.copyContent(ephemeralId);
  }

  /** Copy collections → fields → items → pages from base into the ephemeral site. */
  private async copyContent(toSiteId: string): Promise<void> {
    const from = this.deps.siteId;
    const src = this.at(from);

    const cols = await src
      .select()
      .from(collectionsTable)
      .where(eq(collectionsTable.siteId, from));
    const flds = await src
      .select()
      .from(fieldsTable)
      .where(eq(fieldsTable.siteId, from));
    const its = await src
      .select()
      .from(itemsTable)
      .where(and(eq(itemsTable.siteId, from), isNull(itemsTable.deletedAt)));
    const pgs = await src
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.siteId, from));

    const colMap = remapIds(cols);


    await this.insertBatched(
      toSiteId,
      collectionsTable,
      cols.map((c) => ({ ...c, id: colMap.get(c.id)!, siteId: toSiteId })),
    );
    await this.insertBatched(
      toSiteId,
      fieldsTable,
      flds.map((f) => ({
        ...f,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(f.collectionId) ?? f.collectionId,
      })),
    );
    await this.insertBatched(
      toSiteId,
      itemsTable,
      its.map((i) => ({
        ...i,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(i.collectionId) ?? i.collectionId,
      })),
    );
    await this.insertBatched(
      toSiteId,
      pagesTable,
      pgs.map((p) => ({ ...p, id: nanoid(), siteId: toSiteId })),
    );

  }

  /** Delete all content rows for an ephemeral site (keeps the sites row). */
  private async purgeEphemeral(ephemeralId: string): Promise<void> {
    const db = this.at(ephemeralId);
    await db
      .delete(pagesTable)
      .where(eq(pagesTable.siteId, ephemeralId));
    await db
      .delete(itemsTable)
      .where(eq(itemsTable.siteId, ephemeralId));
    await db
      .delete(fieldsTable)
      .where(eq(fieldsTable.siteId, ephemeralId));
    await db
      .delete(collectionsTable)
      .where(eq(collectionsTable.siteId, ephemeralId));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async insertBatched(siteId: string, table: any, rows: any[]): Promise<void> {
    const db = this.at(siteId);
    for (let i = 0; i < rows.length; i += COPY_BATCH) {
      const chunk = rows.slice(i, i + COPY_BATCH);
      if (chunk.length > 0) await db.insert(table).values(chunk);
    }
  }
}
