import {
  scopeSite,
  settings,
  translations,
  webhooks,
  type Database,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Thin, tenant-scoped service over delivery-configuration tables (settings,
 * translations, webhooks), used by the governed AI harness so config skills are
 * audited + autonomy-gated like any other tool. Mirrors the REST route logic.
 */
export interface ConfigServiceDeps {
  db: Database;
  siteId: string;
}

export class ConfigService {
  constructor(private readonly deps: ConfigServiceDeps) {}

  // ── Settings (keyed KV, POST = upsert) ────────────────────────────────────
  listSettings(scope?: string) {
    return this.deps.db
      .select()
      .from(settings)
      .where(and(scopeSite(settings.siteId, this.deps.siteId), scope ? eq(settings.scope, scope) : undefined));
  }

  async upsertSetting(input: { key: string; value: Record<string, unknown>; scope?: string }) {
    const [row] = await this.deps.db
      .insert(settings)
      .values({ siteId: this.deps.siteId, key: input.key, value: input.value, scope: input.scope })
      .onConflictDoUpdate({
        target: [settings.siteId, settings.key],
        set: { value: input.value, scope: input.scope, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async deleteSetting(key: string) {
    await this.deps.db
      .delete(settings)
      .where(and(eq(settings.key, key), scopeSite(settings.siteId, this.deps.siteId)));
    return { deleted: true, key };
  }

  // ── Translations ──────────────────────────────────────────────────────────
  listTranslations(filter?: { namespace?: string; language?: string }) {
    return this.deps.db
      .select()
      .from(translations)
      .where(
        and(
          scopeSite(translations.siteId, this.deps.siteId),
          filter?.namespace ? eq(translations.namespace, filter.namespace) : undefined,
          filter?.language ? eq(translations.language, filter.language) : undefined,
        ),
      );
  }

  async createTranslation(input: { language: string; namespace: string; key: string; value: string; status?: string }) {
    const [row] = await this.deps.db
      .insert(translations)
      .values({ siteId: this.deps.siteId, ...input })
      .returning();
    return row;
  }

  async updateTranslation(id: string, patch: Partial<{ language: string; namespace: string; key: string; value: string; status: string }>) {
    const [row] = await this.deps.db
      .update(translations)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(translations.id, id), scopeSite(translations.siteId, this.deps.siteId)))
      .returning();
    if (!row) throw new Error('TRANSLATION_NOT_FOUND');
    return row;
  }

  async deleteTranslation(id: string) {
    await this.deps.db
      .delete(translations)
      .where(and(eq(translations.id, id), scopeSite(translations.siteId, this.deps.siteId)));
    return { deleted: true, id };
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────
  listWebhooks() {
    return this.deps.db.select().from(webhooks).where(eq(webhooks.siteId, this.deps.siteId));
  }

  async createWebhook(input: {
    name: string;
    url: string;
    actions?: string[];
    collections?: string[];
    headers?: Record<string, string>;
    status?: 'active' | 'inactive';
    secret?: string | null;
  }) {
    const [row] = await this.deps.db
      .insert(webhooks)
      .values({ siteId: this.deps.siteId, ...input })
      .returning();
    return row;
  }

  async updateWebhook(id: string, patch: Record<string, unknown>) {
    const [row] = await this.deps.db
      .update(webhooks)
      .set(patch)
      .where(and(eq(webhooks.siteId, this.deps.siteId), eq(webhooks.id, id)))
      .returning();
    if (!row) throw new Error('WEBHOOK_NOT_FOUND');
    return row;
  }

  async deleteWebhook(id: string) {
    await this.deps.db
      .delete(webhooks)
      .where(and(eq(webhooks.siteId, this.deps.siteId), eq(webhooks.id, id)));
    return { deleted: true, id };
  }
}
