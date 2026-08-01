/**
 * Change Feed → extension delivery (Req 5.2–5.5).
 *
 * The host — not the extension — decides what a subscriber may see: envelopes
 * are filtered against the manifest's `cdc:subscribe:<collection>` capabilities
 * BEFORE entering the sandbox, and a handler is raced against a 5s budget
 * (the HookDispatcher timeout convention). A throwing/hanging handler simply
 * fails the batch — the dispatcher's retry/dead machinery takes over, and
 * other subscriptions are unaffected (P12: one lane per subscription).
 *
 * Also owns the enable/disable → subscription sync (Req 3.4): enabling a
 * hook extension with cdc capabilities upserts its `kind='extension'`
 * subscription (`ext:<name>`); disabling pauses it.
 */

import { and, eq } from 'drizzle-orm';
import { cdcSubscriptions, extensions, type Database } from '@lumibase/database';
import type { CdcEventEnvelope } from '@lumibase/contracts/schemas';
import type { CacheProvider } from '@lumibase/runtime';
import { ExtensionSandbox } from '../../../extensions/sandbox';
import type { DispatchableSubscription, EnvelopeSender } from './dispatcher';
import type { WebhookSendOutcome } from './webhook-sender';
import { invalidateFeedFlagCache } from './outbox-writer';

export const EXTENSION_BATCH_TIMEOUT_MS = 5_000;
export const CDC_SUBSCRIBE_CAPABILITY_PREFIX = 'cdc:subscribe:';

/**
 * Pure: derive the collections a manifest may subscribe to from its granted
 * capabilities. `'*'` = all collections; `null` = no cdc capability at all
 * (the subscriber is blocked entirely — Req 5.2).
 */
export function parseCdcSubscribeCapabilities(
  capabilities: string[],
): Set<string> | '*' | null {
  const collections = new Set<string>();
  let any = false;
  for (const cap of capabilities) {
    if (!cap.startsWith(CDC_SUBSCRIBE_CAPABILITY_PREFIX)) continue;
    any = true;
    const target = cap.slice(CDC_SUBSCRIBE_CAPABILITY_PREFIX.length);
    if (target === '*') return '*';
    if (target) collections.add(target);
  }
  return any ? collections : null;
}

/** Host-side filter — never trust the extension to self-limit (Req 5.2). */
export function filterEnvelopesByCapability(
  envelopes: CdcEventEnvelope[],
  allowed: Set<string> | '*',
): CdcEventEnvelope[] {
  if (allowed === '*') return envelopes;
  return envelopes.filter((e) => allowed.has(e.collection));
}

export interface LoadedCdcSubscriber {
  handler: (input: {
    events: CdcEventEnvelope[];
    ctx: { siteId: string; config: Record<string, unknown>; logger: Console };
  }) => Promise<void> | void;
  allowedCollections: Set<string> | '*';
  config: Record<string, unknown>;
}

/** Port so P12 runs without a real sandbox/bundle. */
export interface CdcSubscriberLoader {
  load(siteId: string, extensionName: string): Promise<LoadedCdcSubscriber | null>;
}

export interface ExtensionEnvelopeSenderDeps {
  loader: CdcSubscriberLoader;
  timeoutMs?: number;
}

export class ExtensionEnvelopeSender implements EnvelopeSender {
  constructor(private readonly deps: ExtensionEnvelopeSenderDeps) {}

  async deliver(
    sub: DispatchableSubscription,
    envelopes: CdcEventEnvelope[],
  ): Promise<WebhookSendOutcome> {
    if (!sub.extensionName) {
      return { ok: false, httpStatus: null, errorMessage: 'Subscription has no extension' };
    }
    const loaded = await this.deps.loader.load(sub.siteId, sub.extensionName);
    if (!loaded) {
      return {
        ok: false,
        httpStatus: null,
        errorMessage: `Extension "${sub.extensionName}" unavailable or lacks cdc:subscribe capability`,
      };
    }
    const visible = filterEnvelopesByCapability(envelopes, loaded.allowedCollections);
    if (visible.length === 0) {
      // Nothing this subscriber may see — the batch is done from its
      // perspective; the cursor must still advance (no permanent stall).
      return { ok: true, httpStatus: null, errorMessage: null };
    }
    const timeoutMs = this.deps.timeoutMs ?? EXTENSION_BATCH_TIMEOUT_MS;
    try {
      await Promise.race([
        Promise.resolve(
          loaded.handler({
            events: visible,
            ctx: { siteId: sub.siteId, config: loaded.config, logger: console },
          }),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`cdc subscriber timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      return { ok: true, httpStatus: null, errorMessage: null };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Production loader: resolves the enabled hook-extension row, loads its
 * bundle through ExtensionSandbox (capability-proxied context), and reads
 * the `cdcSubscriber` export. Capability derivation happens HERE, from the
 * granted row — never from the module's own declaration.
 */
export class SandboxCdcSubscriberLoader implements CdcSubscriberLoader {
  constructor(
    private readonly db: Database,
    private readonly env: Record<string, unknown> = {},
  ) {}

  async load(siteId: string, extensionName: string): Promise<LoadedCdcSubscriber | null> {
    const [row] = await this.db
      .select()
      .from(extensions)
      .where(
        and(
          eq(extensions.siteId, siteId),
          eq(extensions.name, extensionName),
          eq(extensions.enabled, true),
          eq(extensions.type, 'hook'),
        ),
      )
      .limit(1);
    if (!row) return null;
    const capabilities = (row.capabilities as string[]) ?? [];
    const allowed = parseCdcSubscribeCapabilities(capabilities);
    if (allowed === null) return null;

    const sandbox = new ExtensionSandbox(this.env as never, this.db);
    const mod = await sandbox.load({
      name: row.name,
      bundleUrl: row.bundleUrl,
      capabilities,
    });
    const subscriber = (
      mod as unknown as {
        cdcSubscriber?: { handler?: LoadedCdcSubscriber['handler'] };
      } | null
    )?.cdcSubscriber;
    if (!subscriber?.handler) return null;
    const manifest = row.manifest as { config?: Record<string, unknown> } | null;
    return {
      handler: subscriber.handler,
      allowedCollections: allowed,
      // Per-site config values are not a column yet; expose the manifest's
      // config block (defaults) so handlers have a stable shape.
      config: manifest?.config ?? {},
    };
  }
}

/**
 * Enable/disable → subscription sync (Req 3.4). Idempotent upsert keyed by
 * the reserved name `ext:<extensionName>`; disable pauses instead of
 * deleting so the checkpoint survives a re-enable.
 */
export async function syncExtensionCdcSubscription(
  db: Database,
  siteId: string,
  extension: { name: string; type: string; enabled: boolean; capabilities: string[] },
  cache?: CacheProvider,
): Promise<void> {
  if (extension.type !== 'hook') return;
  const allowed = parseCdcSubscribeCapabilities(extension.capabilities);
  const name = `ext:${extension.name}`;
  const [existing] = await db
    .select({ id: cdcSubscriptions.id, status: cdcSubscriptions.status })
    .from(cdcSubscriptions)
    .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.name, name)))
    .limit(1);

  if (extension.enabled && allowed !== null) {
    const collections = allowed === '*' ? [] : [...allowed];
    if (existing) {
      await db
        .update(cdcSubscriptions)
        .set({ status: 'active', collections, updatedAt: new Date() })
        .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, existing.id)));
    } else {
      await db.insert(cdcSubscriptions).values({
        siteId,
        name,
        kind: 'extension',
        collections,
        operations: [],
        extensionName: extension.name,
      });
    }
    await invalidateFeedFlagCache(cache, siteId);
  } else if (existing && existing.status === 'active') {
    await db
      .update(cdcSubscriptions)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, existing.id)));
    await invalidateFeedFlagCache(cache, siteId);
  }
}
