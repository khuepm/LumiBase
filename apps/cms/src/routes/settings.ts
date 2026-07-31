import { settings, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';

export const settingsRouter = new Hono<AppEnv>();

// Writes go through the generic key/value store and can set ANY settings key
// (feature flags, `media.signedTransform`, `upload_policy`, …), so they must be
// admin-only for the active site — otherwise any authenticated member could
// change site config and bypass the admin gates on dedicated config endpoints
// (e.g. `PUT /uploads/config`). Reads stay open to members: non-admin editors
// legitimately read keys like `locales`. Secret-bearing fields in the value
// (e.g. `media.signedTransform.secret`) are redacted on read (see
// `redactSecrets` below).
settingsRouter.post('*', requireSiteAdmin());
settingsRouter.delete('*', requireSiteAdmin());

// Field names whose values are secrets and must never be returned by the read
// API. Server-side consumers that need the real value read it directly from the
// DB (e.g. `media.ts` `loadSignedTransformPolicy`), so the HTTP read path never
// needs to return a secret to anyone -- redact for every caller.
const SECRET_TOKENS = ['secret', 'token', 'password', 'passwd', 'apikey', 'privatekey', 'accesskey', 'credential', 'passphrase'];
const REDACTED = '[redacted]';

function isSecretField(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_TOKENS.some((t) => norm.includes(t));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretField(k) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function redactRow<T extends { value: unknown }>(row: T): T {
  return { ...row, value: redactSecrets(row.value) };
}

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
