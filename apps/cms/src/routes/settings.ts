import { settings, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { redactSettingRow } from '../services/settings-redaction';

export const settingsRouter = new Hono<AppEnv>();

// Writes go through the generic key/value store and can set ANY settings key
// (feature flags, `media.signedTransform`, `upload_policy`, …), so they must be
// admin-only for the active site — otherwise any authenticated member could
// change site config and bypass the admin gates on dedicated config endpoints
// (e.g. `PUT /uploads/config`). Reads stay open to members: non-admin editors
// legitimately read keys like `locales`. Secret-bearing fields in the value
// (e.g. `media.signedTransform.secret`) are redacted on read (see
// `services/settings-redaction.ts`).
settingsRouter.post('*', requireSiteAdmin());
settingsRouter.delete('*', requireSiteAdmin());

// Secret-bearing fields are redacted for every caller. The rule is shared with
// the `listSettings` agent skill (`services/settings-redaction.ts`, #579).
const redactRow = redactSettingRow;

settingsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const scope = c.req.query('scope');
  
  const q = db.select().from(settings).where(
    and(
      scopeSite(settings.siteId, siteId),
      scope ? eq(settings.scope, scope) : undefined
    )
  );
  const rows = await q;
  return c.json({ data: rows.map(redactRow) });
});

settingsRouter.get('/:key', async (c) => {
  const key = c.req.param('key');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.key, key), scopeSite(settings.siteId, siteId)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: redactRow(row) });
});

const settingSchema = z.object({
  key: z.string(),
  value: z.record(z.string(), z.unknown()),
  scope: z.string().optional(),
});

settingsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = settingSchema.parse(body);

  const [row] = await db
    .insert(settings)
    .values({
      siteId,
      key: input.key,
      value: input.value,
      scope: input.scope,
    })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: {
        value: input.value,
        scope: input.scope,
        updatedAt: new Date(),
      },
    })
    .returning();

  return c.json({ data: row });
});

settingsRouter.delete('/:key', async (c) => {
  const key = c.req.param('key');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(settings)
    .where(and(eq(settings.key, key), scopeSite(settings.siteId, siteId)))
    .returning({ id: settings.id });

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: null });
});
