/**
 * Materialized collections routes — POST-GA6.
 *
 *   GET    /api/v1/materialize             list materializations
 *   POST   /api/v1/materialize             register a materialization
 *   POST   /api/v1/materialize/:id/refresh refresh now (manual)
 *   DELETE /api/v1/materialize/:id         drop materialization
 *
 * The refresh strategy in this scaffold is a "logical refresh": we update
 * the row_count + lastRefreshedAt timestamp by counting source items.
 * A full implementation would write to a dedicated denormalized table; the
 * schema, API surface and run book are in place for that work.
 */

import {
  collections,
  items,
  materializedCollections,
} from "@lumibase/database";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";

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
  const inserted = await db
    .insert(materializedCollections)
    .values({ siteId, ...parsed.data })
    .returning();
  return c.json({ data: inserted[0] }, 201);
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
    // Resolve source collection id by name.
    const [coll] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          eq(collections.siteId, siteId),
          eq(collections.name, mc.collection),
        ),
      );

    if (!coll) {
      throw new Error(`Source collection ${mc.collection} not found`);
    }

    const rowCountResult = await db
      .select({ rowCount: count() })
      .from(items)
      .where(and(eq(items.siteId, siteId), eq(items.collectionId, coll.id)));
    const { rowCount } = rowCountResult[0] as { rowCount: number };

    await db
      .update(materializedCollections)
      .set({
        status: "idle",
        rowCount: rowCount ?? 0,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(materializedCollections.id, id));

    return c.json({
      data: {
        id,
        rowCount: rowCount ?? 0,
        lastRefreshedAt: new Date().toISOString(),
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

materializeRouter.delete("/:id", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");
  const id = c.req.param("id");
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
