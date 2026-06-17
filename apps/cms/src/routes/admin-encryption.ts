/**
 * Admin Encryption routes (regulated-content-readiness task 3.4; Req 3.5).
 *
 *   POST /api/v1/admin/encryption/keys/rotate   → promote a new active key
 *   GET  /api/v1/admin/encryption/keys           → list configured key metadata
 *
 * Mounted under `withAuth` at `/api/v1/admin/encryption`; the router enforces
 * an `admin`-role gate (mirroring `adminSecurityRouter`).
 *
 * Key *material* lives only in the runtime KeyProvider (Workers Secrets / env);
 * this surface records rotation *metadata* in `encryption_keys` and audits the
 * change. Rotation marks the previously-active key `retired` (decrypt-only) and
 * records the new active key id — the actual bytes must already be provisioned
 * via `ENCRYPTION_KEY_<id>` + `ENCRYPTION_ACTIVE_KEY_ID` before/with rotation.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { encryptionKeys, scopeSite } from '@lumibase/database';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';

export const adminEncryptionRouter = new Hono<AppEnv>();

const rotateSchema = z.object({
  /** The key version id to promote to active (e.g. `v1`). */
  keyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
});

function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
  }
  return null;
}

adminEncryptionRouter.get('/keys', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  // Prefer the runtime view (source of truth for material); fall back to the
  // metadata table for keys recorded via rotation.
  const runtime = c.get('runtime');
  const metas = await runtime.keys.listKeys();
  return c.json({ data: metas });
});

adminEncryptionRouter.post('/keys/rotate', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = rotateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const { keyId } = parsed.data;
  const db = c.get('db');
  const siteId = c.get('siteId');
  const runtime = c.get('runtime');

  // The target key must already be provisioned in the KeyProvider.
  try {
    await runtime.keys.getKey(keyId);
  } catch {
    return c.json(
      {
        errors: [
          {
            code: 'KEY_NOT_PROVISIONED',
            message: `Key '${keyId}' is not provisioned. Set ENCRYPTION_KEY_${keyId} and ENCRYPTION_ACTIVE_KEY_ID first.`,
          },
        ],
      },
      422,
    );
  }

  // Retire any currently-active key metadata for this site, then upsert the
  // new active key. Idempotent: re-rotating to the same key is a no-op.
  const now = new Date();
  await db
    .update(encryptionKeys)
    .set({ status: 'retired', retiredAt: now })
    .where(and(scopeSite(encryptionKeys.siteId, siteId), eq(encryptionKeys.status, 'active')));

  const [existing] = await db
    .select()
    .from(encryptionKeys)
    .where(and(scopeSite(encryptionKeys.siteId, siteId), eq(encryptionKeys.keyId, keyId)))
    .limit(1);

  if (existing) {
    await db
      .update(encryptionKeys)
      .set({ status: 'active', retiredAt: null })
      .where(eq(encryptionKeys.id, existing.id));
  } else {
    await db.insert(encryptionKeys).values({ siteId, keyId, status: 'active', algo: 'AES-GCM' });
  }

  const auth = c.get('auth');
  await new AuditLogger({ db, siteId }).write({
    event: 'encryption_key_rotated',
    actorEmail: typeof auth?.email === 'string' ? auth.email : null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: null,
    metadata: { siteId, activeKeyId: keyId },
  });

  return c.json({ data: { activeKeyId: keyId, rotatedAt: now.toISOString() } });
});
