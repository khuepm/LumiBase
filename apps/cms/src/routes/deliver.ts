import { schema } from '@lumibase/database';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv, Variables } from '../env';

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
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function serializeItem(row: DeliveryItemRow): Record<string, unknown> {
  const data =
    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};

  return {
    ...data,
    id: row.id,
    status: row.status,
    sort: row.sort,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function hydrateSection(
  db: Variables['db'],
  siteId: string,
  section: SectionConfig,
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
      ),
    )
    .orderBy(...buildSort(section.source.orderBy))
    .limit(clampLimit(section.source.limit));

  return {
    ...base,
    data: {
      ...base.data,
      items: rows.map((row) => serializeItem(row as DeliveryItemRow)),
    },
  };
}

deliverRouter.get('/page/:site_id/:slug', async (c) => {
  const { site_id: siteId, slug } = c.req.param();
  const db = c.get('db');

  const [page] = await db
    .select()
    .from(schema.pages)
    .where(and(eq(schema.pages.siteId, siteId), eq(schema.pages.slug, slug)))
    .limit(1);

  if (!page) {
    return c.json({ error: 'Page not found.' }, 404);
  }

  const layout = (page.layoutConfig ?? {}) as LayoutConfig;
  const sections = layout.sections ?? [];

  const resolved = await Promise.all(sections.map((section) => hydrateSection(db, siteId, section)));

  return c.json({
    page: {
      title: page.title,
      slug: page.slug,
    },
    sections: resolved,
  });
});
