/**
 * config-export-service.ts — load a site's schema config from the database and
 * serialize it to a {@link ConfigManifest}. The DB-free serialization lives in
 * `config-serialize.ts`; this service only handles loading (scoped by site) and
 * delegating. Symmetric with `access-export.ts`.
 */

import { asc } from 'drizzle-orm';
import {
  collections,
  fields,
  relations,
  scopeSite,
  settings,
  webhooks,
  type Database,
} from '@lumibase/database';
import type { ConfigManifest } from '@lumibase/shared/schemas';
import {
  serializeConfig,
  type ConfigState,
  type SerializeOptions,
} from './config-serialize';

export interface ConfigExportServiceDeps {
  db: Database;
  siteId: string;
}

export class ConfigExportService {
  constructor(private readonly deps: ConfigExportServiceDeps) {}

  /** Load the full config state for the site, scoped by `site_id`. */
  async loadState(): Promise<ConfigState> {
    const { db, siteId } = this.deps;

    const [collectionRows, relationRows, webhookRows, settingRows] = await Promise.all([
      db.select().from(collections).where(scopeSite(collections.siteId, siteId)).orderBy(asc(collections.name)),
      db.select().from(relations).where(scopeSite(relations.siteId, siteId)),
      db.select().from(webhooks).where(scopeSite(webhooks.siteId, siteId)),
      db.select().from(settings).where(scopeSite(settings.siteId, siteId)),
    ]);

    // Fields carry the collection's id, not name; join to the (typically small)
    // collection set in memory so the manifest can key by `collection.field`.
    const fieldRows = await db
      .select()
      .from(fields)
      .where(scopeSite(fields.siteId, siteId));
    const collectionNameById = new Map(collectionRows.map((c) => [c.id, c.name]));

    return {
      collections: collectionRows,
      fields: fieldRows.map((f) => ({
        ...f,
        collection: collectionNameById.get(f.collectionId) ?? '',
      })),
      relations: relationRows,
      webhooks: webhookRows,
      settings: settingRows,
    };
  }

  /** Build the manifest. `exportedAt` is supplied by the caller (route layer). */
  async export(opts: SerializeOptions = {}): Promise<ConfigManifest> {
    const state = await this.loadState();
    return serializeConfig(state, opts);
  }
}
