import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFirebaseConnector,
  type RtdbCredentials,
  type ServiceAccount,
} from '../modules/lumibase-firebase-sync/connector';

/**
 * Feature: lumibase-firebase-sync — Firebase REST connector.
 *
 * These tests exercise the connector against a mocked `fetch`, covering both
 * targets (Firestore + RTDB) and the upsert/delete semantics, without any
 * network access or real Firebase project.
 */

const fixedNow = () => 1_700_000_000_000; // fixed clock; connector is time-injectable.

// A throwaway RSA PKCS#8 key generated for tests only — never a real secret.
// Generated via: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAtestkeytestkeytest
-----END PRIVATE KEY-----`;

const serviceAccount: ServiceAccount = {
  project_id: 'demo-project',
  client_email: 'svc@demo-project.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY,
};

const rtdbCreds: RtdbCredentials = {
  databaseUrl: 'https://demo-project.firebaseio.com',
  secret: 'rtdb-secret-token',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RTDB connector', () => {
  it('PUTs an upsert to the correct ref with the auth secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 200 });
      }),
    );

    const connector = createFirebaseConnector('rtdb', rtdbCreds, fixedNow);
    const result = await connector.put('content/articles/item-1', { title: 'Hello' });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://demo-project.firebaseio.com/content/articles/item-1.json?auth=rtdb-secret-token',
    );
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ title: 'Hello' });
  });

  it('DELETEs the ref on remove', async () => {
    const fetchMock = vi.fn(async () => new Response('null', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const connector = createFirebaseConnector('rtdb', rtdbCreds, fixedNow);
    const result = await connector.remove('content/articles/item-1');

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://demo-project.firebaseio.com/content/articles/item-1.json?auth=rtdb-secret-token',
      { method: 'DELETE' },
    );
  });

  it('reports an error (ok=false) on a non-2xx response without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('permission denied', { status: 401 })));

    const connector = createFirebaseConnector('rtdb', rtdbCreds, fixedNow);
    const result = await connector.put('content/x/item-1', { a: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('RTDB 401');
  });
});

describe('Firestore connector', () => {
  it('encodes typed field values and PATCHes the document on upsert', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        // First call = token exchange; subsequent = document write.
        if (url.includes('oauth2.googleapis.com')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    // The connector signs a JWT with Web Crypto; stub it so the test key suffices.
    vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, 'sign').mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const connector = createFirebaseConnector('firestore', serviceAccount, fixedNow);
    const result = await connector.put('content/articles/item-1', {
      title: 'Hi',
      views: 42,
      ratio: 1.5,
      published: true,
      tags: ['a', 'b'],
      meta: { nested: 'x' },
    });

    expect(result.ok).toBe(true);
    const writeCall = calls.find((c) => c.url.includes('firestore.googleapis.com'));
    expect(writeCall).toBeDefined();
    expect(writeCall!.url).toBe(
      'https://firestore.googleapis.com/v1/projects/demo-project/databases/(default)/documents/content/articles/item-1',
    );
    expect(writeCall!.init.method).toBe('PATCH');
    const body = JSON.parse(writeCall!.init.body as string);
    expect(body.fields.title).toEqual({ stringValue: 'Hi' });
    expect(body.fields.views).toEqual({ integerValue: '42' });
    expect(body.fields.ratio).toEqual({ doubleValue: 1.5 });
    expect(body.fields.published).toEqual({ booleanValue: true });
    expect(body.fields.tags).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] },
    });
    expect(body.fields.meta).toEqual({ mapValue: { fields: { nested: { stringValue: 'x' } } } });
  });

  it('treats a 404 on delete as success (idempotent)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('oauth2.googleapis.com')
          ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
          : new Response('not found', { status: 404 }),
      ),
    );
    vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, 'sign').mockResolvedValue(new Uint8Array([1]).buffer);

    const connector = createFirebaseConnector('firestore', serviceAccount, fixedNow);
    const result = await connector.remove('content/articles/gone');

    expect(result.ok).toBe(true);
  });
});

describe('createFirebaseConnector', () => {
  it('throws on an unsupported target', () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid target for the guard test.
      createFirebaseConnector('mongo', rtdbCreds, fixedNow),
    ).toThrow(/Unsupported Firebase target/);
  });
});
