/**
 * Duplicate / save-as-copy (#689).
 *
 * Built only on ItemService's public API, so the copy goes through exactly the
 * same gates as a hand-made item: the source is read with the caller's `read`
 * permission (fields the caller cannot read are not copied), every new row is
 * written with `create` — row rules, presets, validation, hooks, the creation
 * revision, the activity row, CDC and realtime all apply.
 *
 * What a copy is:
 *
 * - **Draft.** The copy is always `draft` with no publish window and no
 *   publication stamps (a copy has never been published).
 * - **Unique fields reset.** A string field marked `unique` (or a field named
 *   `slug`) gets a ` -copy` suffix — `my-post-copy`, then `my-post-copy-2`, … —
 *   chosen against the live rows of the collection. Any other unique value
 *   (number, object) is dropped so the copy does not clash.
 * - **Relations.** `relations: 'reference'` (default) copies m2m links (the
 *   copy points at the same targets); m2o foreign keys are plain data and are
 *   always kept. `'deep'` additionally copies one level of o2m children,
 *   re-parented onto the copy (their own unique fields reset the same way).
 *   `'none'` copies the item alone.
 * - **Translations.** `translations: false` keeps only the `locale` (default:
 *   the site's default locale) of every `translatable-text` field.
 * - **Audit.** One `item_duplicated` audit event names the source and the copy.
 */
import { and, eq, or } from 'drizzle-orm';
import { relations, scopeSite, settings, type Database } from '@lumibase/database';
import { AuditLogger } from '../modules/audit/logger';
import { ItemServiceError, type ItemRow, type ItemService } from './item-service';
import type { SchemaService } from './schema-service';

export type DuplicateRelationsMode = 'none' | 'reference' | 'deep';

export interface DuplicateOptions {
  relations?: DuplicateRelationsMode;
  /** Keep every locale of translatable fields (default `true`). */
  translations?: boolean;
  /** Locale kept when `translations` is false; defaults to the site default. */
  locale?: string;
  /** Field values to override on the copy (applied last). */
  overrides?: Record<string, unknown>;
}

export interface DuplicateResult {
  item: ItemRow;
  sourceId: string;
  /** Ids of copied o2m children (`deep`) and m2m junction rows, per collection. */
  related: Record<string, string[]>;
}

export interface DuplicateDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  items: ItemService;
  schema: SchemaService;
  /** Max related rows copied per relation (bounded work per request). */
  maxRelated?: number;
}

const TRANSLATABLE_INTERFACE = 'translatable-text';
const DEFAULT_MAX_RELATED = 200;
const MAX_SUFFIX_ATTEMPTS = 50;

/** `title` → `title-copy`, `title-copy` → `title-copy-2`, `title-copy-2` → `title-copy-3`. */
export function nextCopyValue(value: string, attempt: number): string {
  const base = value.replace(/-copy(?:-\d+)?$/, '');
  return attempt <= 1 ? `${base}-copy` : `${base}-copy-${attempt}`;
}

function isUniqueField(f: { name: string; unique: boolean; interface: string }): boolean {
  return f.unique || f.name === 'slug' || f.interface === 'slug';
}

export class ItemDuplicateService {
  constructor(private readonly deps: DuplicateDeps) {}

  async duplicate(collection: string, id: string, opts: DuplicateOptions = {}): Promise<DuplicateResult> {
    const mode = opts.relations ?? 'reference';
    const source = (await this.deps.items.detail(collection, id)) as ItemRow;
    const data = await this.prepareData(collection, source.data ?? {}, opts);
    const created = (await this.deps.items.create(collection, {
      data: { ...data, ...(opts.overrides ?? {}) },
      status: 'draft',
      ...(source.parentId ? { parentId: source.parentId } : {}),
    })) as ItemRow;

    const related: Record<string, string[]> = {};
    if (mode !== 'none') {
      await this.copyRelations(collection, id, created.id, mode, opts, related);
    }

    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'item_duplicated',
      requestId: null,
      metadata: {
        collection,
        sourceId: id,
        itemId: created.id,
        userId: this.deps.userId ?? null,
        relations: mode,
        related,
      },
    });
    return { item: created, sourceId: id, related };
  }

  /** Copy of `data` with unique fields reset and translations filtered. */
  private async prepareData(
    collection: string,
    data: Record<string, unknown>,
    opts: DuplicateOptions,
  ): Promise<Record<string, unknown>> {
    const compiled = await this.deps.schema.getCompiled(collection);
    const out: Record<string, unknown> = structuredClone(data);
    if (!compiled) return out;
    // A user-supplied primary key lives in data; the copy needs its own id.
    if (compiled.primaryKeyField && compiled.primaryKeyField !== 'id') delete out[compiled.primaryKeyField];
    const keepLocale = opts.translations === false ? opts.locale ?? (await this.defaultLocale()) : null;
    for (const field of compiled.fields) {
      if (!(field.name in out)) continue;
      const value = out[field.name];
      if (keepLocale && field.interface === TRANSLATABLE_INTERFACE && value && typeof value === 'object' && !Array.isArray(value)) {
        const kept = (value as Record<string, unknown>)[keepLocale];
        out[field.name] = kept === undefined ? {} : { [keepLocale]: kept };
      }
      if (!isUniqueField(field)) continue;
      if (typeof value === 'string' && value.length > 0) {
        out[field.name] = await this.freeCopyValue(collection, field.name, value);
      } else {
        delete out[field.name];
      }
    }
    return out;
  }

  /** First `-copy[-n]` candidate no live row of the collection holds. */
  private async freeCopyValue(collection: string, field: string, value: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_SUFFIX_ATTEMPTS; attempt += 1) {
      const candidate = nextCopyValue(value, attempt);
      const taken = await this.deps.items.list(collection, {
        filter: { [field]: { _eq: candidate } },
        limit: 1,
        withTotal: false,
      });
      if (taken.data.length === 0) return candidate;
    }
    throw new ItemServiceError(
      'DUPLICATE_UNIQUE_EXHAUSTED',
      `Could not find a free value for "${field}" after ${MAX_SUFFIX_ATTEMPTS} attempts.`,
      409,
    );
  }

  private async copyRelations(
    collection: string,
    sourceId: string,
    copyId: string,
    mode: DuplicateRelationsMode,
    opts: DuplicateOptions,
    related: Record<string, string[]>,
  ): Promise<void> {
    const rels = await this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          or(eq(relations.manyCollection, collection), eq(relations.oneCollection, collection)),
        ),
      );
    const limit = this.deps.maxRelated ?? DEFAULT_MAX_RELATED;
    for (const rel of rels) {
      // m2m: copy the junction rows so the copy links the same targets.
      if (
        rel.type === 'm2m' &&
        rel.manyCollection === collection &&
        rel.junctionCollection &&
        rel.junctionManyField
      ) {
        const junction = rel.junctionCollection;
        const rows = await this.childrenOf(junction, rel.junctionManyField, sourceId, limit);
        for (const row of rows) {
          const copy = await this.deps.items.create(junction, {
            data: { ...stripIds(row.data ?? {}), [rel.junctionManyField]: copyId },
          });
          (related[junction] ??= []).push((copy as ItemRow).id);
        }
        continue;
      }
      // o2m (deep only): copy one level of children onto the copy.
      if (mode === 'deep' && rel.type === 'o2m' && rel.oneCollection === collection) {
        const child = rel.manyCollection;
        const rows = await this.childrenOf(child, rel.manyField, sourceId, limit);
        for (const row of rows) {
          const data = await this.prepareData(child, row.data ?? {}, opts);
          const copy = await this.deps.items.create(child, {
            data: { ...data, [rel.manyField]: copyId },
            status: 'draft',
          });
          (related[child] ??= []).push((copy as ItemRow).id);
        }
      }
    }
  }

  private async childrenOf(collection: string, field: string, parentId: string, limit: number): Promise<ItemRow[]> {
    const res = await this.deps.items.list(collection, {
      filter: { [field]: { _eq: parentId } },
      limit,
      withTotal: false,
    });
    return res.data as ItemRow[];
  }

  private async defaultLocale(): Promise<string> {
    const [row] = await this.deps.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, 'locales'), scopeSite(settings.siteId, this.deps.siteId)))
      .limit(1);
    const value = row?.value as { default?: unknown; supported?: unknown } | undefined;
    if (typeof value?.default === 'string') return value.default;
    if (Array.isArray(value?.supported) && typeof value.supported[0] === 'string') return value.supported[0];
    return 'en';
  }
}

/** Data copied from a junction row, minus any id-like key the row might carry. */
function stripIds(data: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = data;
  return rest;
}
