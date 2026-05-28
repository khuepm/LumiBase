import { scimTokens } from '@lumibase/database';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

export const scimAdminRouter = new Hono<AppEnv>();

function generateToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return 'scim_' + Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const createTokenSchema = z.object({
  label: z.string().min(1),
  lifespanDays: z.number().int().min(1).max(365).optional().default(90),
});

// Create token (generate new)
scimAdminRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const body = await c.req.json();
  const input = createTokenSchema.parse(body);

  const rawToken = generateToken();
  const tokenHash = await sha256(rawToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + input.lifespanDays);

  const [row] = await db
    .insert(scimTokens)
    .values({
      siteId,
      tokenHash,
      label: input.label,
      createdBy: auth?.userId ?? 'unknown',
      expiresAt,
    })
    .returning();

  return c.json({
    data: {
      id: row!.id,
      label: row!.label,
      createdBy: row!.createdBy,
      expiresAt: row!.expiresAt?.toISOString(),
      createdAt: row!.createdAt.toISOString(),
      token: rawToken, // Returned once in plaintext
    },
  }, 201);
});

// List tokens (masked metadata)
scimAdminRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const rows = await db
    .select()
    .from(scimTokens)
    .where(and(eq(scimTokens.siteId, siteId), isNull(scimTokens.revokedAt)));

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdBy: r.createdBy,
      expiresAt: r.expiresAt?.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// Revoke token
scimAdminRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .update(scimTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(scimTokens.id, id), eq(scimTokens.siteId, siteId)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Token not found' }] }, 404);
  }

  return c.json({ data: { success: true } });
});

// Rotate token (create new + revoke old with 24h grace)
scimAdminRouter.post('/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');

  // Verify old token exists and is active
  const [oldToken] = await db
    .select()
    .from(scimTokens)
    .where(and(eq(scimTokens.id, id), eq(scimTokens.siteId, siteId), isNull(scimTokens.revokedAt)))
    .limit(1);

  if (!oldToken) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Active token not found' }] }, 404);
  }

  // Generate new token
  const rawToken = generateToken();
  const tokenHash = await sha256(rawToken);

  // Set 24 hour grace period for old token
  const gracePeriod = new Date();
  gracePeriod.setHours(gracePeriod.getHours() + 24);

  await db
    .update(scimTokens)
    .set({ expiresAt: gracePeriod }) // Expire in 24 hours
    .where(eq(scimTokens.id, id));

  // Insert new token
  const defaultLifespan = 90;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + defaultLifespan);

  const [newToken] = await db
    .insert(scimTokens)
    .values({
      siteId,
      tokenHash,
      label: `${oldToken.label} (rotated)`,
      createdBy: auth?.userId ?? 'unknown',
      expiresAt,
    })
    .returning();

  return c.json({
    data: {
      id: newToken!.id,
      label: newToken!.label,
      createdBy: newToken!.createdBy,
      expiresAt: newToken!.expiresAt?.toISOString(),
      createdAt: newToken!.createdAt.toISOString(),
      token: rawToken, // Returned once in plaintext
      oldTokenGraceExpiresAt: gracePeriod.toISOString(),
    },
  });
});
