import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, verifyBundle } from '@lumibase/contracts/extensions';
import { clearVerifiedBundleCache, ExtensionSandbox } from '../sandbox';

/**
 * #1008: on Node with `EXTENSION_RUNTIME=in-process`, the bundle is
 * downloaded once, checked (recorded SHA-256, signature over that buffer),
 * and imported from a `data:` URL of exactly those bytes. A second response
 * from the bundle URL can never run.
 */

const ORIGIN = 'https://extensions.test';
const RESPONSES: Record<string, string[]> = {};
const downloads: Record<string, number> = {};

/** Serves bundle responses from memory, one per download; trust gates still run. */
class TestSandbox extends ExtensionSandbox {
  protected override async fetchBundleBytes(url: string): Promise<Uint8Array> {
    const source = RESPONSES[url]?.shift();
    if (source === undefined) throw new Error(`no bundle at ${url}`);
    downloads[url] = (downloads[url] ?? 0) + 1;
    return new TextEncoder().encode(source);
  }
}

const ENV = { EXTENSION_RUNTIME: 'in-process', EXTENSION_BUNDLE_ORIGINS: ORIGIN } as Record<string, unknown>;
const sandbox = () => new TestSandbox(ENV as never, undefined);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const SIGNED = `export default () => ({ hooks: { 'items.create.before': async () => ({ who: 'signed' }) } });`;
const EVIL = `globalThis.__lumibaseEvilRan = true; export default () => ({ hooks: { 'items.create.before': async () => ({ who: 'evil' }) } });`;

async function signedOptions(source: string) {
  const bytes = new TextEncoder().encode(source);
  const meta = { sha256: await sha256Hex(bytes), signature: sign(null, bytes, privateKey).toString('base64'), keyId: 'k', alg: 'ed25519' as const };
  return {
    requireSignature: true,
    expectedSha256: meta.sha256,
    // The old URL-based gate: it would have fetched (and passed) a clean response.
    verify: async () => true,
    verifyBytes: async (b: Uint8Array) =>
      (await verifyBundle(b, meta, () => ({ publicKeyPem, publisher: 't', official: false, revoked: false }))).ok,
  };
}

describe('in-process extension load runs the verified bytes (#1008)', () => {
  const evil = () => (globalThis as { __lumibaseEvilRan?: boolean }).__lumibaseEvilRan;
  beforeEach(() => clearVerifiedBundleCache());
  afterEach(() => {
    delete (globalThis as { __lumibaseEvilRan?: boolean }).__lumibaseEvilRan;
  });

  it('downloads once and imports those bytes, not the URL', async () => {
    const url = `${ORIGIN}/one.mjs`;
    RESPONSES[url] = [SIGNED, EVIL];
    downloads[url] = 0;
    const mod = await sandbox().load({ name: 'one', bundleUrl: url, capabilities: [], ...(await signedOptions(SIGNED)) });
    // An https URL cannot be imported on Node at all: a working module proves the data: path.
    expect(await mod!.hooks!['items.create.before']!({ collection: 'x' })).toEqual({ who: 'signed' });
    expect(downloads[url]).toBe(1);
    expect(evil()).toBeUndefined();
  });

  it('refuses a later response that differs from the signed one, and runs none of it', async () => {
    const url = `${ORIGIN}/swap.mjs`;
    RESPONSES[url] = [EVIL];
    const mod = await sandbox().load({ name: 'swap', bundleUrl: url, capabilities: [], ...(await signedOptions(SIGNED)) });
    expect(mod).toBeNull();
    expect(evil()).toBeUndefined();
  });

  it('refuses unsigned bytes even though the URL-based verify() would pass', async () => {
    const url = `${ORIGIN}/unsigned.mjs`;
    RESPONSES[url] = [EVIL];
    const mod = await sandbox().load({ name: 'unsigned', bundleUrl: url, capabilities: [], ...(await signedOptions(SIGNED)), expectedSha256: null });
    expect(mod).toBeNull();
    expect(evil()).toBeUndefined();
  });

  it('fails closed when a signature is required and no byte verifier is given', async () => {
    const url = `${ORIGIN}/noverifier.mjs`;
    RESPONSES[url] = [SIGNED];
    const mod = await sandbox().load({ name: 'noverifier', bundleUrl: url, capabilities: [], requireSignature: true, verify: async () => true });
    expect(mod).toBeNull();
  });

  it('refuses bytes that do not match the recorded SHA-256 with no signature policy', async () => {
    const url = `${ORIGIN}/pinned.mjs`;
    RESPONSES[url] = [EVIL];
    const expectedSha256 = await sha256Hex(new TextEncoder().encode(SIGNED));
    expect(await sandbox().load({ name: 'pinned', bundleUrl: url, capabilities: [], expectedSha256 })).toBeNull();
    expect(evil()).toBeUndefined();
  });

  describe('pinned bundles are cached by their SHA-256', () => {
    it('a second load of the same pinned bundle does not download it again', async () => {
      const url = `${ORIGIN}/cached.mjs`;
      RESPONSES[url] = [SIGNED, EVIL];
      downloads[url] = 0;
      const opts = await signedOptions(SIGNED);
      const first = await sandbox().load({ name: 'cached', bundleUrl: url, capabilities: [], ...opts });
      const second = await sandbox().load({ name: 'cached', bundleUrl: url, capabilities: [], ...opts });
      expect(downloads[url]).toBe(1);
      // The swapped response is never fetched, let alone run.
      expect(await second!.hooks!['items.create.before']!({ collection: 'x' })).toEqual({ who: 'signed' });
      expect(await first!.hooks!['items.create.before']!({ collection: 'x' })).toEqual({ who: 'signed' });
      expect(evil()).toBeUndefined();
    });

    it('still checks the signature on every load: a revoked key refuses cached bytes', async () => {
      const url = `${ORIGIN}/revoked.mjs`;
      RESPONSES[url] = [SIGNED];
      const opts = await signedOptions(SIGNED);
      expect(await sandbox().load({ name: 'revoked', bundleUrl: url, capabilities: [], ...opts })).not.toBeNull();
      const revoked = { ...opts, verifyBytes: async () => false };
      expect(await sandbox().load({ name: 'revoked', bundleUrl: url, capabilities: [], ...revoked })).toBeNull();
    });

    it('a different recorded SHA-256 is a cache miss and downloads', async () => {
      const url = `${ORIGIN}/miss.mjs`;
      RESPONSES[url] = [SIGNED, EVIL];
      downloads[url] = 0;
      await sandbox().load({ name: 'miss', bundleUrl: url, capabilities: [], ...(await signedOptions(SIGNED)) });
      const other = await sandbox().load({ name: 'miss', bundleUrl: url, capabilities: [], ...(await signedOptions(EVIL)) });
      expect(downloads[url]).toBe(2);
      expect(other).not.toBeNull();
    });

    it('an unpinned load is never served from the cache', async () => {
      const url = `${ORIGIN}/unpinned.mjs`;
      RESPONSES[url] = [SIGNED, SIGNED];
      downloads[url] = 0;
      await sandbox().load({ name: 'unpinned', bundleUrl: url, capabilities: [] });
      await sandbox().load({ name: 'unpinned', bundleUrl: url, capabilities: [] });
      expect(downloads[url]).toBe(2);
    });
  });
});
