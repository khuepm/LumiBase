/**
 * Pages CRUD over `lumibase_pages` (delivery page-builder rows).
 *
 * Closes high-load-cache-readiness backlog **B16**: after create / slug rename,
 * call `forgetNegative(negativePageKey…)` so a prior tombstone does not hide
 * the new page until TTL (Req 19.7 / task 22.6).
 */

import { pages, scopeSite, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { CacheProvider } from '@lumibase/runtime';
import { isValidSlug } from './identifier-guard';
import { forgetNegative, negativePageKey } from './negative-cache';

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
  ) {
    super(message);
    this.name = 'PageServiceError';
  }
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

  async create(input: CreatePageInput): Promise<PageRow> {
    this.assertSlug(input.slug);
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
          layoutConfig: input.layoutConfig ?? {},
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

    try {
      const [row] = await this.deps.db
        .update(pages)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.layoutConfig !== undefined ? { layoutConfig: input.layoutConfig } : {}),
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
