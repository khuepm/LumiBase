/**
 * Marketplace routes — POST-GA5.
 *
 * Public discovery + install path for signed extensions.
 *
 *   GET  /api/v1/marketplace/extensions             list published extensions
 *   GET  /api/v1/marketplace/extensions/:slug       detail (signature included)
 *   POST /api/v1/marketplace/extensions/:slug/install
 *                                                   install into the active site
 *   POST /api/v1/marketplace/publish                publish an extension
 *
 * Signature verification:
 *   - Extensions ship with a detached signature (`signature`) over the
 *     SHA-256 of the bundle. Public keys live in the env var
 *     `MARKETPLACE_PUBLIC_KEYS` as a JSON map `{ keyId: pem }`.
 *   - On install, we recompute the bundle hash and verify the signature
 *     using WebCrypto (`subtle.verify`).
 */

import { extensions } from '@lumibase/database';
import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

export const marketplaceRouter = new Hono<AppEnv>();

// ── helpers ────────────────────────────────────────────────────────────────

function loadPublicKeys(env: AppEnv['Bindings']): Record<string, string> {
  const raw = (env as Record<string, string | undefined>)['MARKETPLACE_PUBLIC_KEYS'];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyEd25519Signature(
  publicKeyPem: string,
  signatureB64: string,
  message: ArrayBuffer,
): Promise<boolean> {
  // Strip PEM headers + base64 decode.
  const body = publicKeyPem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));

  try {
    const key = await crypto.subtle.importKey(
      'spki',
      der.buffer as ArrayBuffer,
      { name: 'Ed25519' } as { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig.buffer as ArrayBuffer, message);
  } catch {
    return false;
  }
}

// ── routes ─────────────────────────────────────────────────────────────────

marketplaceRouter.get('/extensions', async (c) => {
  const db = c.get('db');
  const rows = await db
    .select()
    .from(extensions)
    .where(isNotNull(extensions.publishedAt));
  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      type: r.type,
      publisher: r.publisher,
      marketplaceSlug: r.marketplaceSlug,
      publishedAt: r.publishedAt,
    })),
  });
});

marketplaceRouter.get('/extensions/:slug', async (c) => {
  const db = c.get('db');
  const slug = c.req.param('slug');
  const [row] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.marketplaceSlug, slug), isNotNull(extensions.publishedAt)));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Extension not found' }] }, 404);

  return c.json({
    data: {
      id: row.id,
      name: row.name,
      version: row.version,
      type: row.type,
      publisher: row.publisher,
      marketplaceSlug: row.marketplaceSlug,
      manifest: row.manifest,
      bundleUrl: row.bundleUrl,
      bundleSha256: row.bundleSha256,
      signature: row.signature,
      signatureAlg: row.signatureAlg,
      publisherKeyId: row.publisherKeyId,
      publishedAt: row.publishedAt,
    },
  });
});

marketplaceRouter.post('/extensions/:slug/install', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const slug = c.req.param('slug');

  const [source] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.marketplaceSlug, slug), isNotNull(extensions.publishedAt)));
  if (!source) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Not found' }] }, 404);

  // Fetch bundle and verify signature.
  if (source.bundleSha256 && source.signature && source.publisherKeyId) {
    const res = await fetch(source.bundleUrl);
    if (!res.ok) {
      return c.json(
        { errors: [{ code: 'BUNDLE_FETCH_FAILED', message: `Status ${res.status}` }] },
        502,
      );
    }
    const bundleBytes = await res.arrayBuffer();
    const computed = await sha256(bundleBytes);
    if (computed !== source.bundleSha256) {
      return c.json(
        { errors: [{ code: 'SIGNATURE_INVALID', message: 'Bundle hash mismatch' }] },
        400,
      );
    }

    const keys = loadPublicKeys(c.env);
    const pem = keys[source.publisherKeyId];
    if (!pem) {
      return c.json(
        { errors: [{ code: 'UNKNOWN_PUBLISHER', message: `Public key ${source.publisherKeyId} not registered` }] },
        400,
      );
    }
    const ok = await verifyEd25519Signature(pem, source.signature, bundleBytes);
    if (!ok) {
      return c.json(
        { errors: [{ code: 'SIGNATURE_INVALID', message: 'Signature verification failed' }] },
        400,
      );
    }
  }

  // Clone the marketplace row into the site's installation row.
  const installed = await db
    .insert(extensions)
    .values({
      siteId,
      name: source.name,
      version: source.version,
      type: source.type,
      enabled: false,
      bundleUrl: source.bundleUrl,
      manifest: source.manifest,
      capabilities: [],
      bundleSha256: source.bundleSha256,
      signature: source.signature,
      signatureAlg: source.signatureAlg,
      publisherKeyId: source.publisherKeyId,
      publisher: source.publisher,
      marketplaceSlug: source.marketplaceSlug,
    })
    .returning();

  return c.json({ data: installed[0] }, 201);
});

const publishSchema = z.object({
  extensionId: z.string(),
  marketplaceSlug: z.string().regex(/^[a-z0-9-]+$/),
  publisher: z.string().min(1),
  signature: z.string().min(1),
  signatureAlg: z.enum(['ed25519', 'rsa-pss-sha256']).default('ed25519'),
  publisherKeyId: z.string().min(1),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

marketplaceRouter.post('/publish', async (c) => {
  const db = c.get('db');
  const parsed = publishSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const updated = await db
    .update(extensions)
    .set({
      marketplaceSlug: parsed.data.marketplaceSlug,
      publisher: parsed.data.publisher,
      signature: parsed.data.signature,
      signatureAlg: parsed.data.signatureAlg,
      publisherKeyId: parsed.data.publisherKeyId,
      bundleSha256: parsed.data.bundleSha256,
      publishedAt: new Date(),
    })
    .where(eq(extensions.id, parsed.data.extensionId))
    .returning();

  if (updated.length === 0)
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Extension not found' }] }, 404);

  return c.json({ data: updated[0] });
});
