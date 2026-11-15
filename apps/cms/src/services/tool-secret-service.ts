import { agentToolSecrets, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { arrayBufferToBase64, base64ToArrayBuffer } from './crypto-service';
import { formatEnvelope, parseEnvelope } from './crypto/envelope-codec';
import { isValidToolSecretName } from './external-action-tools';

/**
 * Per-site secret store for external-action tools.
 *
 * A tool declares the names of the secrets it needs; an operator stores the
 * values here. The value is encrypted with the runtime KeyProvider (same
 * `{keyId}:{body}` envelope as deployment tokens, so key rotation applies
 * uniformly) and the AAD binds it to its site and name: a ciphertext copied
 * onto another site's row, or under another name, does not decrypt.
 *
 * The store is write-only from the outside. `list` returns names and
 * timestamps; `resolve` returns values and is called by the harness alone,
 * at the moment a handler runs.
 */

/** Shortest value accepted: shorter strings cannot be scrubbed from output safely. */
export const TOOL_SECRET_MIN_LENGTH = 8;
export const TOOL_SECRET_MAX_LENGTH = 8192;

export class ToolSecretError extends Error {
  constructor(
    readonly code: 'INVALID_NAME' | 'INVALID_VALUE' | 'KEYS_UNAVAILABLE' | 'SECRET_MISSING' | 'SECRET_UNREADABLE',
    message: string,
  ) {
    super(message);
    this.name = 'ToolSecretError';
  }
}

export interface ToolSecretSummary {
  name: string;
  keyId: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolSecretServiceDeps {
  db: Database;
  siteId: string;
  keys?: KeyProvider | undefined;
}

async function importAesKey(base64Key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToArrayBuffer(base64Key), { name: 'AES-GCM' }, false, usage);
}

function aad(siteId: string, name: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(`tool-secret|${siteId}|${name}`);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

export class ToolSecretService {
  constructor(private readonly deps: ToolSecretServiceDeps) {}

  private requireKeys(): KeyProvider {
    if (!this.deps.keys) {
      throw new ToolSecretError('KEYS_UNAVAILABLE', 'No KeyProvider is configured; tool secrets cannot be read or written.');
    }
    return this.deps.keys;
  }

  /** Stores or replaces a secret. The value is never echoed back. */
  async set(name: string, value: string, updatedBy: string | null): Promise<ToolSecretSummary> {
    if (!isValidToolSecretName(name)) {
      throw new ToolSecretError('INVALID_NAME', 'Secret name must match /^[A-Z][A-Z0-9_]{1,63}$/.');
    }
    if (typeof value !== 'string' || value.length < TOOL_SECRET_MIN_LENGTH || value.length > TOOL_SECRET_MAX_LENGTH) {
      throw new ToolSecretError(
        'INVALID_VALUE',
        `Secret value must be ${TOOL_SECRET_MIN_LENGTH}-${TOOL_SECRET_MAX_LENGTH} characters.`,
      );
    }
    const { keyId, key } = await this.requireKeys().getActiveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(this.deps.siteId, name) },
      await importAesKey(key, ['encrypt']),
      new TextEncoder().encode(value),
    );
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    const ciphertext = formatEnvelope(keyId, arrayBufferToBase64(combined.buffer));

    const now = new Date();
    const [row] = await this.deps.db
      .insert(agentToolSecrets)
      .values({ siteId: this.deps.siteId, name, ciphertext, keyId, updatedBy })
      .onConflictDoUpdate({
        target: [agentToolSecrets.siteId, agentToolSecrets.name],
        set: { ciphertext, keyId, updatedBy, updatedAt: now },
      })
      .returning({
        name: agentToolSecrets.name,
        keyId: agentToolSecrets.keyId,
        updatedBy: agentToolSecrets.updatedBy,
        createdAt: agentToolSecrets.createdAt,
        updatedAt: agentToolSecrets.updatedAt,
      });
    return row!;
  }

  async delete(name: string): Promise<boolean> {
    const removed = await this.deps.db
      .delete(agentToolSecrets)
      .where(and(eq(agentToolSecrets.siteId, this.deps.siteId), eq(agentToolSecrets.name, name)))
      .returning({ id: agentToolSecrets.id });
    return removed.length > 0;
  }

  /** Names and metadata only. */
  async list(): Promise<ToolSecretSummary[]> {
    return this.deps.db
      .select({
        name: agentToolSecrets.name,
        keyId: agentToolSecrets.keyId,
        updatedBy: agentToolSecrets.updatedBy,
        createdAt: agentToolSecrets.createdAt,
        updatedAt: agentToolSecrets.updatedAt,
      })
      .from(agentToolSecrets)
      .where(eq(agentToolSecrets.siteId, this.deps.siteId))
      .orderBy(asc(agentToolSecrets.name));
  }

  /**
   * Decrypts the named secrets for THIS site. All-or-nothing: a missing or
   * undecryptable secret throws and names the reference, never a value, so a
   * handler is not started with half of what it declared.
   */
  async resolve(names: readonly string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (names.length === 0) return resolved;
    const keys = this.requireKeys();
    const rows = await this.deps.db
      .select({ name: agentToolSecrets.name, ciphertext: agentToolSecrets.ciphertext })
      .from(agentToolSecrets)
      .where(and(eq(agentToolSecrets.siteId, this.deps.siteId), inArray(agentToolSecrets.name, [...names])));
    const byName = new Map(rows.map((row) => [row.name, row.ciphertext]));
    const missing = names.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      throw new ToolSecretError('SECRET_MISSING', `Secret(s) not configured for this site: ${missing.join(', ')}`);
    }
    for (const name of names) {
      try {
        const { keyId, body, legacy } = parseEnvelope(byName.get(name)!);
        if (legacy) throw new Error('not a versioned envelope');
        const combined = new Uint8Array(base64ToArrayBuffer(body));
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: combined.slice(0, 12), additionalData: aad(this.deps.siteId, name) },
          await importAesKey(await keys.getKey(keyId), ['decrypt']),
          combined.slice(12),
        );
        resolved.set(name, new TextDecoder().decode(plain));
      } catch {
        // The underlying error is dropped on purpose: crypto and key-provider
        // errors can quote key ids or material.
        throw new ToolSecretError('SECRET_UNREADABLE', `Secret "${name}" could not be decrypted for this site.`);
      }
    }
    return resolved;
  }
}
