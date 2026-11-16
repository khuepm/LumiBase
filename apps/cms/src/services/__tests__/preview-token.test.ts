import {
  buildPreviewUrl,
  PreviewOriginSchema,
  PreviewTokenMintSchema,
  previewTemplateOrigin,
  validatePreviewUrlTemplate,
} from '@lumibase/contracts';
import fc from 'fast-check';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  derivePreviewSiteKey,
  hashPreviewToken,
  previewSigningSecret,
  signPreviewToken,
  verifyPreviewToken,
} from '../preview-service';

/**
 * Preview token crypto + URL contracts (epic #667, V01 #679 / V05 #683).
 * Pure — no database. The end-to-end behaviour (rows, revocation, overlay)
 * is in `routes/__tests__/preview.db.integration.test.ts`.
 */

const SECRET = 'unit-test-secret';
const target = { collection: 'posts', itemId: 'itm_1', versionKey: null, releaseId: null, locale: 'en' };
const inOneHour = () => new Date(Date.now() + 3600_000);

async function sign(siteId = 'site_a', expiresAt = inOneHour()) {
  return signPreviewToken({ secret: SECRET, siteId, userId: 'usr_1', jti: 'prv_1', expiresAt, target });
}

describe('preview token signing', () => {
  it('round-trips the claims for the same site', async () => {
    const token = await sign();
    const result = await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({ ...target, siteId: 'site_a', userId: 'usr_1', jti: 'prv_1' });
  });

  it('fails the signature on another site (per-site key)', async () => {
    const token = await sign('site_a');
    const result = await verifyPreviewToken({ secret: SECRET, siteId: 'site_b', token });
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('derives distinct keys per site and per secret', async () => {
    const hex = async (s: string, site: string) => Buffer.from(await derivePreviewSiteKey(s, site)).toString('hex');
    expect(await hex(SECRET, 'a')).not.toBe(await hex(SECRET, 'b'));
    expect(await hex(SECRET, 'a')).not.toBe(await hex('other', 'a'));
    expect(await hex(SECRET, 'a')).toBe(await hex(SECRET, 'a'));
  });

  it('rejects expired tokens with the creator for auditing', async () => {
    const token = await sign('site_a', new Date(Date.now() - 1000));
    const result = await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token });
    expect(result).toEqual({ ok: false, reason: 'expired', userId: 'usr_1' });
  });

  it('rejects a token signed with the site key but for another audience', async () => {
    const key = await derivePreviewSiteKey(SECRET, 'site_a');
    const token = await new SignJWT({ col: 'posts', item: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('lumibase')
      .setAudience('lumibase-preview:site_b')
      .setSubject('usr_1')
      .setJti('j')
      .setExpirationTime('1h')
      .sign(key);
    expect((await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token })).ok).toBe(false);
  });

  it('rejects alg=none and tampered payloads', async () => {
    const token = await sign();
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.`;
    expect((await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token: none })).ok).toBe(false);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, item: 'itm_other' })).toString('base64url');
    expect((await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token: `${header}.${forged}.${signature}` })).ok).toBe(false);
  });

  it('never throws on arbitrary input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 5000 }), async (token) => {
        const result = await verifyPreviewToken({ secret: SECRET, siteId: 'site_a', token });
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('hashes tokens to 64 hex characters', async () => {
    expect(await hashPreviewToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to sign in production without JWT_SECRET', () => {
    expect(previewSigningSecret({ JWT_SECRET: 's' })).toBe('s');
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(previewSigningSecret({ NODE_ENV: 'production' })).toBeNull();
      expect(previewSigningSecret({ NODE_ENV: 'development' })).toBeTruthy();
    } finally {
      if (saved !== undefined) process.env.JWT_SECRET = saved;
    }
  });
});

describe('preview URL templates', () => {
  it('accepts http(s) templates with known placeholders', () => {
    expect(validatePreviewUrlTemplate('https://site.example/api/preview?token={token}&slug={slug}')).toBeNull();
    expect(validatePreviewUrlTemplate('http://localhost:3000/{collection}/{id}?l={locale}')).toBeNull();
  });

  it('rejects javascript:, data:, relative URLs and unknown placeholders', () => {
    expect(validatePreviewUrlTemplate('javascript:alert(1)//{token}')?.code).toBe('INVALID_PROTOCOL');
    expect(validatePreviewUrlTemplate('data:text/html,{token}')?.code).toBe('INVALID_PROTOCOL');
    expect(validatePreviewUrlTemplate('/relative/{id}')?.code).toBe('INVALID_URL');
    expect(validatePreviewUrlTemplate('https://x.example/{secret}')?.code).toBe('UNKNOWN_PLACEHOLDER');
  });

  it('encodes every value and keeps the template host', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (slug, token) => {
        const url = buildPreviewUrl('https://front.example/p/{slug}?t={token}', { slug, token });
        expect(url).not.toBeNull();
        const parsed = new URL(url!);
        expect(parsed.origin).toBe('https://front.example');
        expect(parsed.searchParams.get('t')).toBe(token);
      }),
      { numRuns: 300 },
    );
    expect(buildPreviewUrl('https://front.example/{slug}', {})).toBe('https://front.example/');
    expect(previewTemplateOrigin('https://front.example:8443/x/{id}')).toBe('https://front.example:8443');
  });

  it('origins are exact scheme://host[:port]', () => {
    expect(PreviewOriginSchema.safeParse('https://front.example').success).toBe(true);
    expect(PreviewOriginSchema.safeParse('http://localhost:3000').success).toBe(true);
    for (const bad of ['https://*.example', 'https://front.example/path', 'javascript:alert(1)', 'front.example', 'https://a.example?x=1']) {
      expect(PreviewOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('PreviewTokenMintSchema', () => {
  it('requires an item or a release and rejects unknown keys', () => {
    expect(PreviewTokenMintSchema.safeParse({ collection: 'posts', itemId: 'a' }).success).toBe(true);
    expect(PreviewTokenMintSchema.safeParse({ releaseId: 'r' }).success).toBe(true);
    expect(PreviewTokenMintSchema.safeParse({}).success).toBe(false);
    expect(PreviewTokenMintSchema.safeParse({ collection: 'posts' }).success).toBe(false);
    expect(PreviewTokenMintSchema.safeParse({ releaseId: 'r', versionKey: 'v' }).success).toBe(false);
    expect(PreviewTokenMintSchema.safeParse({ releaseId: 'r', siteId: 'other' }).success).toBe(false);
    expect(PreviewTokenMintSchema.safeParse({ releaseId: 'r', ttlSeconds: 86400 }).success).toBe(false);
    expect(PreviewTokenMintSchema.safeParse({ releaseId: 'r', locale: '../../x' }).success).toBe(false);
  });
});

describe('collection meta.previewUrl validation (PATCH /collections/:name)', () => {
  it('rejects non-http(s) templates and unknown placeholders, accepts valid and null', async () => {
    const { collectionPatchSchema } = await import('../../routes/collections');
    expect(collectionPatchSchema.safeParse({ meta: { previewUrl: 'javascript:alert(1)' } }).success).toBe(false);
    expect(collectionPatchSchema.safeParse({ meta: { previewUrl: 'https://x.example/{nope}' } }).success).toBe(false);
    expect(collectionPatchSchema.safeParse({ meta: { previewUrl: 42 } }).success).toBe(false);
    expect(collectionPatchSchema.safeParse({ meta: { previewUrl: 'https://x.example/{slug}?t={token}' } }).success).toBe(true);
    expect(collectionPatchSchema.safeParse({ meta: { previewUrl: null, icon: 'x' } }).success).toBe(true);
  });
});
