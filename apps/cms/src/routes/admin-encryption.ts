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
import { encryptionKeys, scopeSite, users } from '@lumibase/database';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { runRewrap } from '../services/rewrap-worker';
import { verifyPassword } from '../services/auth/password';
import {
  readEnvelopeSetting,
  writeEnvelopeSetting,
} from '../services/crypto/envelope-settings';
import {
  ENVELOPE_MIGRATION_QUEUE,
  runEnvelopeMigration,
} from '../services/envelope-migration-worker';

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

/**
 * Re-encrypt ciphertext from retired key versions onto the active key
 * (Req 3.6). Optional, idempotent, resumable; runs a bounded set of batches
 * per call so large datasets can be drained across multiple invocations.
 */
adminEncryptionRouter.post('/keys/rewrap', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const runtime = c.get('runtime');
  const result = await runRewrap(
    { db: c.get('db'), siteId: c.get('siteId'), keyProvider: runtime.keys },
    { batchSize: 100, maxBatches: 50 },
  );
  return c.json({ data: result });
});

/**
 * Re-verify the acting admin's password (step-up auth) for a sensitive change.
 * Returns null on success, or a JSON error response to short-circuit.
 */
async function stepUp(c: Context<AppEnv>, password: string) {
  const db = c.get('db');
  const auth = c.get('auth');
  const userId = typeof auth?.userId === 'string' ? auth.userId : null;
  if (!userId) {
    return c.json({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'A user session is required.' }] }, 401);
  }
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
  if (!ok) {
    return c.json({ errors: [{ code: 'INVALID_CREDENTIALS', message: 'Password verification failed.' }] }, 401);
  }
  return null;
}

const envelopeSchema = z.object({
  enabled: z.boolean(),
  /** Step-up: the acting admin re-enters their password to confirm. */
  password: z.string().min(1),
});

/** Current envelope mode + migration progress for this site. */
adminEncryptionRouter.get('/envelope', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const setting = await readEnvelopeSetting(c.get('db'), c.get('siteId'));
  return c.json({ data: setting });
});

/**
 * Toggle envelope (per-record DEK) mode for the site (Req 4.5). Requires
 * step-up auth. On change, records a background migration to the target mode
 * and kicks it: enqueued to the runtime queue when available (Docker/CF), with
 * a bounded inline drain so small datasets finish immediately. Audited.
 */
adminEncryptionRouter.post('/envelope', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] }, 400);
  }
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const stepUpError = await stepUp(c, parsed.data.password);
  if (stepUpError) return stepUpError;

  const db = c.get('db');
  const siteId = c.get('siteId');
  const runtime = c.get('runtime');
  const { enabled } = parsed.data;

  const current = await readEnvelopeSetting(db, siteId);
  // No-op when the mode is unchanged and no migration is mid-flight.
  if (current.enabled === enabled && current.migration.status !== 'running') {
    return c.json({ data: current });
  }

  const direction = enabled ? 'to_envelope' : 'to_shared';
  const now = new Date().toISOString();
  await writeEnvelopeSetting(db, siteId, {
    enabled,
    migration: { direction, status: 'running', cursor: null, processed: 0, startedAt: now, updatedAt: now },
  });

  const auth = c.get('auth');
  await new AuditLogger({ db, siteId }).write({
    event: 'envelope_mode_changed',
    actorEmail: typeof auth?.email === 'string' ? auth.email : null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: null,
    metadata: { siteId, enabled, direction },
  });

  // Hand the long tail to the background queue (best-effort), then drain a
  // bounded set of batches inline so small sites complete synchronously.
  try {
    await runtime.queue?.enqueue(ENVELOPE_MIGRATION_QUEUE, 'migrate', { siteId });
  } catch {
    // Queue is best-effort; the inline drain + resumable cursor cover the rest.
  }
  const result = await runEnvelopeMigration(
    { db, siteId, keyProvider: runtime.keys },
    { batchSize: 100, maxBatches: 25 },
  );

  const setting = await readEnvelopeSetting(db, siteId);
  return c.json({ data: { setting, migration: result } });
});

/**
 * Drain more migration batches (resumable). For large datasets a scheduler or
 * the operator can poll this until `done`.
 */
adminEncryptionRouter.post('/envelope/migrate', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const runtime = c.get('runtime');
  const result = await runEnvelopeMigration(
    { db: c.get('db'), siteId: c.get('siteId'), keyProvider: runtime.keys },
    { batchSize: 100, maxBatches: 50 },
  );
  return c.json({ data: result });
});
