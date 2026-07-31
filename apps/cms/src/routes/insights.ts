/**
 * Insights routes — dashboards, panels, and panel execution.
 * Mounted at `/api/v1/dashboards`. See `.kiro/specs/insights-dashboard`.
 *
 *   GET/POST           /dashboards
 *   GET/PATCH/DELETE   /dashboards/:id
 *   GET/POST           /dashboards/:id/panels
 *   PATCH/DELETE       /dashboards/:id/panels/:panelId
 *   POST               /dashboards/:id/panels/:panelId/data   (run the panel)
 *   POST               /dashboards/:id/panels/preview         (dry-run a query)
 */

import { dashboards, panels, scopeSite } from '@lumibase/database';
import {
  dashboardCreateSchema,
  panelCreateSchema,
  panelQuerySchema,
  type PanelQuery,
} from '@lumibase/shared';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { InsightsService, InsightsServiceError } from '../services/insights-service';
import { SchemaService } from '../services/schema-service';

export const insightsRouter = new Hono<AppEnv>();

function buildInsights(c: Context<AppEnv>): InsightsService {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const runtime = c.get('runtime');
  return new InsightsService({
    db,
    siteId,
    schema: new SchemaService({ db, siteId, cache: runtime.cache }),
  });
}

function zodErr(c: Context<AppEnv>, issues: z.ZodIssue[]) {
  return c.json({ errors: issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
}

// ── Dashboards ───────────────────────────────────────────────────────────────

insightsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const rows = await db.select().from(dashboards).where(scopeSite(dashboards.siteId, siteId));
  return c.json({ data: rows });
});

insightsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const parsed = dashboardCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodErr(c, parsed.error.issues);
  const [row] = await db
    .insert(dashboards)
    .values({ siteId, ...parsed.data, createdBy: auth?.userId ?? null })
    .returning();
  return c.json({ data: row }, 201);
});

insightsRouter.get('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [row] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, c.req.param('id')), scopeSite(dashboards.siteId, siteId)))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

insightsRouter.patch('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const parsed = dashboardCreateSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return zodErr(c, parsed.error.issues);
  const [row] = await db
    .update(dashboards)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(dashboards.id, c.req.param('id')), scopeSite(dashboards.siteId, siteId)))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

insightsRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [row] = await db
    .delete(dashboards)
    .where(and(eq(dashboards.id, c.req.param('id')), scopeSite(dashboards.siteId, siteId)))
    .returning({ id: dashboards.id });
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// ── Panels ───────────────────────────────────────────────────────────────────

/** Confirm the dashboard exists in this site; returns its id or null. */
async function assertDashboard(c: Context<AppEnv>, id: string) {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [row] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, id), scopeSite(dashboards.siteId, siteId)))
    .limit(1);
  return row?.id ?? null;
}

insightsRouter.get('/:id/panels', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const dashId = await assertDashboard(c, c.req.param('id'));
  if (!dashId) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const rows = await db
    .select()
    .from(panels)
    .where(and(eq(panels.dashboardId, dashId), scopeSite(panels.siteId, siteId)));
  return c.json({ data: rows });
});

insightsRouter.post('/:id/panels', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const dashId = await assertDashboard(c, c.req.param('id'));
  if (!dashId) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const parsed = panelCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodErr(c, parsed.error.issues);
  const [row] = await db
    .insert(panels)
    .values({ siteId, dashboardId: dashId, ...parsed.data })
    .returning();
  return c.json({ data: row }, 201);
});

const panelPatchSchema = panelCreateSchema.partial();

insightsRouter.patch('/:id/panels/:panelId', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const parsed = panelPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodErr(c, parsed.error.issues);
  const [row] = await db
    .update(panels)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(panels.id, c.req.param('panelId')), scopeSite(panels.siteId, siteId)))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

insightsRouter.delete('/:id/panels/:panelId', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [row] = await db
    .delete(panels)
    .where(and(eq(panels.id, c.req.param('panelId')), scopeSite(panels.siteId, siteId)))
    .returning({ id: panels.id });
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// ── Execution ────────────────────────────────────────────────────────────────

const runOverrideSchema = z
  .object({ filter: z.record(z.string(), z.unknown()).optional(), dateRange: z.record(z.string(), z.unknown()).optional() })
  .optional();

insightsRouter.post('/:id/panels/:panelId/data', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [row] = await db
    .select()
    .from(panels)
    .where(and(eq(panels.id, c.req.param('panelId')), scopeSite(panels.siteId, siteId)))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);

  const override = runOverrideSchema.safeParse(await c.req.json().catch(() => undefined));
  try {
    const source = (row.options as { source?: 'items' | 'materialized' } | null)?.source;
    const result = await buildInsights(c).runPanel(
      row.query as PanelQuery,
      override.success ? (override.data as Partial<PanelQuery>) : undefined,
      source ? { source } : undefined,
    );
    return c.json(result);
  } catch (e) {
    if (e instanceof InsightsServiceError) {
      return c.json({ errors: [{ code: e.code, message: e.message }] }, e.status as 400);
    }
    throw e;
  }
});

/** Dry-run a query without a saved panel (editor preview). */
insightsRouter.post('/:id/panels/preview', async (c) => {
  const parsed = panelQuerySchema.safeParse(await c.req.json());
  if (!parsed.success) return zodErr(c, parsed.error.issues);
  try {
    const result = await buildInsights(c).runPanel(parsed.data);
    return c.json(result);
  } catch (e) {
    if (e instanceof InsightsServiceError) {
      return c.json({ errors: [{ code: e.code, message: e.message }] }, e.status as 400);
    }
    throw e;
  }
});
