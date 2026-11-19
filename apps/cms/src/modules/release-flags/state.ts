import { releaseManifests, type Database } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import { verifyEd25519 } from '@lumibase/contracts/extensions';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createProcessCache } from '../../services/process-cache';
import { parseReleasePublicKeys, releaseManifestEnvelopeSchema } from './manifest';

/**
 * Deployment-wide release state (#869): the environment the module reads and
 * the accepted manifest. Kept apart from `./service` (pull, audit, site
 * choices) so feature readers outside the request path — `./gate` — can use
 * it without importing the audit logger or the routes.
 */

const MANIFEST_CACHE_TTL_MS = 30_000;

/** Raw environment the module reads. Strings as they come from env/bindings. */
export interface ReleaseEnv {
  readonly LUMIBASE_RELEASE_FLAGS?: string;
  readonly LUMIBASE_RELEASE_PUBLIC_KEYS?: string;
  readonly LUMIBASE_RELEASE_MANIFEST_URL?: string;
  readonly LUMIBASE_RELEASE_MANIFEST_REFRESH_S?: string;
  readonly LUMIBASE_INSTANCE_ID?: string;
}

// ─── Accepted manifest (deployment-wide) ─────────────────────────────────────

const storedManifestSchema = z.object({
  envelope: releaseManifestEnvelopeSchema,
  issuedAt: z.string(),
  issuedAtMs: z.number(),
  flags: z.record(z.string(), z.boolean()),
  acceptedAt: z.string(),
  source: z.enum(['push', 'pull']),
  acceptedBy: z.string().nullable(),
});
export type StoredManifest = z.infer<typeof storedManifestSchema>;

const manifestCache = createProcessCache<StoredManifest | null>({ ttlMs: MANIFEST_CACHE_TTL_MS });
let lastReadManifest: StoredManifest | null = null;

/**
 * The manifest this deployment accepted, or `null`. Cached per process for
 * 30 s: another replica that accepts a manifest is picked up within that
 * window; the replica that accepted it clears its own cache immediately.
 * A read failure is not cached: the call answers the last manifest this
 * process read successfully, or `null` when it never read one, so flags fall
 * back to stage defaults rather than failing the request — including on a
 * schema that predates migration `0043` while an upgrade is rolling out. A
 * transient read error therefore never undoes a manifest that already
 * withdrew a feature (#896: `ga` gates can be withdrawn).
 */
export async function loadAcceptedManifest(systemDb: Database): Promise<StoredManifest | null> {
  try {
    lastReadManifest = await manifestCache.get(async () => {
      const [row] = await systemDb
        .select({ manifest: releaseManifests.manifest })
        .from(releaseManifests)
        .where(eq(releaseManifests.id, 'current'))
        .limit(1);
      const parsed = storedManifestSchema.safeParse(row?.manifest);
      return parsed.success ? parsed.data : null;
    });
    return lastReadManifest;
  } catch (err) {
    console.warn('[release-flags] could not read the accepted manifest', formatSafeError(err));
    return lastReadManifest;
  }
}

/** Forget the cached manifest so the next read goes to the database. */
export function clearManifestCache(): void {
  manifestCache.clear();
}

const trustCache = new Map<string, boolean>();

function decodePayload(payload: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The stored manifest, but only while the key that signed it is still trusted.
 * Removing a key from `LUMIBASE_RELEASE_PUBLIC_KEYS` (rotation, or a leaked
 * key) therefore withdraws every manifest it signed: flags fall back to the
 * next source. The signature is re-checked against the currently configured
 * PEM (memoised per key + signature), so swapping the PEM behind a key id also
 * counts as revoking it.
 */
export async function trustedAcceptedManifest(
  stored: StoredManifest | null,
  env: ReleaseEnv,
): Promise<StoredManifest | null> {
  if (!stored) return null;
  const pem = parseReleasePublicKeys(env.LUMIBASE_RELEASE_PUBLIC_KEYS)[stored.envelope.keyId];
  if (!pem) return null;
  const memoKey = `${stored.envelope.keyId}\n${pem}\n${stored.envelope.signature}`;
  let ok = trustCache.get(memoKey);
  if (ok === undefined) {
    const bytes = decodePayload(stored.envelope.payload);
    ok = bytes ? await verifyEd25519(pem, stored.envelope.signature, bytes) : false;
    if (trustCache.size > 64) trustCache.clear();
    trustCache.set(memoKey, ok);
  }
  return ok ? stored : null;
}

/** Test hook: forget every process-level manifest state. */
export function resetReleaseStateForTests(): void {
  manifestCache.clear();
  trustCache.clear();
  lastReadManifest = null;
}
