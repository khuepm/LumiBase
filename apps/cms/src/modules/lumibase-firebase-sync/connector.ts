/**
 * LumiBase Firebase Sync — Firebase REST connector.
 *
 * Edge-native: uses only `fetch` + Web Crypto (no firebase-admin SDK, which is
 * not Workers-compatible). Supports two Firebase targets:
 *
 *   - **Cloud Firestore** — each LumiBase item becomes one document under the
 *     configured path. Auth via a service-account JSON → signed JWT → OAuth2
 *     access token (cached in-process for its lifetime).
 *   - **Realtime Database (RTDB)** — each item is written to a JSON ref. Auth
 *     via the legacy database secret appended as `?auth=`.
 *
 * Credentials never leave this module in plaintext: callers pass the already
 * decrypted blob and the connector holds it only for the call's lifetime.
 */

import { formatSafeError } from '@lumibase/shared/utils';

/** Coerce any error into a single log-safe string for the {@link SyncResult}. */
function stringifyError(err: unknown): string {
  const safe = formatSafeError(err);
  return typeof safe === 'string' ? safe : JSON.stringify(safe);
}

export type FirebaseTarget = 'firestore' | 'rtdb';
export type SyncAction = 'create' | 'update' | 'delete';

/** Firestore service-account JSON (the fields we actually use). */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** RTDB credential blob. */
export interface RtdbCredentials {
  databaseUrl: string;
  secret: string;
}

export type FirebaseCredentials = ServiceAccount | RtdbCredentials;

export interface SyncResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface FirebaseConnector {
  readonly target: FirebaseTarget;
  /** Upsert an item document at `path` (create + update share this op). */
  put(path: string, data: Record<string, unknown>): Promise<SyncResult>;
  /** Remove a document/ref at `path`. */
  remove(path: string): Promise<SyncResult>;
}

// ── base64url helpers (Web Crypto / JWT) ───────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Convert a PEM-encoded PKCS#8 private key to a CryptoKey for RS256. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// ── Firestore connector (OAuth2 via service-account JWT) ────────────────────

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

class FirestoreConnector implements FirebaseConnector {
  readonly target = 'firestore' as const;
  private accessToken: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(
    private readonly account: ServiceAccount,
    /** epoch-ms supplier; injectable so the module stays time-source agnostic. */
    private readonly now: () => number,
  ) {}

  /** Build (and cache) a short-lived OAuth2 access token from the service account. */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.now() < this.tokenExpiresAtMs - 60_000) {
      return this.accessToken;
    }
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + 3600;
    const header = base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claim = base64UrlEncode(
      utf8(
        JSON.stringify({
          iss: this.account.client_email,
          scope: FIRESTORE_SCOPE,
          aud: TOKEN_URL,
          iat,
          exp,
        }),
      ),
    );
    const signingInput = `${header}.${claim}`;
    const key = await importPrivateKey(this.account.private_key);
    // Cast to BufferSource: under newer TS libs Uint8Array<ArrayBufferLike>
    // no longer satisfies BufferSource directly (matches the repo-wide TS
    // lib-skew casts). Behavior-preserving.
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      utf8(signingInput) as BufferSource,
    );
    const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Firebase token exchange failed (${res.status})`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.tokenExpiresAtMs = this.now() + json.expires_in * 1000;
    return this.accessToken;
  }

  /**
   * Encode a JS value into a Firestore REST `Value`. Covers the field types
   * LumiBase items use (string/number/boolean/null/array/object); unknown
   * types fall back to a JSON string so a sync never silently drops data.
   */
  private encodeValue(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    }
    if (typeof value === 'string') return { stringValue: value };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map((v) => this.encodeValue(v)) } };
    }
    if (typeof value === 'object') {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        fields[k] = this.encodeValue(v);
      }
      return { mapValue: { fields } };
    }
    return { stringValue: JSON.stringify(value) };
  }

  private docUrl(path: string): string {
    return `https://firestore.googleapis.com/v1/projects/${this.account.project_id}/databases/(default)/documents/${path}`;
  }

  async put(path: string, data: Record<string, unknown>): Promise<SyncResult> {
    const start = this.now();
    try {
      const token = await this.getAccessToken();
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) fields[k] = this.encodeValue(v);
      // PATCH on the document path performs an upsert in Firestore REST.
      const res = await fetch(this.docUrl(path), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, durationMs: this.now() - start, error: `Firestore ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true, durationMs: this.now() - start };
    } catch (err) {
      return { ok: false, durationMs: this.now() - start, error: stringifyError(err) };
    }
  }

  async remove(path: string): Promise<SyncResult> {
    const start = this.now();
    try {
      const token = await this.getAccessToken();
      const res = await fetch(this.docUrl(path), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 = already gone; treat as success (idempotent delete).
      if (!res.ok && res.status !== 404) {
        const body = await res.text();
        return { ok: false, durationMs: this.now() - start, error: `Firestore ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true, durationMs: this.now() - start };
    } catch (err) {
      return { ok: false, durationMs: this.now() - start, error: stringifyError(err) };
    }
  }
}

// ── Realtime Database connector (REST + ?auth= secret) ──────────────────────

class RtdbConnector implements FirebaseConnector {
  readonly target = 'rtdb' as const;

  constructor(
    private readonly creds: RtdbCredentials,
    private readonly now: () => number,
  ) {}

  private refUrl(path: string): string {
    const base = this.creds.databaseUrl.replace(/\/+$/, '');
    return `${base}/${path}.json?auth=${encodeURIComponent(this.creds.secret)}`;
  }

  async put(path: string, data: Record<string, unknown>): Promise<SyncResult> {
    const start = this.now();
    try {
      // PUT replaces the node at `path` — an idempotent upsert.
      const res = await fetch(this.refUrl(path), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, durationMs: this.now() - start, error: `RTDB ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true, durationMs: this.now() - start };
    } catch (err) {
      return { ok: false, durationMs: this.now() - start, error: stringifyError(err) };
    }
  }

  async remove(path: string): Promise<SyncResult> {
    const start = this.now();
    try {
      const res = await fetch(this.refUrl(path), { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, durationMs: this.now() - start, error: `RTDB ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true, durationMs: this.now() - start };
    } catch (err) {
      return { ok: false, durationMs: this.now() - start, error: stringifyError(err) };
    }
  }
}

/**
 * Build a connector for the given target from decrypted credentials.
 * `now` defaults to `Date.now`; tests inject a fixed clock.
 */
export function createFirebaseConnector(
  target: FirebaseTarget,
  credentials: FirebaseCredentials,
  now: () => number = () => Date.now(),
): FirebaseConnector {
  if (target === 'firestore') {
    return new FirestoreConnector(credentials as ServiceAccount, now);
  }
  if (target === 'rtdb') {
    return new RtdbConnector(credentials as RtdbCredentials, now);
  }
  throw new Error(`Unsupported Firebase target: ${target as string}`);
}
