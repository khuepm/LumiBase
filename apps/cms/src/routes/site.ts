import { sites } from '@lumibase/database';
import { SiteConfigUpdateSchema } from '@lumibase/shared/schemas';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';

/**
 * Site (tenant) configuration surface. Reads/writes the row in `sites` for the
 * active tenant resolved by `withTenant` (header `X-Lumi-Site`). Identity +
 * branding + theme live directly on the row; per-user appearance overrides
 * live in `users.preferences` and are resolved client-side.
 */
export const siteRouter = new Hono<AppEnv>();

siteRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  return c.json({ data: row });
});

siteRouter.patch('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const body = await c.req.json().catch(() => ({}));
  const parsed = SiteConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] },
      400,
    );
  }
  const patch = parsed.data;

  // Empty-string sentinels from the form mean "clear" → store NULL.
  const blankToNull = <T>(v: T | '' | undefined): T | null | undefined =>
    v === '' ? null : v;

  const [existing] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  // Build the SET payload from only the keys the caller supplied.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('name' in patch) set.name = patch.name;
  if ('displayTitle' in patch) set.displayTitle = blankToNull(patch.displayTitle);
  if ('siteUrl' in patch) set.siteUrl = blankToNull(patch.siteUrl);
  if ('descriptor' in patch) set.descriptor = blankToNull(patch.descriptor);
  if ('domain' in patch) set.domain = blankToNull(patch.domain);
  if ('defaultLanguage' in patch) set.defaultLanguage = patch.defaultLanguage;
  if ('defaultAppearance' in patch) set.defaultAppearance = patch.defaultAppearance;
  if ('defaultSaveAction' in patch) set.defaultSaveAction = patch.defaultSaveAction;
  if ('branding' in patch) set.branding = patch.branding;
  if ('themeOverrides' in patch) set.themeOverrides = patch.themeOverrides;
  if ('customCss' in patch) set.customCss = blankToNull(patch.customCss);

  let row: typeof existing | undefined;
  try {
    [row] = await db.update(sites).set(set).where(eq(sites.id, siteId)).returning();
  } catch (err) {
    // Postgres unique_violation on `sites.domain`.
    if (isUniqueViolation(err)) {
      return c.json(
        { errors: [{ code: 'DOMAIN_TAKEN', message: 'That domain is already in use.' }] },
        409,
      );
    }
    throw err;
  }

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  // If the domain changed, drop the stale subdomain→site cache entries so the
  // tenant middleware re-resolves. Cover both old and new first-label.
  if ('domain' in patch && existing.domain !== row.domain) {
    const cache = c.get('runtime')?.cache;
    if (cache) {
      const labels = [existing.domain, row.domain]
        .filter((d): d is string => Boolean(d))
        .map((d) => d.split('.')[0]);
      await Promise.all(labels.map((sub) => cache.delete(`site-domain:${sub}`)));
    }
  }

  return c.json({ data: row });
});

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Drizzle wraps
 * the driver error, so the original `code` lives on `err.cause` rather than the
 * top-level Error — check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (e: unknown): boolean =>
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === '23505';
  if (hasCode(err)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return hasCode(cause);
}
