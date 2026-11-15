import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_DEV_MIN_TOKEN_LENGTH } from '@lumibase/contracts/extensions';

/**
 * Per-session secret for the `lumibase-ext dev` hub. 32 random bytes, hex —
 * printed by the CLI and required on every hub request (SSE + bundle fetch).
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** Accept a caller-pinned token only when it is long enough to be a secret. */
export function assertUsableToken(token: string): string {
  if (token.length < EXTENSION_DEV_MIN_TOKEN_LENGTH) {
    throw new Error(
      `dev token must be at least ${EXTENSION_DEV_MIN_TOKEN_LENGTH} characters (got ${token.length})`,
    );
  }
  return token;
}

/**
 * Constant-time token comparison. Both sides are hashed first so the
 * comparison length never depends on the attacker-supplied value.
 */
export function tokensMatch(expected: string, presented: string | null | undefined): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Where the CLI drops the session token so a local CMS process can pick it up
 * without a restart. The CMS dev-reload client computes the same path
 * (`apps/cms/src/extensions/dev-reload/config.ts`) — keep the two in sync.
 * The file is written 0600 and removed when the dev session ends.
 */
export function defaultTokenFilePath(port: number): string {
  return join(tmpdir(), 'lumibase-ext-dev', `${port}.token`);
}
