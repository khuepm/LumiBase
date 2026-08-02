import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { withAuth } from '../auth';
import { ALLOWED_ORIGINS_METADATA_KEY } from '../../services/api-key-publishable';
import { createPlaintextToken } from '../../services/api-key-token';

/**
 * Origin enforcement for publishable API keys.
 *
 * The control's purpose is narrow and worth pinning precisely: it stops another
 * *website* from using an embedded key in a browser. It is not confidentiality
 * (the key is public by construction) and it must not break non-browser
 * callers, which send no `Origin` at all.
 */

interface KeyRow {
  prefix: string;
  metadata: Record<string, unknown>;
}

function makeFakeDb(key: KeyRow & { tokenHash: string }): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () =>
      Promise.resolve([
        {
          id: 'key_1',
          siteId: 'site_1',
          name: 'Web app',
          description: null,
          prefix: key.prefix,
          tokenHash: key.tokenHash,
          createdBy: null,
          rotatedAt: null,
          rotatedBy: null,
          expiresAt: null,
          revokedAt: null,
          revokedBy: null,
          lastUsedAt: new Date(),
          lastUsedIp: null,
          lastUsedUserAgent: null,
          metadata: key.metadata,
          createdAt: new Date(),
        },
      ]),
  };

  return {
    select: () => fluent,
    // `auditApiKeyUseDenied` writes through the AuditLogger on the deny path.
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(undefined),
        returning: () => Promise.resolve([]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  } as unknown as Database;
}

async function requestWith(opts: {
  publishable: boolean;
  allowedOrigins?: string[];
  headers?: Record<string, string>;
}): Promise<Response> {
  const token = await createPlaintextToken({ publishable: opts.publishable });
  const metadata: Record<string, unknown> = {};
  if (opts.allowedOrigins) metadata[ALLOWED_ORIGINS_METADATA_KEY] = opts.allowedOrigins;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeFakeDb({ prefix: token.prefix, metadata, tokenHash: token.tokenHash }));
    c.set('siteId', 'site_1');
    c.set('runtime', { cache: undefined } as never);
    await next();
  });
  app.use('*', withAuth());
  app.get('*', (c) => c.json({ auth: c.get('auth') }));

  return app.request(
    '/api/v1/items/articles',
    { headers: { authorization: `Bearer ${token.token}`, ...(opts.headers ?? {}) } },
    {},
  );
}

describe('publishable key origin allowlist', () => {
  it('accepts a matching Origin', async () => {
    const res = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a non-matching Origin', async () => {
    const res = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
      headers: { origin: 'https://evil.test' },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      errors: [{ code: 'ORIGIN_NOT_ALLOWED' }],
    });
  });

  it('falls back to Referer when Origin is absent', async () => {
    const denied = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
      headers: { referer: 'https://evil.test/page' },
    });
    expect(denied.status).toBe(403);

    const allowed = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
      headers: { referer: 'https://app.example.com/page' },
    });
    expect(allowed.status).toBe(200);
  });

  it('allows a caller that sends no origin at all', async () => {
    // A native/server caller. Rejecting would break it while adding no
    // security, since such a client can set any Origin value it likes.
    const res = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
    });
    expect(res.status).toBe(200);
  });

  it('imposes no constraint when the allowlist is empty', async () => {
    const res = await requestWith({
      publishable: true,
      headers: { origin: 'https://anywhere.test' },
    });
    expect(res.status).toBe(200);
  });

  it('does not apply the allowlist to a secret key', async () => {
    // Secret keys are used server-to-server where no Origin exists; applying
    // the check there would reject every caller.
    const res = await requestWith({
      publishable: false,
      allowedOrigins: ['https://app.example.com'],
      headers: { origin: 'https://evil.test' },
    });
    expect(res.status).toBe(200);
  });

  it('resolves an allowed publishable key to an api_key principal', async () => {
    const res = await requestWith({
      publishable: true,
      allowedOrigins: ['https://app.example.com'],
      headers: { origin: 'https://app.example.com' },
    });
    await expect(res.json()).resolves.toMatchObject({
      auth: { type: 'api_key', apiKeyId: 'key_1' },
    });
  });
});
