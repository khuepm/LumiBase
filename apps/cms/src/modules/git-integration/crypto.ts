/**
 * Encryption helpers for Git integration secrets (access tokens + webhook
 * secrets). Wraps the shared {@link CryptoService} (AES-GCM, AAD-bound) so a
 * ciphertext is tied to its `{ siteId, integrationId, field }` context and
 * cannot be replayed across sites or fields.
 *
 * Tokens are NEVER stored or logged in plaintext (CLAUDE.md rule; Req 2.5,
 * 15.2). `maskToken` produces an audit-safe fingerprint.
 */
import { CryptoService, DecryptionError } from '../../services/crypto-service';

export { DecryptionError };

const COLLECTION = 'git_integrations';

export interface GitCryptoContext {
  siteId: string;
  integrationId: string;
}

function service(encryptionKey: string): CryptoService {
  return CryptoService.fromKey(encryptionKey);
}

export async function encryptSecretValue(
  encryptionKey: string,
  plaintext: string,
  ctx: GitCryptoContext,
  field: 'token' | 'webhook_secret',
): Promise<string> {
  return service(encryptionKey).encrypt(plaintext, {
    siteId: ctx.siteId,
    collection: COLLECTION,
    field,
    recordId: ctx.integrationId,
  });
}

export async function decryptSecretValue(
  encryptionKey: string,
  ciphertext: string,
  ctx: GitCryptoContext,
  field: 'token' | 'webhook_secret',
): Promise<string> {
  const value = await service(encryptionKey).decrypt(ciphertext, {
    siteId: ctx.siteId,
    collection: COLLECTION,
    field,
    recordId: ctx.integrationId,
  });
  if (typeof value !== 'string') {
    throw new DecryptionError();
  }
  return value;
}

/** Generate a high-entropy webhook secret (hex, 256-bit). */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Audit-safe fingerprint of a secret: last 4 chars only, never the value.
 * Returns `null` for empty input so callers can store `null` rather than a
 * misleading mask.
 */
export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token.length <= 4) return '••••';
  return `••••${token.slice(-4)}`;
}
