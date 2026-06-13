/**
 * Materialized collections routes — POST-GA6 + POST-GA Task #4.
 *
 *   GET    /api/v1/materialize             list materializations
 *   POST   /api/v1/materialize             register + create physical table
 *   POST   /api/v1/materialize/:id/refresh physical table refresh
 *   GET    /api/v1/materialize/:id/data    query physical table directly
 *   DELETE /api/v1/materialize/:id         drop physical table + metadata
 *
 * POST-GA Task #4 upgrade: the refresh strategy is now a full "physical
 * refresh" — we create a dedicated table `mat_{target}`, TRUNCATE + INSERT
 * from the source items table. For `auto` strategy, a PG trigger is
 * installed to send NOTIFY events on source changes.
 */

import {
  collections,
  materializedCollections,
} from "@lumibase/database";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import {
  createPhysicalTable,
  refreshPhysicalTable,
  dropPhysicalTable,
  installAutoRefreshTrigger,
  removeAutoRefreshTrigger,
  queryPhysicalTable,
  type MaterializeConfig,
} from "../services/materialize-service";

export const materializeRouter = new Hono<AppEnv>();

const registerSchema = z.object({
  collection: z.string().min(1),
  target: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  refreshStrategy: z.enum(["auto", "cron", "manual"]).default("manual"),
  refreshCron: z.string().optional(),
  projection: z
    .object({
      fields: z.array(z.string()).default(["*"]),
      orderBy: z.string().optional(),
    })
    .default({ fields: ["*"] }),
  filter: z.record(z.unknown()).default({}),
});

materializeRouter.get("/", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const rows = await db
    .select()
    .from(materializedCollections)
    .where(eq(materializedCollections.siteId, siteId));
  return c.json({ data: rows });
});

materializeRouter.post("/", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const parsed = registerSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({
          code: "VALIDATION",
          message: i.message,
        })),
      },
      400,
    );
  }

  // Verify source collection exists
  const [coll] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.siteId, siteId),
        eq(collections.name, parsed.data.collection),
      ),
    );
  if (!coll) {
    return c.json(
      {
        errors: [
          {
            code: "NOT_FOUND",
            message: `Source collection '${parsed.data.collection}' not found`,
          },
        ],
      },
      404,
    );
  }

  // Insert metadata row
  const inserted = await db
    .insert(materializedCollections)
    .values({ siteId, ...parsed.data })
    .returning();

  const mc = inserted[0]!;

  // Create the physical table
  const config: MaterializeConfig = {
    id: mc.id,
    siteId,
    collection: parsed.data.collection,
    target: parsed.data.target,
    refreshStrategy: parsed.data.refreshStrategy,
    projection: parsed.data.projection,
    filter: parsed.data.filter as Record<string, unknown>,
  };

  try {
    await createPhysicalTable(db, config);

    // If auto-refresh, install trigger
    if (parsed.data.refreshStrategy === "auto") {
      await installAutoRefreshTrigger(db, config);
    }
  } catch (err) {
    // Clean up metadata if table creation fails
    await db
      .delete(materializedCollections)
      .where(eq(materializedCollections.id, mc.id));
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { errors: [{ code: "CREATE_FAILED", message }] },
      500,
    );
  }

  return c.json({ data: mc }, 201);
});

materializeRouter.post("/:id/refresh", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const id = c.req.param("id");

  const [mc] = await db
    .select()
    .from(materializedCollections)
    .where(
      and(
        eq(materializedCollections.id, id),
        eq(materializedCollections.siteId, siteId),
      ),
    );
  if (!mc)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Materialization not found" }] },
      404,
    );

  await db
    .update(materializedCollections)
    .set({ status: "refreshing", error: null, updatedAt: new Date() })
    .where(eq(materializedCollections.id, id));

  try {
    const config: MaterializeConfig = {
      id: mc.id,
      siteId,
      collection: mc.collection,
      target: mc.target,
      refreshStrategy: mc.refreshStrategy,
      projection: mc.projection as { fields: string[]; orderBy?: string },
      filter: mc.filter as Record<string, unknown>,
    };

    const result = await refreshPhysicalTable(db, config);

    await db
      .update(materializedCollections)
      .set({
        status: "idle",
        rowCount: result.rowCount,
        lastRefreshedAt: result.lastRefreshedAt,
        updatedAt: new Date(),
      })
      .where(eq(materializedCollections.id, id));

    return c.json({
      data: {
        id,
        rowCount: result.rowCount,
        lastRefreshedAt: result.lastRefreshedAt.toISOString(),
        durationMs: result.durationMs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(materializedCollections)
      .set({ status: "error", error: message, updatedAt: new Date() })
      .where(eq(materializedCollections.id, id));
    return c.json({ errors: [{ code: "REFRESH_FAILED", message }] }, 500);
  }
});

/**
 * GET /:id/data — query the physical materialized table directly.
 */
materializeRouter.get("/:id/data", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const id = c.req.param("id");

  const [mc] = await db
    .select()
    .from(materializedCollections)
    .where(
      and(
        eq(materializedCollections.id, id),
        eq(materializedCollections.siteId, siteId),
      ),
    );
  if (!mc)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Materialization not found" }] },
      404,
    );

  const limit = Number(c.req.query("limit") ?? "100");
  const offset = Number(c.req.query("offset") ?? "0");
  const status = c.req.query("status");

  try {
    const result = await queryPhysicalTable(db, mc.id, siteId, {
      limit,
      offset,
      status: status ?? undefined,
    });
    return c.json({ data: result.data, meta: { total: result.total } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ errors: [{ code: "QUERY_FAILED", message }] }, 500);
  }
});

materializeRouter.delete("/:id", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const id = c.req.param("id");

  const [mc] = await db
    .select()
    .from(materializedCollections)
    .where(
      and(
        eq(materializedCollections.id, id),
        eq(materializedCollections.siteId, siteId),
      ),
    );

  if (mc) {
    const config: MaterializeConfig = {
      id: mc.id,
      siteId,
      collection: mc.collection,
      target: mc.target,
      refreshStrategy: mc.refreshStrategy,
      projection: mc.projection as { fields: string[]; orderBy?: string },
      filter: mc.filter as Record<string, unknown>,
    };

    // Remove trigger if exists
    try {
      await removeAutoRefreshTrigger(db, config);
    } catch {
      // Ignore — trigger may not exist
    }

    // Drop the physical table
    try {
      await dropPhysicalTable(db, config);
    } catch {
      // Log but continue with metadata cleanup
      console.warn(
        `[materialize] Failed to drop table for materialization ${mc.id}`,
      );
    }
  }

  // Delete metadata
  await db
    .delete(materializedCollections)
    .where(
      and(
        eq(materializedCollections.id, id),
        eq(materializedCollections.siteId, siteId),
      ),
    );
  return c.body(null, 204);
});
