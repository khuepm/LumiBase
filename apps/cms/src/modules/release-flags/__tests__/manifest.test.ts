import { describe, expect, it } from 'vitest';
import { parseReleasePublicKeys, verifyReleaseManifest, type VerifyManifestOptions } from '../manifest';
import { iso, makeSigner } from './signing';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const signer = makeSigner('lumibase-release-v1');
const payload = (patch: Record<string, unknown> = {}) => ({
  v: 1,
  issuedAt: iso(NOW - 60_000),
  audience: '*',
  flags: { 'content-environments': true },
  ...patch,
});
const opts = (patch: Partial<VerifyManifestOptions> = {}): VerifyManifestOptions => ({
  publicKeys: signer.publicKeys,
  instanceId: null,
  now: NOW,
  ...patch,
});

describe('verifyReleaseManifest', () => {
  it('accepts a correctly signed manifest', async () => {
    const result = await verifyReleaseManifest(signer.envelope(payload()), opts());
    expect(result).toMatchObject({ ok: true, unchanged: false });
    if (result.ok) {
      expect(result.manifest.payload.flags).toEqual({ 'content-environments': true });
      expect(result.manifest.issuedAtMs).toBe(NOW - 60_000);
    }
  });

  it.each([
    ['not an object', 'nope'],
    ['missing signature', { keyId: 'lumibase-release-v1', payload: 'e30=' }],
    ['payload not base64', { keyId: 'lumibase-release-v1', payload: '***', signature: 'AA==' }],
  ])('refuses a malformed envelope (%s)', async (_label, input) => {
    expect(await verifyReleaseManifest(input, opts())).toEqual({ ok: false, reason: 'MALFORMED_ENVELOPE' });
  });

  it('refuses an untrusted key id', async () => {
    const other = makeSigner('someone-else');
    expect(await verifyReleaseManifest(other.envelope(payload()), opts())).toEqual({ ok: false, reason: 'UNKNOWN_KEY' });
  });

  it('refuses a signature from another key under a trusted key id', async () => {
    const forger = makeSigner('lumibase-release-v1');
    expect(await verifyReleaseManifest(forger.envelope(payload()), opts())).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a payload altered after signing', async () => {
    const envelope = signer.envelope(payload({ flags: { 'content-environments': false } }));
    const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(payload())).toString('base64') };
    expect(await verifyReleaseManifest(tampered, opts())).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it.each([
    ['wrong version', { v: 2 }],
    ['non-boolean flag', { flags: { x: 'on' } }],
    ['bad date', { issuedAt: 'yesterday' }],
    ['empty audience list', { audience: [] }],
  ])('refuses a signed but malformed payload (%s)', async (_label, patch) => {
    expect(await verifyReleaseManifest(signer.envelope(payload(patch)), opts())).toEqual({
      ok: false,
      reason: 'MALFORMED_PAYLOAD',
    });
  });

  it('refuses signed bytes that are not JSON', async () => {
    expect(await verifyReleaseManifest(signer.envelope('not json'), opts())).toEqual({
      ok: false,
      reason: 'MALFORMED_PAYLOAD',
    });
  });

  it('refuses a manifest issued more than 5 minutes in the future', async () => {
    const result = await verifyReleaseManifest(signer.envelope(payload({ issuedAt: iso(NOW + 6 * 60_000) })), opts());
    expect(result).toEqual({ ok: false, reason: 'NOT_YET_VALID' });
    const skewOk = await verifyReleaseManifest(signer.envelope(payload({ issuedAt: iso(NOW + 4 * 60_000) })), opts());
    expect(skewOk.ok).toBe(true);
  });

  it('refuses to accept after notAfter', async () => {
    const result = await verifyReleaseManifest(signer.envelope(payload({ notAfter: iso(NOW - 1) })), opts());
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('matches the audience against LUMIBASE_INSTANCE_ID', async () => {
    const targeted = signer.envelope(payload({ audience: ['prod-eu-1'] }));
    expect(await verifyReleaseManifest(targeted, opts())).toEqual({ ok: false, reason: 'WRONG_AUDIENCE' });
    expect(await verifyReleaseManifest(targeted, opts({ instanceId: 'prod-us-1' }))).toEqual({
      ok: false,
      reason: 'WRONG_AUDIENCE',
    });
    expect((await verifyReleaseManifest(targeted, opts({ instanceId: 'prod-eu-1' }))).ok).toBe(true);
  });

  describe('replay protection', () => {
    const accepted = signer.envelope(payload());
    const current = { issuedAtMs: NOW - 60_000, payload: accepted.payload };

    it('treats the same manifest again as an idempotent no-op', async () => {
      expect(await verifyReleaseManifest(accepted, opts({ current }))).toMatchObject({ ok: true, unchanged: true });
    });

    it('refuses an older manifest (rollback by replay)', async () => {
      const older = signer.envelope(payload({ issuedAt: iso(NOW - 120_000), flags: {} }));
      expect(await verifyReleaseManifest(older, opts({ current }))).toEqual({ ok: false, reason: 'STALE' });
    });

    it('refuses different content with the same issuedAt', async () => {
      const sibling = signer.envelope(payload({ flags: {} }));
      expect(await verifyReleaseManifest(sibling, opts({ current }))).toEqual({ ok: false, reason: 'STALE' });
    });

    it('treats re-delivery of the accepted manifest as a no-op even after notAfter', async () => {
      const withExpiry = signer.envelope(payload({ notAfter: iso(NOW + 1000) }));
      const accepted2 = { issuedAtMs: NOW - 60_000, payload: withExpiry.payload };
      const later = NOW + 60_000; // past notAfter
      expect(await verifyReleaseManifest(withExpiry, opts({ current: accepted2, now: later }))).toMatchObject({
        ok: true,
        unchanged: true,
      });
    });

    it('accepts a newer manifest', async () => {
      const newer = signer.envelope(payload({ issuedAt: iso(NOW), flags: { 'content-environments': false } }));
      expect(await verifyReleaseManifest(newer, opts({ current }))).toMatchObject({ ok: true, unchanged: false });
    });
  });
});

describe('parseReleasePublicKeys', () => {
  it('reads a JSON map and restores escaped newlines', () => {
    const escaped = signer.publicKeyPem.replace(/\n/g, '\\n');
    const keys = parseReleasePublicKeys(JSON.stringify({ k1: escaped }));
    expect(keys.k1).toBe(signer.publicKeyPem);
  });

  it.each([undefined, '', 'not json', '[]', '{"k":42}', '{"k":"not a pem"}'])('yields no keys for %j', (raw) => {
    expect(parseReleasePublicKeys(raw)).toEqual({});
  });

  it('a key restored from env verifies a real manifest', async () => {
    const keys = parseReleasePublicKeys(JSON.stringify({ [signer.keyId]: signer.publicKeyPem.replace(/\n/g, '\\n') }));
    expect((await verifyReleaseManifest(signer.envelope(payload()), opts({ publicKeys: keys }))).ok).toBe(true);
  });
});
