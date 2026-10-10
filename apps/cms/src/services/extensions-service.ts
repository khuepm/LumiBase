import { extensions, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CacheProvider } from '@lumibase/runtime';
import type { Bindings } from '../env';
import type { MagicContext } from './permission-dsl';
import { PermissionService, type PermissionAction } from './permission-service';
import { ExtensionVerifierService } from './extension-verifier';
import { ExtensionSandbox } from '../extensions/sandbox';
import { patchSchema } from '../utils/patch-schema';

export interface ExtensionsServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  cache?: CacheProvider;
  env?: Bindings;
  permissionCtx?: MagicContext;
}
export class ExtensionMutationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404) {
    super(message);
  }
}

/**
 * Allowed extension slot types. Constrained to an enum so an arbitrary `type`
 * string can never reach the loader's dynamic-mount path.
 */
const EXTENSION_TYPES = [
  'interface', 'display', 'layout', 'panel', 'module',
  'hook', 'endpoint',
] as const;

/**
 * Shallow protocol gate for `bundleUrl` at the API boundary. The runtime
 * `validateExtensionBundleUrl` + `EXTENSION_BUNDLE_ORIGINS` allowlist remain the
 * authoritative SSRF/trust check at load time; this just rejects obviously
 * dangerous schemes (javascript:, vbscript:, file:, blob:) before they are ever
 * persisted. `data:text/javascript` stays permitted to match the loader.
 */
const bundleUrlSchema = z
  .string()
  .min(1)
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol === 'https:' || url.protocol === 'http:') return true;
      if (url.protocol === 'data:') return url.pathname.startsWith('text/javascript');
      return false;
    },
    { message: 'bundleUrl must be an https:, http:, or data:text/javascript URL.' },
  );

export const extensionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_:-]+$/).optional(),
  name: z.string(),
  version: z.string(),
  type: z.enum(EXTENSION_TYPES),
  enabled: z.boolean().default(false),
  bundleUrl: bundleUrlSchema,
  manifest: z.record(z.string(), z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
});

function extensionKey(input: { key?: string | null; name: string }): string {
  return (
    input.key?.trim() ||
    input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

function createActions(input: z.infer<typeof extensionSchema>): PermissionAction[] {
  const actions = new Set<PermissionAction>(['install']);
  if (input.enabled) actions.add('enable');
  if (input.capabilities.length > 0) actions.add('grant_capability');
  return [...actions];
}

function patchActions(input: Partial<z.infer<typeof extensionSchema>>): PermissionAction[] {
  const actions = new Set<PermissionAction>();
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) actions.add('enable');
  if (Object.prototype.hasOwnProperty.call(input, 'capabilities')) actions.add('grant_capability');
  if (
    ['key', 'name', 'version', 'type', 'bundleUrl', 'manifest'].some((field) =>
      Object.prototype.hasOwnProperty.call(input, field),
    )
  ) {
    actions.add('configure');
  }
  if (!actions.size) actions.add('configure');
  return [...actions];
}

export type ExtensionInput = z.input<typeof extensionSchema>;

/** Shared REST/agent write boundary. Missing permission context fails closed. */
export class ExtensionsService {
  constructor(private readonly deps: ExtensionsServiceDeps) {}

  withPermissionContext(ctx: MagicContext | undefined): ExtensionsService {
    if (ctx && ctx.siteId !== this.deps.siteId) throw new Error('PRINCIPAL_SITE_MISMATCH');
    return new ExtensionsService({ ...this.deps, permissionCtx: ctx, userId: ctx?.userId });
  }

  private async require(actions: PermissionAction[]): Promise<void> {
    const ctx = this.deps.permissionCtx;
    if (!ctx || ctx.siteId !== this.deps.siteId) {
      throw new ExtensionMutationError('FORBIDDEN', 'Extension operations require a tenant-bound principal.', 403);
    }
    const permissions = new PermissionService({ db: this.deps.db, cache: this.deps.cache, ctx });
    for (const action of actions) {
      if (!await permissions.canAccess('extensions', action)) {
        throw new ExtensionMutationError('FORBIDDEN', `Action "extensions:${action}" is not allowed.`, 403);
      }
    }
  }

  async listExtensions() {
    await this.require(['read']);
    return this.deps.db.select().from(extensions).where(eq(extensions.siteId, this.deps.siteId));
  }

  async installExtension(raw: ExtensionInput) {
    const input = extensionSchema.parse(raw);
    await this.require(createActions(input));
    const verifier = new ExtensionVerifierService(this.deps.db, this.deps.env ?? { LUMIBASE_ENV: 'production' });
    const verdict = await verifier.verifyByMetadata(input.name, {
      bundleUrl: input.bundleUrl, bundleSha256: null, signature: null,
      publisherKeyId: null, signatureAlg: null,
    });
    const reserved = ExtensionVerifierService.isReservedName(input.name);
    if (reserved && !verdict.isOfficial) {
      throw new ExtensionMutationError('RESERVED_NAMESPACE', 'lumibase-* requires an official signature.', 400);
    }
    if ((reserved || (this.deps.env?.LUMIBASE_EXT_SIGNATURE_POLICY ?? 'require') !== 'warn') && !verdict.ok) {
      throw new ExtensionMutationError('SIGNATURE_REQUIRED', `Signature check failed: ${verdict.reason}`, 400);
    }
    const [row] = await this.deps.db.insert(extensions).values({
      ...input, key: extensionKey(input), siteId: this.deps.siteId,
      installedBy: this.deps.userId ?? undefined,
      isOfficial: verdict.isOfficial, verifiedAt: verdict.ok ? new Date() : null,
    }).returning();
    if (row) await this.sync(row);
    return row;
  }

  async updateExtension(id: string, raw: Partial<ExtensionInput>) {
    const input = patchSchema(extensionSchema).parse(raw);
    await this.require(patchActions(input));
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
    const [current] = await this.deps.db.select().from(extensions).where(where).limit(1);
    if (!current) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    if (Object.keys(input).length === 0) return current;
    if (input.enabled === true && current.isOfficial && !current.verifiedAt) {
      throw new ExtensionMutationError('SIGNATURE_REQUIRED', 'Cannot enable an unverified official extension.', 400);
    }
    const [row] = await this.deps.db.update(extensions).set(input).where(where).returning();
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    if (input.bundleUrl !== undefined || input.version !== undefined) {
      new ExtensionSandbox({ ...this.deps.env }).evict(row.name);
    }
    await this.sync(row);
    return row;
  }

  private async sync(row: typeof extensions.$inferSelect) {
    try {
      const { syncExtensionCdcSubscription } = await import('../modules/cdc/change-feed/extension-sender');
      await syncExtensionCdcSubscription(this.deps.db, this.deps.siteId, {
        name: row.name, type: row.type, enabled: row.enabled, capabilities: (row.capabilities as string[]) ?? [],
      }, this.deps.cache);
    } catch {
      console.error('[extensions] cdc subscription sync failed');
    }
  }

  async uninstallExtension(id: string) {
    await this.require(['delete']);
    const [row] = await this.deps.db.delete(extensions)
      .where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id))).returning();
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    return { deleted: true, id };
  }
}
