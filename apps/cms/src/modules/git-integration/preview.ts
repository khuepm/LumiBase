/**
 * PreviewEnvManager — ephemeral preview sites for pull requests.
 *
 * Each open PR gets a derived site (`${baseSiteId}__pr-${number}`) seeded with a
 * copy of the base site's collections/fields/items/pages. The preview is served
 * by the existing public delivery route `GET /api/v1/deliver/page/:site_id/:slug`.
 * Teardown is a cascade-delete of the ephemeral `sites` row.
 *
 * RLS note: provisioning is a *cross-site* system operation — it reads the base
 * site then writes a different (ephemeral) site, which the per-request
 * `site_isolation` RLS policy would reject. We read under the base context, then
 * switch the session `app.site_id` to the ephemeral site before inserting so the
 * WITH CHECK passes. In production this still requires the app role to be able to
 * SET the var (the same mechanism `withRls` uses); in dev RLS is skipped. See
 * `.kiro/specs/git-integration/design.md` §11.
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

  /** Best-effort RLS context switch (mirrors `withRls`); no-op in dev. */
  private async setContext(siteId: string): Promise<void> {
    if (this.deps.isDev) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sql = this.deps.runtime.database.getConnection() as any;
      await sql`SELECT set_config('app.site_id', ${siteId}, true)`;
    } catch {
      // non-fatal; primary gate is application scoping
    }
  }

  /** Create (or refresh) the preview environment for an opened/updated PR. */
  async ensureForPullRequest(pr: PreviewPrInput): Promise<void> {
    const ephemeralId = ephemeralSiteId(this.deps.siteId, pr.number);

    // Upsert lifecycle row (status pending/updating).
    const [existing] = await this.deps.db
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, pr.prId))
      .limit(1);

    if (existing) {
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'updating', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.id, existing.id));
      // Clear prior ephemeral content before re-seeding.
      await this.purgeEphemeral(ephemeralId);
    } else {
      await this.deps.db.insert(gitPreviewEnvs).values({
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
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'ready', url, updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      await this.deps.db
        .update(gitPullRequests)
        .set({ previewUrl: url, updatedAt: new Date() })
        .where(eq(gitPullRequests.id, pr.prId));
    } catch (err) {
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      throw err;
    }
  }

  /** Tear down a preview when its PR closes or merges (idempotent). */
  async destroy(prId: string): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, prId))
      .limit(1);
    if (!row) return;
    await this.purgeEphemeral(row.ephemeralSiteId);
    // Remove the ephemeral site row itself (content already purged).
    await this.setContext(this.deps.siteId);
    await this.deps.db
      .delete(sitesTable)
      .where(eq(sitesTable.id, row.ephemeralSiteId));
    await this.deps.db
      .update(gitPreviewEnvs)
      .set({ status: 'destroyed', updatedAt: new Date() })
      .where(eq(gitPreviewEnvs.id, row.id));
  }

  /** Destroy any preview whose TTL has elapsed. */
  async cleanupExpired(): Promise<number> {
    const stale = await this.deps.db
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
    const [base] = await this.deps.db
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, this.deps.siteId))
      .limit(1);

    // sites is excluded from RLS, so this insert is unaffected by context.
    await this.deps.db
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

    // Read under the base-site context.
    await this.setContext(from);
    const cols = await this.deps.db
      .select()
      .from(collectionsTable)
      .where(eq(collectionsTable.siteId, from));
    const flds = await this.deps.db
      .select()
      .from(fieldsTable)
      .where(eq(fieldsTable.siteId, from));
    const its = await this.deps.db
      .select()
      .from(itemsTable)
      .where(and(eq(itemsTable.siteId, from), isNull(itemsTable.deletedAt)));
    const pgs = await this.deps.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.siteId, from));

    const colMap = remapIds(cols);

    // Write under the ephemeral-site context so RLS WITH CHECK passes.
    await this.setContext(toSiteId);

    await this.insertBatched(
      collectionsTable,
      cols.map((c) => ({ ...c, id: colMap.get(c.id)!, siteId: toSiteId })),
    );
    await this.insertBatched(
      fieldsTable,
      flds.map((f) => ({
        ...f,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(f.collectionId) ?? f.collectionId,
      })),
    );
    await this.insertBatched(
      itemsTable,
      its.map((i) => ({
        ...i,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(i.collectionId) ?? i.collectionId,
      })),
    );
    await this.insertBatched(
      pagesTable,
      pgs.map((p) => ({ ...p, id: nanoid(), siteId: toSiteId })),
    );

    // Restore the base context for the caller.
    await this.setContext(from);
  }

  /** Delete all content rows for an ephemeral site (keeps the sites row). */
  private async purgeEphemeral(ephemeralId: string): Promise<void> {
    await this.setContext(ephemeralId);
    await this.deps.db
      .delete(pagesTable)
      .where(eq(pagesTable.siteId, ephemeralId));
    await this.deps.db
      .delete(itemsTable)
      .where(eq(itemsTable.siteId, ephemeralId));
    await this.deps.db
      .delete(fieldsTable)
      .where(eq(fieldsTable.siteId, ephemeralId));
    await this.deps.db
      .delete(collectionsTable)
      .where(eq(collectionsTable.siteId, ephemeralId));
    await this.setContext(this.deps.siteId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async insertBatched(table: any, rows: any[]): Promise<void> {
    for (let i = 0; i < rows.length; i += COPY_BATCH) {
      const chunk = rows.slice(i, i + COPY_BATCH);
      if (chunk.length > 0) await this.deps.db.insert(table).values(chunk);
    }
  }
}
