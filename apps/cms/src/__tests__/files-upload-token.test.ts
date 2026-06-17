import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

import type { StorageProvider } from '@lumibase/runtime';

import type { AppEnv } from '../env';
import { filesRouter } from '../routes/files';

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

  beforeEach(() => {
    delete process.env.JWT_SECRET;
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
    const token = await signUploadPayload({ key: 'asset.txt', siteId: 'site-1' });

    const response = await app.request(
      `/files/upload/asset.txt?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'LEGITIMATE_UPLOAD',
      },
      { JWT_SECRET },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { success: true, key: 'asset.txt' } });
    expect(writes).toEqual([
      {
        key: 'asset.txt',
        body: 'LEGITIMATE_UPLOAD',
        metadata: { 'content-type': 'text/plain' },
      },
    ]);
  });
});
