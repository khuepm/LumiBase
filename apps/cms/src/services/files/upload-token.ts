/**
 * Signed raw-byte upload tokens (`POST /files/presigned-url` →
 * `PUT /files/upload/:key`) and the storage namespace they write into.
 *
 * The upload path is exempt from `withTenant` and `withAuth`: the token is
 * its only authority. It binds one storage key and one site, and since #993
 * the key always lies in that site's namespace, so a token can never write
 * into another tenant's objects and the upload guard can apply the issuing
 * site's upload policy (`siteIdFromUploadToken`).
 */
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Bindings } from '../../env';

const uploadTokenPayloadSchema = z.object({
  key: z.string().min(1),
  siteId: z.string().min(1),
});

export type UploadTokenPayload = z.infer<typeof uploadTokenPayloadSchema>;

export function getUploadJwtSecret(env: Partial<Bindings> | undefined): string | null {
  return env?.JWT_SECRET || process.env.JWT_SECRET || null;
}

export async function signUploadToken(payload: UploadTokenPayload, secret: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}

export async function verifyUploadToken(token: string, secret: string): Promise<UploadTokenPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
  return uploadTokenPayloadSchema.parse(payload);
}

/**
 * The site a valid upload token was issued for, or `null` when the token is
 * missing, invalid or expired (the route then refuses the upload itself).
 */
export async function siteIdFromUploadToken(token: string | undefined, env: Partial<Bindings> | undefined): Promise<string | null> {
  const secret = getUploadJwtSecret(env);
  if (!token || !secret) return null;
  try {
    return (await verifyUploadToken(token, secret)).siteId;
  } catch {
    return null;
  }
}

/**
 * Storage namespace of a site's library files (#993). The bucket is shared by
 * every tenant, so a key is only ever written or registered inside its own
 * site's prefix — the same scheme `/media` uses (`sites/<id>/media/`).
 */
export function filesKeyPrefix(siteId: string): string {
  return `sites/${siteId}/files/`;
}

/** Whether `key` lies inside `siteId`'s storage namespace (files or media). */
export function isSiteStorageKey(siteId: string, key: string): boolean {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) return false;
  return key.startsWith(filesKeyPrefix(siteId)) || key.startsWith(`sites/${siteId}/media/`);
}
