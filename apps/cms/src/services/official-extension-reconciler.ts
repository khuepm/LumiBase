/**
 * Auto-install reconciler for official `lumibase-*` extensions.
 *
 * For each entry in {@link OFFICIAL_EXTENSIONS} marked `autoInstall`, find the
 * published marketplace source row (siteId null, published, matching slug),
 * verify it signs against an official key, and install a site-scoped row with
 * `enabled = enabledByDefault`.
 *
 * INVARIANT: once a site row exists it is left untouched — the reconciler never
 * flips `enabled` back on. This distinguishes "never installed" from "installed
 * then disabled by an admin", so a defaulted-on extension an operator turned off
 * stays off across reconciles. Missing/invalid source rows are skipped
 * (fail-soft), never fatal — auto-install must never block setup or site create.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { extensions } from '@lumibase/database';
import type { Bindings } from '../env';
import { ExtensionVerifierService } from './extension-verifier';
import { OFFICIAL_EXTENSIONS } from '../modules/setup/official-extensions';

const LOG_PREFIX = '[lumibase-cms] official-ext-reconcile';

function extensionKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface ReconcileResult {
  installed: number;
  skipped: number;
}

/**
 * Reconcile official extensions for one site. Safe to call repeatedly and from
 * multiple call sites (setup bootstrap, site-create). Never throws.
 */
export async function reconcileOfficialExtensions(
  db: Database,
  env: Bindings,
  siteId: string,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<ReconcileResult> {
  const verifier = new ExtensionVerifierService(db, env);
  let installed = 0;
  let skipped = 0;

  for (const entry of OFFICIAL_EXTENSIONS) {
    if (!entry.autoInstall) {
      skipped += 1;
      continue;
    }
    try {
      // Already installed for this site? Leave it — never re-enable.
      const [existing] = await db
        .select({ id: extensions.id })
        .from(extensions)
        .where(and(eq(extensions.siteId, siteId), eq(extensions.name, entry.name)))
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }

      // Find the published marketplace source (global, published, by slug).
      const [source] = await db
        .select()
        .from(extensions)
        .where(
          and(
            eq(extensions.marketplaceSlug, entry.marketplaceSlug),
            isNull(extensions.siteId),
            isNotNull(extensions.publishedAt),
          ),
        )
        .limit(1);
      if (!source) {
        skipped += 1;
        continue;
      }

      // Verify + require official — never auto-install an unofficial bundle.
      const verdict = await verifier.verifyByMetadata(source.name, {
        bundleUrl: source.bundleUrl,
        bundleSha256: source.bundleSha256,
        signature: source.signature,
        publisherKeyId: source.publisherKeyId,
        signatureAlg: source.signatureAlg,
      });
      if (!verdict.ok || !verdict.isOfficial) {
        log.error(`${LOG_PREFIX}: ${entry.name} failed verification (${verdict.reason}) — skipped`);
        skipped += 1;
        continue;
      }

      await db.insert(extensions).values({
        siteId,
        key: extensionKey(source.name),
        name: source.name,
        version: source.version,
        type: source.type,
        enabled: entry.enabledByDefault,
        enabledByDefault: entry.enabledByDefault,
        autoInstall: true,
        isOfficial: true,
        verifiedAt: new Date(),
        bundleUrl: source.bundleUrl,
        manifest: source.manifest,
        capabilities: [],
        bundleSha256: source.bundleSha256,
        signature: source.signature,
        signatureAlg: source.signatureAlg,
        publisherKeyId: source.publisherKeyId,
        publisher: source.publisher,
        marketplaceSlug: source.marketplaceSlug,
      });
      installed += 1;
    } catch (err) {
      log.error(`${LOG_PREFIX}: ${entry.name} errored — skipped`, err);
      skipped += 1;
    }
  }

  return { installed, skipped };
}
