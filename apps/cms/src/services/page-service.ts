/**
 * Pages CRUD over `lumibase_pages` (delivery page-builder rows).
 *
 * Closes high-load-cache-readiness backlog **B16**: after create / slug rename,
 * call `forgetNegative(negativePageKey…)` so a prior tombstone does not hide
 * the new page until TTL (Req 19.7 / task 22.6).
 */

import { collections, pages, scopeSite, type Database } from '@lumibase/database';
import { isComposerLayout, PageLayoutSchema, type PageLayout } from '@lumibase/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { CacheProvider } from '@lumibase/runtime';
import { hasBlocksFields, resolveBlockTemplates } from './blocks';
import { isValidSlug } from './identifier-guard';
import { forgetNegative, negativePageKey } from './negative-cache';
import { SchemaService, type CompiledField } from './schema-service';
import { validateItem, type ValidationIssue } from './validation';

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
    readonly status: 400 | 404 | 409 = 400,
    /** Per-path problems of a rejected composer layout. */
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
};

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

    const id = nanoid();
    try {
      const [row] = await this.deps.db
        .insert(pages)
        .values({
          id,
          siteId: this.deps.siteId,
          slug: input.slug,
          title: input.title.trim(),
          layoutConfig,
        })
        .returning();
      if (!row) {
        throw new PageServiceError('INTERNAL', 'Insert returned no row', 400);
      }
      await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, row.slug));
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

    try {
      const [row] = await this.deps.db
        .update(pages)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(layoutConfig !== undefined ? { layoutConfig } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(pages.id, id), scopeSite(pages.siteId, this.deps.siteId)))
        .returning();
      if (!row) {
        throw new PageServiceError('NOT_FOUND', 'Page not found.', 404);
      }

      // Forget new slug always; also clear the old slug tombstone on rename.
      // Capture previousSlug before update — drizzle/mocks may mutate the same row object.
      await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, nextSlug));
      if (previousSlug !== nextSlug) {
        await forgetNegative(this.deps.cache, negativePageKey(this.deps.siteId, previousSlug));
      }
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
    await this.deps.db
      .delete(pages)
      .where(and(eq(pages.id, id), scopeSite(pages.siteId, this.deps.siteId)));
    // Do not write a tombstone here — deliver miss path owns setNegative.
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
