/**
 * Pages CRUD over `lumibase_pages` (delivery page-builder rows).
 *
 * Closes high-load-cache-readiness backlog **B16**: after create / slug rename,
 * call `forgetNegative(negativePageKey…)` so a prior tombstone does not hide
 * the new page until TTL (Req 19.7 / task 22.6).
 *
 * Every write also records an `activity` row (collection `lumibase_pages`) in
 * the same transaction, with the actor and the slug, title and a SHA-256 of
 * the layout before and after (#986). Pages are public, so a page that
 * changed must always be traceable to who changed it.
 */

import { activity, collections, pages, scopeSite, type Database } from '@lumibase/database';
import { isComposerLayout, PageLayoutSchema, type PageLayout } from '@lumibase/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { CacheProvider, EdgeCacheProvider } from '@lumibase/runtime';
import { hasBlocksFields, resolveBlockTemplates } from './blocks';
import { isValidSlug } from './identifier-guard';
import { invalidateDeliverTag } from './content-invalidation';
import { forgetNegative, negativePageKey } from './negative-cache';
import { SchemaService, type CompiledField } from './schema-service';
import { validateItem, type ValidationIssue } from './validation';
import { checkContentIntegrity } from '../modules/content-integrity/monitor';
import type { PermissionService } from './permission-service';

export type PageRow = typeof pages.$inferSelect;

export type CreatePageInput = {
  slug: string;
  title: string;
  layoutConfig?: Record<string, unknown>;
};

export type PatchPageInput = {
  slug?: string;
  title?: string;
  layoutConfig?: Record<string, unknown>;
};

export class PageServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    /** One entry per problem, each with a `field` path (e.g. `sections.0.source.status`). */
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'PageServiceError';
  }
}

/** A registered page block (V06 #684): a collection with `meta.pageBlock: true`. */
export interface PageBlockDefinition {
  name: string;
  label: string | null;
  icon: string | null;
  note: string | null;
  fields: Array<{
    name: string;
    type: string;
    interface: string;
    label: string | null;
    note: string | null;
    required: boolean;
    options: Record<string, unknown>;
  }>;
}

/** Fields a block may not carry: block data is stored in clear in `layoutConfig`. */
function sensitive(field: CompiledField): boolean {
  return field.encrypted || field.classification === 'pii' || field.classification === 'phi';
}

export type PageServiceDeps = {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
  edgeCache?: EdgeCacheProvider | null;
  /** `users.id` of the caller, recorded on activity rows; null for API keys. */
  actorId?: string | null;
  /**
   * The writer's permissions. A section `source` makes a collection's items
   * part of a public page, so the writer must be able to read that collection
   * in full. Omitted only by internal callers (seed, setup), which are trusted.
   */
  permissions?: Pick<PermissionService, 'canAccess'>;
};

/** Collection name recorded on page activity rows (same as the table). */
export const PAGE_ACTIVITY_COLLECTION = 'lumibase_pages';

/** What an activity row records about one side of a page change. */
export type PageSnapshot = { slug: string; title: string; layoutSha256: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Collections named by any section `source`, in any layout shape (v1 or older). */
export function pageSourceCollections(layout: unknown): Set<string> {
  const names = new Set<string>();
  const sections = isRecord(layout) && Array.isArray(layout.sections) ? layout.sections : [];
  for (const section of sections) {
    const source = isRecord(section) ? section.source : undefined;
    if (isRecord(source) && typeof source.collection === 'string' && source.collection) {
      names.add(source.collection);
    }
  }
  return names;
}

/**
 * A section `source` may only ask for published items (#1006), in any layout
 * shape. Public delivery never honours another status, so storing one would
 * only promise drafts the page cannot show; refusing it at write time keeps a
 * stored layout honest about what anonymous readers get. Drafts are previewed
 * through a signed preview token instead (`GET /deliver/preview/:site/page/:slug`).
 */
export function unpublishedSourceIssues(layout: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sections = isRecord(layout) && Array.isArray(layout.sections) ? layout.sections : [];
  sections.forEach((section, index) => {
    const source = isRecord(section) ? section.source : undefined;
    if (!isRecord(source) || !('status' in source)) return;
    if (source.status === 'published') return;
    issues.push({
      field: `sections.${index}.source.status`,
      path: ['sections', index, 'source', 'status'],
      code: 'VALIDATION',
      message:
        'A section source can only deliver published items. Remove "status" or set it to "published"; preview drafts with a preview token.',
    });
  });
  return issues;
}

export class PageService {
  constructor(private readonly deps: PageServiceDeps) {}

  async list(): Promise<PageRow[]> {
    return this.deps.db
      .select()
      .from(pages)
      .where(scopeSite(pages.siteId, this.deps.siteId));
  }

  async getById(id: string): Promise<PageRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), scopeSite(pages.siteId, this.deps.siteId)))
      .limit(1);
    return row ?? null;
  }

  private schema(): SchemaService {
    return new SchemaService({ db: this.deps.db as never, siteId: this.deps.siteId, cache: this.deps.cache });
  }

  /** Names of the site's registered page blocks. */
  private async pageBlockNames(): Promise<string[]> {
    const rows = await this.deps.db
      .select({ name: collections.name })
      .from(collections)
      .where(
        and(
          scopeSite(collections.siteId, this.deps.siteId),
          sql`(${collections.meta}->>'pageBlock') = 'true'`,
        ),
      );
    return rows.map((r) => r.name).sort();
  }

  /** The composer's palette: every registered page block with its fields. */
  async listBlocks(): Promise<PageBlockDefinition[]> {
    const schema = this.schema();
    const out: PageBlockDefinition[] = [];
    for (const name of await this.pageBlockNames()) {
      const compiled = await schema.getCompiled(name);
      if (!compiled) continue;
      out.push({
        name: compiled.name,
        label: compiled.label,
        icon: compiled.icon,
        note: compiled.note,
        fields: compiled.fields
          .filter((f) => !f.hidden && !sensitive(f))
          .map((f) => ({
            name: f.name,
            type: f.type,
            interface: f.interface,
            label: f.label,
            note: f.note,
            required: f.required,
            options: f.options,
          })),
      });
    }
    return out;
  }

  /**
   * Validate a composer (v1) layout: its shape, that every section is a
   * registered page block, each block's data against that block's fields
   * (including nested `blocks` fields), and that every `source.collection`
   * exists. Returns the normalised layout. Older free-form layouts (no
   * `version`) are returned untouched.
   */
  async normaliseLayout(layoutConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isComposerLayout(layoutConfig)) return layoutConfig;
    const parsed = PageLayoutSchema.safeParse(layoutConfig);
    if (!parsed.success) {
      const issues: ValidationIssue[] = parsed.error.issues.map((i) => {
        const path = i.path.filter((p): p is string | number => typeof p !== 'symbol');
        return { field: path.join('.'), code: 'VALIDATION', message: i.message, path };
      });
      throw new PageServiceError('VALIDATION', 'The page layout is not valid.', 400, issues);
    }
    const layout: PageLayout = parsed.data;
    const issues: ValidationIssue[] = [];
    const blockNames = new Set(await this.pageBlockNames());
    const schema = this.schema();
    const compiledCache = new Map<string, Awaited<ReturnType<SchemaService['getCompiled']>>>();
    const compiled = async (name: string) => {
      if (!compiledCache.has(name)) compiledCache.set(name, await schema.getCompiled(name));
      return compiledCache.get(name) ?? null;
    };

    for (const [index, section] of layout.sections.entries()) {
      const at = (...rest: Array<string | number>) => ['sections', index, ...rest];
      if (!blockNames.has(section.component)) {
        issues.push({
          field: at('component').join('.'),
          code: 'UNKNOWN_BLOCK',
          message: `"${section.component}" is not a registered page block.`,
          path: at('component'),
        });
        continue;
      }
      const block = await compiled(section.component);
      if (!block) continue;
      const known = new Map(block.fields.map((f) => [f.name, f]));
      for (const [key, value] of Object.entries(section.data)) {
        const field = known.get(key);
        if (!field) {
          // Same rule as a `blocks` field: block data carries only the block's fields.
          issues.push({
            field: at('data', key).join('.'),
            code: 'UNKNOWN_FIELD',
            message: `Unknown field "${key}" for block "${section.component}".`,
            path: at('data', key),
          });
          continue;
        }
        if (sensitive(field) && value !== null && value !== undefined) {
          issues.push({
            field: at('data', key).join('.'),
            code: 'SENSITIVE_FIELD',
            message: 'Encrypted or pii/phi fields are not supported in page blocks.',
            path: at('data', key),
          });
        }
      }
      const blockTemplates = hasBlocksFields(block.fields)
        ? await resolveBlockTemplates(block.fields, (name) => compiled(name))
        : new Map<string, CompiledField[]>();
      const result = validateItem(block.fields, section.data, { blockTemplates });
      if (!result.ok) {
        for (const issue of result.issues) {
          const rest = issue.path ?? issue.field.split('.');
          issues.push({ ...issue, field: at('data', ...rest).join('.'), path: at('data', ...rest) });
        }
      } else {
        section.data = result.data;
      }
      if (section.source && !(await compiled(section.source.collection))) {
        issues.push({
          field: at('source', 'collection').join('.'),
          code: 'UNKNOWN_COLLECTION',
          message: `Collection "${section.source.collection}" does not exist.`,
          path: at('source', 'collection'),
        });
      }
    }
    if (issues.length > 0) throw new PageServiceError('VALIDATION', 'The page layout is not valid.', 400, issues);
    return layout as unknown as Record<string, unknown>;
  }

  async create(input: CreatePageInput): Promise<PageRow> {
    this.assertSlug(input.slug);
    const layoutConfig = input.layoutConfig ? await this.normaliseLayout(input.layoutConfig) : {};
    if (!input.title.trim()) {
      throw new PageServiceError('VALIDATION', 'title is required');
    }
    this.assertPublishedSources(input.layoutConfig);
    await this.assertSourcesReadable(input.layoutConfig, undefined);

    const id = nanoid();
    try {
      const row = await this.deps.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(pages)
          .values({
            id,
            siteId: this.deps.siteId,
            slug: input.slug,
            title: input.title.trim(),
            layoutConfig,
          })
          .returning();
        if (!inserted) {
          throw new PageServiceError('INTERNAL', 'Insert returned no row', 400);
        }
        await this.recordActivity(tx, 'create', inserted.id, { after: await snapshot(inserted) });
        return inserted;
      });
      await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, row.slug));
      await this.purgeDelivery();
      await this.integrityCheck(row);
      return row;
    } catch (err) {
      this.rethrowUnique(err);
      throw err;
    }
  }

  async patch(id: string, input: PatchPageInput): Promise<PageRow> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new PageServiceError('NOT_FOUND', 'Page not found.', 404);
    }

    const previousSlug = existing.slug;
    const nextSlug = input.slug ?? previousSlug;
    if (input.slug !== undefined) this.assertSlug(input.slug);
    if (input.title !== undefined && !input.title.trim()) {
      throw new PageServiceError('VALIDATION', 'title is required');
    }
    const layoutConfig = input.layoutConfig !== undefined ? await this.normaliseLayout(input.layoutConfig) : undefined;
    if (input.layoutConfig !== undefined) {
      this.assertPublishedSources(input.layoutConfig);
      await this.assertSourcesReadable(input.layoutConfig, existing.layoutConfig);
    }

    // Snapshot before the update: drizzle/mocks may mutate the same row object.
    const before = await snapshot(existing);
    try {
      const row = await this.deps.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(pages)
          .set({
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(layoutConfig !== undefined ? { layoutConfig } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(pages.id, id), scopeSite(pages.siteId, this.deps.siteId)))
          .returning();
        if (!updated) {
          throw new PageServiceError('NOT_FOUND', 'Page not found.', 404);
        }
        await this.recordActivity(tx, 'update', updated.id, { before, after: await snapshot(updated) });
        return updated;
      });

      // Forget new slug always; also clear the old slug tombstone on rename.
      // Capture previousSlug before update — drizzle/mocks may mutate the same row object.
      await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, nextSlug));
      if (previousSlug !== nextSlug) {
        await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, previousSlug));
      }
      await this.purgeDelivery();
      if (input.layoutConfig !== undefined) await this.integrityCheck(row);
      return row;
    } catch (err) {
      this.rethrowUnique(err);
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new PageServiceError('NOT_FOUND', 'Page not found.', 404);
    }
    const before = await snapshot(existing);
    await this.deps.db.transaction(async (tx) => {
      await tx
        .delete(pages)
        .where(and(eq(pages.id, id), scopeSite(pages.siteId, this.deps.siteId)));
      await this.recordActivity(tx, 'delete', id, { before });
    });
    // Do not write a tombstone here — deliver miss path owns setNegative.
    await this.purgeDelivery();
  }

  /**
   * Drop this site's cached page payloads (app cache and edge) after a page
   * write, so `/deliver/page` serves the new layout instead of the cached one
   * for up to its TTL. Best-effort, like every other delivery purge.
   */
  private async purgeDelivery(): Promise<void> {
    try {
      await invalidateDeliverTag(this.deps.cache, this.deps.siteId, this.deps.edgeCache);
    } catch {
      // never fail the write over a cache purge
    }
  }

  private assertPublishedSources(layout: unknown): void {
    const issues = unpublishedSourceIssues(layout);
    if (issues.length > 0) {
      throw new PageServiceError('VALIDATION', issues[0]!.message, 400, issues);
    }
  }

  /**
   * Content-integrity scan of a page that just went live (#989). Pages have no
   * draft state, so this only alerts (audit `content_integrity_alert`), even
   * under the `unpublish` policy. Never throws.
   */
  private async integrityCheck(row: PageRow): Promise<void> {
    await checkContentIntegrity(
      {
        db: this.deps.db,
        siteId: this.deps.siteId,
        actor: this.deps.actorId ? { type: 'user', userId: this.deps.actorId } : { type: 'api_key' },
      },
      { collection: PAGE_ACTIVITY_COLLECTION, itemId: row.id, content: { title: row.title, layoutConfig: row.layoutConfig }, firstPublish: false },
    );
  }

  private async recordActivity(
    tx: Pick<Database, 'insert'>,
    action: 'create' | 'update' | 'delete',
    pageId: string,
    payload: { before?: PageSnapshot; after?: PageSnapshot },
  ): Promise<void> {
    await tx.insert(activity).values({
      siteId: this.deps.siteId,
      action,
      userId: this.deps.actorId ?? null,
      collection: PAGE_ACTIVITY_COLLECTION,
      itemId: pageId,
      payload,
    });
  }

  /**
   * Every collection a layout newly binds through a section `source` must be
   * readable by the writer in full: a read permission on every field with no
   * row filter. Delivery serves those items to anyone, so a narrower grant
   * would let the writer publish what they cannot read themselves. Sources the
   * page already had are not re-checked, so an editor can still change a page
   * an administrator bound to a collection.
   */
  private async assertSourcesReadable(next: unknown, previous: unknown): Promise<void> {
    const permissions = this.deps.permissions;
    if (!permissions) return;
    const before = pageSourceCollections(previous);
    for (const name of pageSourceCollections(next)) {
      if (before.has(name)) continue;
      const perm = await permissions.canAccess(name, 'read');
      const allFields = !!perm && perm.fields.length === 1 && perm.fields[0] === '*';
      const allRows = !!perm && (perm.rule === null || (isRecord(perm.rule) && Object.keys(perm.rule).length === 0));
      if (!allFields || !allRows) {
        throw new PageServiceError(
          'SOURCE_FORBIDDEN',
          `A page section can only take its data from a collection you can read in full (every field and every row): "${name}".`,
          403,
        );
      }
    }
  }

  private assertSlug(slug: string): void {
    if (!isValidSlug(slug)) {
      throw new PageServiceError(
        'VALIDATION',
        'slug must match delivery slug shape (lowercase segments, / _ - separators, ≤200).',
      );
    }
  }

  private rethrowUnique(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(message)) {
      throw new PageServiceError('CONFLICT', 'A page with this slug already exists on the site.', 409);
    }
  }
}

/** Slug, title and a SHA-256 of the canonical layout JSON. */
export async function snapshot(row: Pick<PageRow, 'slug' | 'title' | 'layoutConfig'>): Promise<PageSnapshot> {
  return { slug: row.slug, title: row.title, layoutSha256: await sha256Hex(canonicalJson(row.layoutConfig ?? {})) };
}

/** JSON with object keys sorted, so equal layouts hash equally. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
