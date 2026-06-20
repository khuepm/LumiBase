import { extensions, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Thin, tenant-scoped service over the `extensions` table for the governed AI
 * harness. Mirrors the install/update/uninstall route logic (minus the
 * per-action permission probes the route applies on top). Marketplace install
 * (bundle fetch + signature verification) is intentionally NOT exposed here —
 * it stays on the standalone MCP server.
 */
export interface ExtensionsServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
}

export interface ExtensionInput {
  key?: string;
  name: string;
  version: string;
  type: string;
  enabled?: boolean;
  bundleUrl: string;
  manifest?: Record<string, string>;
  capabilities?: string[];
}

function extensionKey(input: { key?: string | null; name: string }): string {
  return (
    input.key?.trim() ||
    input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

export class ExtensionsService {
  constructor(private readonly deps: ExtensionsServiceDeps) {}

  listExtensions() {
    return this.deps.db.select().from(extensions).where(eq(extensions.siteId, this.deps.siteId));
  }

  async installExtension(input: ExtensionInput) {
    const [row] = await this.deps.db
      .insert(extensions)
      .values({
        ...input,
        key: extensionKey(input),
        siteId: this.deps.siteId,
        installedBy: this.deps.userId ?? undefined,
      })
      .returning();
    return row;
  }

  async updateExtension(id: string, patch: Partial<ExtensionInput>) {
    const [row] = await this.deps.db
      .update(extensions)
      .set(patch)
      .where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id)))
      .returning();
    if (!row) throw new Error('EXTENSION_NOT_FOUND');
    return row;
  }

  async uninstallExtension(id: string) {
    await this.deps.db
      .delete(extensions)
      .where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id)));
    return { deleted: true, id };
  }
}
