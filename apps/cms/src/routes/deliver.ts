import { schema } from '@lumibase/database';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv, Variables } from '../env';
import {
  etagMatches,
  resolveDeliveryCachePolicy,
  weakEtag,
} from '../services/delivery-cache';
import {
  assertPublicIdentifier,
  SAFE_FIELD_NAME,
} from '../services/identifier-guard';
import {
  buildNegativeCache,
  negativePageKey,
  negativeSiteKey,
  resolveNegativeTtl,
} from '../services/negative-cache';
import { buildSeo } from '../services/seo-builder';

/**
 * Delivery API — implements the "1-Roundtrip Rule" (Strict Rule #3).
 *
 * GET /api/v1/deliver/page/:site_id/:slug
 *   1. Fetch the `pages` record scoped by site_id + slug (multi-tenancy).
 *   2. Read `layoutConfig.sections` and resolve declared data dependencies.
 *   3. Parallel-fetch each section's collection data via Drizzle.
 *   4. Merge layout + data into a single JSON payload.
 */
export const deliverRouter = new Hono<AppEnv>();

const DEFAULT_SECTION_LIMIT = 10;
const MAX_SECTION_LIMIT = 50;

interface SectionConfig {
  id: string;
  component: string;
  styleConfig?: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** Optional declarative data binding the resolver will hydrate. */
  source?: {
    collection: string;
    limit?: number;
    orderBy?: string;
    /** Public delivery defaults to published items. */
    status?: string;
    /** Emit a normalised `_seo` block per item (Req 14.1). */
    seo?: boolean | { jsonLdType?: string };
  };
}

interface LayoutConfig {
  sections?: SectionConfig[];
}

interface DeliveryItemRow {
  id: string;
  status: string;
  sort: number;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SECTION_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_SECTION_LIMIT);
}

function fieldExpression(name: string): SQL | undefined {
  switch (name) {
    case 'id':
      return sql`${schema.items.id}`;
    case 'status':
      return sql`${schema.items.status}`;
    case 'sort':
      return sql`${schema.items.sort}`;
    case 'created_at':
    case 'createdAt':
      return sql`${schema.items.createdAt}`;
    case 'updated_at':
    case 'updatedAt':
      return sql`${schema.items.updatedAt}`;
    default:
      if (!SAFE_FIELD_NAME.test(name)) return undefined;
      return sql`${schema.items.data}->>${name}`;
  }
}

function buildSort(orderBy?: string) {
  if (!orderBy) return [desc(schema.items.updatedAt)];
  const direction = orderBy.startsWith('-') ? 'desc' : 'asc';
  const field = orderBy.replace(/^-/, '');
  const expression = fieldExpression(field);
  if (!expression) return [desc(schema.items.updatedAt)];
  return direction === 'desc' ? [desc(expression)] : [asc(expression)];
}

/**
 * SQL predicate restricting results to the current Publish_Window (Req 7.5):
 * `publishAt` is unset or in the past AND `unpublishAt` is unset or in the
 * future. Items with a future `publishAt` or an elapsed `unpublishAt` are
 * excluded even when `status='published'`.
 */
function publishWindowClause(): SQL | undefined {
  const now = new Date();
  return and(
    or(isNull(schema.items.publishAt), lte(schema.items.publishAt, now)),
    or(isNull(schema.items.unpublishAt), gt(schema.items.unpublishAt, now)),
  );
}

function serializeItem(
  row: DeliveryItemRow,
  seo?: { jsonLdType?: string },
): Record<string, unknown> {
  const data =
    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {
    ...data,
    id: row.id,
    status: row.status,
    sort: row.sort,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (seo) {
    const block = buildSeo(out, { jsonLdType: seo.jsonLdType });
    if (block) out._seo = block;
  }

  return out;
}

/**
 * Public provenance projection (C2PA-inspired). Deliberately excludes
 * internal data such as run inputs or prompt material — only the lineage
 * facts a downstream consumer needs to attribute the content.
 */
interface ItemProvenanceView {
  authorType: string;
  model: string | null;
  confidence: number | null;
  constitutionHash: string | null;
  sources: unknown;
  revisedAt: Date;
}

async function loadProvenance(
  db: Variables['db'],
  siteId: string,
  itemIds: string[],
): Promise<Map<string, ItemProvenanceView>> {
  const result = new Map<string, ItemProvenanceView>();
  if (itemIds.length === 0) return result;

  const rows = await db
    .select({
      itemId: schema.revisions.itemId,
      authorType: schema.revisions.authorType,
      model: schema.revisions.model,
      confidence: schema.revisions.confidence,
      constitutionHash: schema.revisions.constitutionHash,
      sources: schema.revisions.sources,
      createdAt: schema.revisions.createdAt,
    })
    .from(schema.revisions)
    .where(
      and(
        eq(schema.revisions.siteId, siteId),
        inArray(schema.revisions.itemId, itemIds),
        eq(schema.revisions.staged, false),
      ),
    )
    .orderBy(desc(schema.revisions.createdAt));

  for (const row of rows) {
    // Rows are newest-first; keep only the latest revision per item.
    if (result.has(row.itemId)) continue;
    result.set(row.itemId, {
      authorType: row.authorType,
      model: row.model,
      confidence: row.confidence,
      constitutionHash: row.constitutionHash,
      sources: row.sources,
      revisedAt: row.createdAt,
    });
  }
  return result;
}

async function hydrateSection(
  db: Variables['db'],
  siteId: string,
  section: SectionConfig,
  withProvenance = false,
) {
  const base = {
    id: section.id,
    component: section.component,
    styleConfig: section.styleConfig ?? {},
    data: section.data ?? {},
  };

  if (!section.source?.collection) return base;

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.siteId, siteId),
        eq(schema.collections.name, section.source.collection),
      ),
    )
    .limit(1);

  if (!collection) {
    return {
      ...base,
      data: { ...base.data, items: [] },
      sourceError: {
        code: 'SOURCE_COLLECTION_NOT_FOUND',
        collection: section.source.collection,
      },
    };
  }

  const rows = await db
    .select({
      id: schema.items.id,
      status: schema.items.status,
      sort: schema.items.sort,
      data: schema.items.data,
      createdAt: schema.items.createdAt,
      updatedAt: schema.items.updatedAt,
    })
    .from(schema.items)
    .where(
      and(
        eq(schema.items.siteId, siteId),
        eq(schema.items.collectionId, collection.id),
        eq(schema.items.status, section.source.status ?? 'published'),
        isNull(schema.items.deletedAt),
        // Publish_Window filter (Req 7.5): only items currently in window.
        publishWindowClause(),
      ),
    )
    .orderBy(...buildSort(section.source.orderBy))
    .limit(clampLimit(section.source.limit));

  const seoOption = section.source.seo
    ? { jsonLdType: typeof section.source.seo === 'object' ? section.source.seo.jsonLdType : undefined }
    : undefined;
  const items = rows.map((row) => serializeItem(row as DeliveryItemRow, seoOption));

  if (withProvenance) {
    const provenance = await loadProvenance(
      db,
      siteId,
      rows.map((row) => row.id),
    );
    for (const item of items) {
      const view = provenance.get(item['id'] as string);
      if (view) item['_provenance'] = view;
    }
  }

  return {
    ...base,
    data: {
      ...base.data,
      items,
    },
  };
}

/**
 * Public llms.txt index per site (content-os task 4.3; Req 4.5).
 *
 * Follows the llms.txt convention (H1 title, blockquote summary, H2 link
 * sections) so LLM crawlers and agents can discover what the site publishes
 * and where the machine-readable surfaces live. Only public facts are
 * listed: visible non-system collections and published pages — never drafts,
 * hidden collections or internal agent state.
 */
deliverRouter.get('/llms.txt/:site_id', async (c) => {
  const siteId = c.req.param('site_id');
  const shape = assertPublicIdentifier('siteId', siteId);
  if (!shape.ok) {
    return c.text('Site not found.', 404);
  }

  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const ttl = resolveNegativeTtl(c.env);
  const neg =
    cache && ttl > 0
      ? buildNegativeCache(cache, ttl, {
          onNegativeHit: () => {
            void import('./metrics').then((m) => m.cacheNegativeHitsTotal.inc());
          },
          onNegativeWrite: () => {
            void import('./metrics').then((m) => m.cacheNegativeWritesTotal.inc());
          },
        })
      : null;

  const site = await (neg
    ? neg.resolve(negativeSiteKey(siteId), async () => {
        const [row] = await db
          .select({ id: schema.sites.id, name: schema.sites.name, domain: schema.sites.domain })
          .from(schema.sites)
          .where(eq(schema.sites.id, siteId))
          .limit(1);
        return row ?? null;
      })
    : (async () => {
        const [row] = await db
          .select({ id: schema.sites.id, name: schema.sites.name, domain: schema.sites.domain })
          .from(schema.sites)
          .where(eq(schema.sites.id, siteId))
          .limit(1);
        return row ?? null;
      })());

  if (!site) {
    return c.text('Site not found.', 404);
  }

  const [cols, publishedPages] = await Promise.all([
    db
      .select({
        name: schema.collections.name,
        label: schema.collections.label,
        note: schema.collections.note,
      })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.siteId, siteId),
          eq(schema.collections.hidden, false),
          eq(schema.collections.system, false),
        ),
      )
      .orderBy(asc(schema.collections.name)),
    db
      .select({ slug: schema.pages.slug, title: schema.pages.title })
      .from(schema.pages)
      .where(eq(schema.pages.siteId, siteId))
      .orderBy(asc(schema.pages.slug))
      .limit(100),
  ]);

  const base = `/api/v1/deliver`;
  const lines: string[] = [
    `# ${site.name}`,
    '',
    `> Content published by ${site.name} via LumiBase, an Edge-native headless CMS. Pages are served as a single JSON payload; append \`?provenance=true\` for C2PA-style authorship lineage on every item.`,
    '',
    '## Pages',
    '',
    ...(publishedPages.length > 0
      ? publishedPages.map((p) => `- [${p.title}](${base}/page/${site.id}/${p.slug}): page delivery JSON`)
      : ['- No public pages yet.']),
    '',
    '## Collections',
    '',
    ...(cols.length > 0
      ? cols.map((col) => `- ${col.label ?? col.name} (\`${col.name}\`)${col.note ? `: ${col.note}` : ''}`)
      : ['- No public collections yet.']),
    '',
    '## Optional',
    '',
    `- [Provenance](${base}/page/${site.id}/{slug}?provenance=true): per-item authorType, model and confidence`,
    '',
  ];

  return c.text(lines.join('\n'), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

/** Hydrate every section of a page into the delivery payload. */
async function buildPagePayload(
  db: Variables['db'],
  siteId: string,
  page: { title: string; slug: string; layoutConfig: unknown },
  withProvenance: boolean,
) {
  const layout = (page.layoutConfig ?? {}) as LayoutConfig;
  const sections = layout.sections ?? [];
  const resolved = await Promise.all(
    sections.map((section) => hydrateSection(db, siteId, section, withProvenance)),
  );
  return {
    page: {
      title: page.title,
      slug: page.slug,
    },
    sections: resolved,
  };
}

/**
 * Cheap site-level content fingerprint used as the ETag source
 * (high-load-cache-readiness Req 1.2/1.3; design §3.2). One aggregate query
 * instead of hydrating every section, so an `If-None-Match` revalidation can
 * be answered with 304 without touching per-section item queries.
 *
 * Trade-offs (deliberate — correctness over hit-rate):
 *  - `maxUpdatedAt` is site-wide, so ANY item write in the site rotates the
 *    ETag of every page. Never stale, only a lower 304 hit-rate.
 *  - `visibleCount` counts items currently inside their Publish_Window, so a
 *    scheduled publish/unpublish (which changes visibility without touching
 *    any row) also rotates the ETag. An item entering and another leaving the
 *    window in the same instant cancels out; that residue is bounded by the
 *    shared-cache `s-maxage` staleness budget.
 */
async function contentFingerprint(db: Variables['db'], siteId: string) {
  const [row] = await db
    .select({
      maxUpdatedAt: sql<string | null>`max(${schema.items.updatedAt})`,
      visibleCount: sql<number>`count(*) filter (where ${schema.items.status} = 'published' and ${schema.items.deletedAt} is null and (${schema.items.publishAt} is null or ${schema.items.publishAt} <= now()) and (${schema.items.unpublishAt} is null or ${schema.items.unpublishAt} > now()))::int`,
    })
    .from(schema.items)
    .where(eq(schema.items.siteId, siteId));
  return row ?? { maxUpdatedAt: null, visibleCount: 0 };
}

deliverRouter.get('/page/:site_id/:slug', async (c) => {
  const { site_id: siteId, slug } = c.req.param();

  // Shared caches must never mix tenants: the site is in the URL here, but
  // other API surfaces route on this header (design §15.4).
  c.header('Vary', 'X-Lumi-Site');

  // Tier 1 — shape guard (Req 19.1): reject before any DB / cache op.
  // Same 404 body as a real miss so the endpoint is not an oracle.
  const siteShape = assertPublicIdentifier('siteId', siteId);
  const slugShape = assertPublicIdentifier('slug', slug);
  if (!siteShape.ok || !slugShape.ok) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Not found.' }, 404);
  }

  const db = c.get('db');
  const withProvenance = c.req.query('provenance') === 'true';
  const hasCredentials = Boolean(c.req.header('authorization'));
  const isPreview = c.req.query('preview') === 'true' || c.req.query('draft') === 'true';

  const policy = resolveDeliveryCachePolicy({
    hasCredentials,
    env: c.env,
  });

  const runtime = c.get('runtime');
  const edgeCache = runtime?.edgeCache;

  // Tier 1b — HTTP edge cache (Req 1.6): only for cacheable public traffic.
  if (policy.cacheable && edgeCache) {
    const cached = await edgeCache.match(c.req.raw);
    if (cached) return cached;
  }

  // Tier 2 — tombstone (Req 19.5/19.8): never serve negative cache to
  // credentialed / preview traffic (same boundary as Req 1.4).
  const allowTombstone = !hasCredentials && !isPreview;
  const cache = runtime?.cache;
  const ttl = resolveNegativeTtl(c.env);
  const neg =
    allowTombstone && cache && ttl > 0
      ? buildNegativeCache(cache, ttl, {
          onNegativeHit: () => {
            void import('./metrics').then((m) => m.cacheNegativeHitsTotal.inc());
          },
          onNegativeWrite: () => {
            void import('./metrics').then((m) => m.cacheNegativeWritesTotal.inc());
          },
        })
      : null;

  const loadPage = async () => {
    const [row] = await db
      .select()
      .from(schema.pages)
      .where(and(eq(schema.pages.siteId, siteId), eq(schema.pages.slug, slug)))
      .limit(1);
    return row ?? null;
  };

  const page = neg
    ? await neg.resolve(negativePageKey(siteId, slug), loadPage)
    : await loadPage();

  if (!page) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Page not found.' }, 404);
  }

  if (!policy.cacheable) {
    c.header('Cache-Control', policy.cacheControl);
    return c.json(await buildPagePayload(db, siteId, page, withProvenance));
  }

  const fingerprint = await contentFingerprint(db, siteId);
  const etag = await weakEtag([
    siteId,
    slug,
    withProvenance,
    page.updatedAt,
    fingerprint.maxUpdatedAt,
    fingerprint.visibleCount,
  ]);

  c.header('ETag', etag);
  c.header('Cache-Control', policy.cacheControl);
  if (etagMatches(c.req.header('if-none-match'), etag)) {
    const notModified = c.body(null, 304);
    if (edgeCache) {
      await edgeCache.put(c.req.raw, notModified.clone());
    }
    return notModified;
  }

  const response = c.json(await buildPagePayload(db, siteId, page, withProvenance));
  if (edgeCache) {
    await edgeCache.put(c.req.raw, response.clone());
  }
  return response;
});
