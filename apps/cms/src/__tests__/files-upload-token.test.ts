import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

import type { StorageProvider } from '@lumibase/runtime';

import type { AppEnv } from '../env';
import { MemoryUploadClaims } from '../services/files/__tests__/memory-upload-claims';

const claimsState = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../services/files/upload-claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/files/upload-claims')>();
  return { ...actual, uploadClaimsFor: () => claimsState.store };
});
vi.mock('../middleware/db', () => ({ systemDbFor: () => ({}) }));

const { filesRouter } = await import('../routes/files');

const JWT_SECRET = 'test-upload-secret';
const encoder = new TextEncoder();

type StoredWrite = {
  key: string;
  body: string;
  metadata?: Record<string, string>;
};

async function signUploadPayload(payload: Record<string, unknown>, secret = JWT_SECRET): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(encoder.encode(secret));
}

function buildApp(writes: StoredWrite[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const storage: StorageProvider = {
    put: async (key, data, metadata) => {
      const body = await new Response(data as BodyInit).text();
      writes.push({ key, body, metadata });
    },
    get: async () => null,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  };

  app.use('*', async (c, next) => {
    c.set('runtime', { storage } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/files', filesRouter);
  return app;
}

describe('files upload token validation', () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  let claims: MemoryUploadClaims;
  beforeEach(() => {
    delete process.env.JWT_SECRET;
    claims = new MemoryUploadClaims();
    claimsState.store = claims;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it('does not accept tokens signed with the public development fallback secret when JWT_SECRET is missing', async () => {
    const writes: StoredWrite[] = [];
    const app = buildApp(writes);
    const token = await signUploadPayload({ key: 'owned.txt' }, 'dev_secret_key');

    const response = await app.request(
      `/files/upload/owned.txt?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        body: 'ATTACKER_CONTROLLED_BYTES',
      },
      {},
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }],
    });
    expect(writes).toEqual([]);
  });

  it('rejects signed upload tokens that omit the required siteId claim', async () => {
    const writes: StoredWrite[] = [];
    const app = buildApp(writes);
    const token = await signUploadPayload({ key: 'owned.txt' });

    const response = await app.request(
      `/files/upload/owned.txt?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        body: 'ATTACKER_CONTROLLED_BYTES',
      },
      { JWT_SECRET },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      errors: [{ code: 'UNAUTHORIZED', message: 'Expired or invalid upload token.' }],
    });
    expect(writes).toEqual([]);
  });

  it('accepts a valid signed upload token without relying on tenant context for the upload request', async () => {
    const writes: StoredWrite[] = [];
    const app = buildApp(writes);
    const key = 'sites/site-1/files/asset.txt';
    const token = await signUploadPayload({ key, siteId: 'site-1' });
    await claims.issue('site-1', key, 'user:u1');

    const response = await app.request(
      `/files/upload/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'LEGITIMATE_UPLOAD',
      },
      { JWT_SECRET },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { success: true, key } });
    expect(writes).toEqual([
      {
        key,
        body: 'LEGITIMATE_UPLOAD',
        metadata: { 'content-type': 'text/plain' },
      },
    ]);
  });

  it.each([
    ['an unscoped key', 'owned.txt'],
    ['another site’s namespace', 'sites/site-2/files/owned.txt'],
    ['another site’s media', 'sites/site-2/media/logo.png'],
  ])('refuses a validly signed token for %s (#993)', async (_label, key) => {
    const writes: StoredWrite[] = [];
    const app = buildApp(writes);
    const token = await signUploadPayload({ key, siteId: 'site-1' });
    const response = await app.request(
      `/files/upload/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`,
      { method: 'PUT', body: 'BYTES' },
      { JWT_SECRET },
    );
    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });
  it('refuses a valid token whose key has no claim (#993)', async () => {
    const writes: StoredWrite[] = [];
    const key = 'sites/site-1/files/unclaimed.txt';
    const token = await signUploadPayload({ key, siteId: 'site-1' });
    const response = await buildApp(writes).request(
      `/files/upload/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`,
      { method: 'PUT', body: 'X' },
      { JWT_SECRET },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('UPLOAD_CLAIM_MISSING');
    expect(writes).toEqual([]);
  });

  it('refuses a replayed PUT once the key is registered (#993)', async () => {
    const writes: StoredWrite[] = [];
    const key = 'sites/site-1/files/registered.txt';
    const token = await signUploadPayload({ key, siteId: 'site-1' });
    claims.seedUploaded('site-1', key, 'user:u1');
    expect(await claims.register('site-1', key, 'user:u1')).toBe('ok');
    const response = await buildApp(writes).request(
      `/files/upload/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`,
      { method: 'PUT', body: 'REPLACED' },
      { JWT_SECRET },
    );
    expect(response.status).toBe(409);
    expect(writes).toEqual([]);
  });
});
