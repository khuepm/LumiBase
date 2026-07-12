/**
 * Admin routes — Phase G hardening.
 *
 * GET  /api/v1/admin/backup  — Export all site configuration as an NDJSON bundle.
 * POST /api/v1/admin/restore — Import a bundle and apply in a transaction.
 *
 * The bundle format is Newline-Delimited JSON (NDJSON). Each line is:
 *   { "type": "<resource>", "data": <object> }
 *
 * Supported resource types:
 *   settings | collections | fields | relations | webhooks | roles |
 *   policies | role_policies | permissions | presets | translations
 *
 * Security: admin-only. This router requires both an admin principal role and
 * site-bound adminAccess before reading or mutating backup resources.
 */

import {
  collections,
  fields,
  permissions,
  policies,
  presets,
  relations,
  rolePolicies,
  roles,
  settings,
  translations,
  webhooks,
  sites,
  users,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { stream } from 'hono/streaming';
import type { AppEnv } from '../env';
import { reconcileOfficialExtensions } from '../services/official-extension-reconciler';
import { PermissionService } from '../services/permission-service';
import type { MagicContext } from '../services/permission-dsl';

export const adminRouter = new Hono<AppEnv>();

const errorBody = (code: string, message: string) => ({
  errors: [{ code, message }],
});

function collectRequestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

async function resolveAuthUserId(c: Context<AppEnv>): Promise<string | null> {
  const auth = c.get('auth');
  if (auth?.userId) return auth.userId;
  if (!auth?.externalId) return null;

  const [row] = await c
    .get('db')
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalId, auth.externalId))
    .limit(1);
  return row?.id ?? null;
}

async function hasSiteAdminAccess(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.get('auth');
  const siteId = c.get('siteId');
  const userId = await resolveAuthUserId(c);
  if (!siteId || !userId) return false;

  const ctx: MagicContext = {
    userId,
    siteId,
    roleId: null,
    user: auth
      ? {
          id: userId,
          email: auth.email ?? null,
          roles: auth.roles ?? [],
          ...(auth.raw ?? {}),
        }
      : null,
    ip:
      c.get('ip') ??
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for') ??
      null,
    headers: collectRequestHeaders(c),
    apiKey: auth?.apiKey ?? null,
  };

  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime')?.cache,
    ctx,
  }).bundle();

  return bundle.admin;
}

const requireSiteAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  const authRoles = Array.isArray(auth?.roles) ? auth.roles : [];
  if (!authRoles.includes('admin')) {
    return c.json(errorBody('FORBIDDEN', 'Admin role required.'), 403);
  }
  if (!c.get('siteId')) {
    return c.json(
      errorBody('TENANT_REQUIRED', 'X-Lumi-Site header is required.'),
      400,
    );
  }
  if (!(await hasSiteAdminAccess(c))) {
    return c.json(
      errorBody(
        'FORBIDDEN',
        'Admin access for the requested site is required.',
      ),
      403,
    );
  }
  return next();
};

class RestoreValidationError extends Error {}

adminRouter.use('*', requireSiteAdmin);

// ---------------------------------------------------------------------------
// GET /api/v1/admin/backup
// Export all site configuration as an NDJSON bundle.
// ---------------------------------------------------------------------------
adminRouter.get('/backup', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [
    settingsRows,
    collectionsRows,
    fieldsRows,
    relationsRows,
    webhooksRows,
    rolesRows,
    policiesRows,
    rolePoliciesRows,
    permissionsRows,
    presetsRows,
    translationsRows,
  ] = await Promise.all([
    db.select().from(settings).where(eq(settings.siteId, siteId)),
    db.select().from(collections).where(eq(collections.siteId, siteId)),
    db.select().from(fields).where(eq(fields.siteId, siteId)),
    db.select().from(relations).where(eq(relations.siteId, siteId)),
    db.select().from(webhooks).where(eq(webhooks.siteId, siteId)),
    db.select().from(roles).where(eq(roles.siteId, siteId)),
    db.select().from(policies).where(eq(policies.siteId, siteId)),
    db
      .select({
        roleId: rolePolicies.roleId,
        policyId: rolePolicies.policyId,
        priority: rolePolicies.priority,
      })
      .from(rolePolicies)
      .innerJoin(roles, eq(roles.id, rolePolicies.roleId))
      .innerJoin(policies, eq(policies.id, rolePolicies.policyId))
      .where(and(eq(roles.siteId, siteId), eq(policies.siteId, siteId))),
    db.select().from(permissions).where(eq(permissions.siteId, siteId)),
    db.select().from(presets).where(eq(presets.siteId, siteId)),
    db.select().from(translations).where(eq(translations.siteId, siteId)),
  ]);

  const resources: Array<{ type: string; data: unknown[] }> = [
    { type: 'settings', data: settingsRows },
    { type: 'collections', data: collectionsRows },
    { type: 'fields', data: fieldsRows },
    { type: 'relations', data: relationsRows },
    { type: 'webhooks', data: webhooksRows },
    { type: 'roles', data: rolesRows },
    { type: 'policies', data: policiesRows },
    { type: 'role_policies', data: rolePoliciesRows },
    { type: 'permissions', data: permissionsRows },
    { type: 'presets', data: presetsRows },
    { type: 'translations', data: translationsRows },
  ];

  // NDJSON: one JSON object per line.
  const ndjsonLines: string[] = [
    JSON.stringify({
      type: '__meta__',
      data: {
        siteId,
        exportedAt: new Date().toISOString(),
        version: '1',
        resources: resources.map((r) => ({
          type: r.type,
          count: r.data.length,
        })),
      },
    }),
  ];

  for (const { type, data } of resources) {
    for (const row of data) {
      ndjsonLines.push(JSON.stringify({ type, data: row }));
    }
  }

  const filename = `lumibase-backup-${siteId}-${new Date().toISOString().slice(0, 10)}.ndjson`;

  return stream(c, async (s) => {
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    for (const line of ndjsonLines) {
      await s.write(line + '\n');
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/restore
// Upload an NDJSON bundle and apply in a transaction.
// Body: raw NDJSON text (Content-Type: application/x-ndjson or text/plain).
// Existing rows are skipped (onConflictDoNothing) — idempotent by design.
// ---------------------------------------------------------------------------
adminRouter.post('/restore', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const body = await c.req.text();
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Empty bundle.' }] },
      400,
    );
  }

  type BundleRecord = { type: string; data: Record<string, unknown> };
  const records: BundleRecord[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as BundleRecord;
      if (parsed.type !== '__meta__') records.push(parsed);
    } catch {
      return c.json(
        {
          errors: [
            {
              code: 'VALIDATION',
              message: `Invalid NDJSON: ${line.slice(0, 80)}`,
            },
          ],
        },
        400,
      );
    }
  }

  let restored = 0;

  try {
    await db.transaction(async (tx) => {
      for (const { type, data } of records) {
        // Stamp current siteId on every row for safety.
        const row = { ...data, siteId } as Record<string, unknown>;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const upsert = (table: any, values: unknown) =>
          tx
            .insert(table)
            .values(values as never)
            .onConflictDoNothing();

        switch (type) {
          case 'settings':
            await tx
              .insert(settings)
              .values(row as never)
              .onConflictDoUpdate({
                target: [settings.siteId, settings.key],
                set: { value: row['value'] as never },
              });
            break;
          case 'collections':
            await upsert(collections, row);
            break;
          case 'fields':
            await upsert(fields, row);
            break;
          case 'relations':
            await upsert(relations, row);
            break;
          case 'webhooks':
            await upsert(webhooks, row);
            break;
          case 'roles':
            await upsert(roles, row);
            break;
          case 'policies':
            await upsert(policies, row);
            break;
          case 'role_policies': {
            // Junction table has no siteId, so validate both ends belong to the
            // active site before accepting a restored binding.
            const roleId =
              typeof data['roleId'] === 'string' ? data['roleId'] : null;
            const policyId =
              typeof data['policyId'] === 'string' ? data['policyId'] : null;
            if (!roleId || !policyId) {
              throw new RestoreValidationError('Invalid role_policies row.');
            }

            const [binding] = await tx
              .select({ roleId: roles.id, policyId: policies.id })
              .from(roles)
              .innerJoin(policies, eq(policies.id, policyId))
              .where(
                and(
                  eq(roles.id, roleId),
                  eq(roles.siteId, siteId),
                  eq(policies.siteId, siteId),
                ),
              )
              .limit(1);
            if (!binding) {
              throw new RestoreValidationError(
                'role_policies row is outside the selected site.',
              );
            }

            await upsert(rolePolicies, {
              roleId,
              policyId,
              priority: data['priority'],
            });
            break;
          }
          case 'permissions':
            await upsert(permissions, row);
            break;
          case 'presets':
            await upsert(presets, row);
            break;
          case 'translations':
            await upsert(translations, row);
            break;
          default:
            // Unknown type — skip gracefully.
            break;
        }
        restored++;
      }
    });
  } catch (err) {
    if (err instanceof RestoreValidationError) {
      return c.json(errorBody('VALIDATION', err.message), 400);
    }
    throw err;
  }

  return c.json({
    data: { restored, siteId, restoredAt: new Date().toISOString() },
  });
});

// ---------------------------------------------------------------------------
// site management for test runner / testing isolation
// ---------------------------------------------------------------------------
adminRouter.post('/sites', async (c) => {
  const db = c.get('db');
  const body = await c.req.json();
  const [row] = await db
    .insert(sites)
    .values({ id: body.id, name: body.name })
    .returning();

  // Auto-install official `lumibase-*` extensions for the new site. Fail-soft:
  // never throws, skips when no published/verified source row exists yet.
  if (row) {
    await reconcileOfficialExtensions(db, c.env, row.id).catch(() => undefined);
  }

  return c.json({ data: row }, 201);
});

adminRouter.delete('/sites/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  await db.delete(sites).where(eq(sites.id, id));
  return c.json({ data: { success: true } });
});
