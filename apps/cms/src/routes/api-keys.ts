import { apiKeys, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthPrincipal } from '../env';

export const apiKeysRouter = new Hono<AppEnv>();

const createApiKey = z.object({
  name: z.string().min(1).max(96),
  description: z.string().max(512).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const rotateApiKey = z.object({
  expiresAt: z.coerce.date().nullable().optional(),
});

function publicApiKey(row: typeof apiKeys.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    createdBy: row.createdBy,
    rotatedAt: row.rotatedAt,
    rotatedBy: row.rotatedBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    lastUsedUserAgent: row.lastUsedUserAgent,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function requireUserPrincipal(c: Context<AppEnv>): (AuthPrincipal & { userId: string }) | null {
  const auth = c.get('auth');
  if (auth?.type === 'api_key' || !auth?.userId) {
    return null;
  }
  return auth as AuthPrincipal & { userId: string };
}

async function createPlaintextToken(): Promise<{ token: string; prefix: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = base64Url(bytes);
  const token = `lbk_${secret}`;
  return {
    token,
    prefix: token.slice(0, 16),
    tokenHash: await sha256Hex(token),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

apiKeysRouter.use('*', async (c, next) => {
  if (!requireUserPrincipal(c)) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }
  return next();
});

apiKeysRouter.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(scopeSite(apiKeys.siteId, c.get('siteId')));
  return c.json({ data: rows.map(publicApiKey) });
});

apiKeysRouter.post('/', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = createApiKey.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const token = await createPlaintextToken();
  const [row] = await c
    .get('db')
    .insert(apiKeys)
    .values({
      siteId: c.get('siteId'),
      name: parsed.data.name,
      description: parsed.data.description,
      prefix: token.prefix,
      tokenHash: token.tokenHash,
      createdBy: auth.userId,
      expiresAt: parsed.data.expiresAt ?? null,
      metadata: parsed.data.metadata ?? {},
    })
    .returning();

  if (!row) return c.json({ errors: [{ code: 'CREATE_FAILED', message: 'Failed to create API key.' }] }, 500);
  return c.json({ data: { ...publicApiKey(row), token: token.token } }, 201);
});

apiKeysRouter.get('/:id', async (c) => {
  const [row] = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  return c.json({ data: publicApiKey(row) });
});

apiKeysRouter.post('/:id/rotate', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = rotateApiKey.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const token = await createPlaintextToken();
  const nextExpiresAt = Object.prototype.hasOwnProperty.call(parsed.data, 'expiresAt')
    ? parsed.data.expiresAt ?? null
    : undefined;
  const [row] = await c
    .get('db')
    .update(apiKeys)
    .set({
      prefix: token.prefix,
      tokenHash: token.tokenHash,
      rotatedAt: new Date(),
      rotatedBy: auth.userId,
      revokedAt: null,
      revokedBy: null,
      expiresAt: nextExpiresAt,
    })
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  return c.json({ data: { ...publicApiKey(row), token: token.token } });
});

apiKeysRouter.post('/:id/revoke', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const [row] = await c
    .get('db')
    .update(apiKeys)
    .set({
      revokedAt: new Date(),
      revokedBy: auth.userId,
    })
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  return c.json({ data: publicApiKey(row) });
});
