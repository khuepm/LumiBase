import { and, asc, count, desc, eq } from 'drizzle-orm';
import {
  backendTemplateRevisions,
  backendTemplates,
  type Database,
} from '@lumibase/database';
import {
  SEMVER_RE,
  TEMPLATE_FORMAT_VERSION,
  TEMPLATE_SLUG_RE,
  canonicalTemplate,
  ingestTemplateJson,
  templateDigest,
  validateBackendTemplate,
  type BackendTemplate,
  type SeedRecord,
  type TemplateError,
} from '@lumibase/contracts/backend-templates';
import type { CollectionConfig, ConfigManifest, FieldConfig, RelationConfig } from '@lumibase/contracts/schemas';
import { ConfigExportService } from '../config-export-service';
import { OFFICIAL_TEMPLATES } from './official';

/**
 * Private backend template catalog of one site (#902, BT02).
 *
 * - Drafts are editable JSON documents with an optimistic `draftRevision`: an
 *   edit must name the revision it read; a stale edit is a conflict, never a
 *   lost update.
 * - Publishing validates the whole draft, canonicalises it and stores an
 *   immutable, content-addressed revision per `templateVersion`. Republishing
 *   identical content returns the existing revision; different content under
 *   the same version is refused.
 * - Capture builds a draft from the site's own schema: only the collections
 *   asked for, refusing (not silently widening) when they depend on others.
 *   It reads no item unless seed capture is requested, and then only through
 *   the caller's own item permissions.
 *
 * Every query is filtered by `siteId`; official templates are read-only code
 * assets (see `official.ts`).
 */

export type CatalogErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'DRAFT_CONFLICT'
  | 'IMMUTABLE_REVISION'
  | 'MISSING_DEPENDENCY'
  | 'INVALID_TEMPLATE';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 422,
    readonly details?: { errors?: TemplateError[]; missing?: string[] },
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export interface TemplateSummary {
  id: string;
  source: 'site' | 'official';
  slug: string;
  displayName: string;
  draftRevision: number | null;
  versions: string[];
  updatedAt: Date | null;
}

export interface RevisionSummary {
  id: string;
  templateVersion: string;
  digest: string;
  publishedBy: string | null;
  createdAt: Date;
}

export interface TemplateDetail extends TemplateSummary {
  draft: unknown;
  validation: { ok: true } | { ok: false; errors: TemplateError[] };
  revisions: RevisionSummary[];
}

/** Reads items with the CALLER's permissions (caller-aware ItemService). */
export interface CaptureItemReader {
  list(collection: string, limit: number): Promise<Array<Record<string, unknown>>>;
}

export interface CaptureInput {
  collections: string[];
  slug: string;
  displayName: string;
  templateVersion?: string;
  description?: string;
  /** SemVer range written into `compatibility.cmsVersionRange`. */
  cmsVersionRange: string;
  /** Opt-in seed capture. Omitted = schema only; no item is read. */
  seed?: { pack?: string; collections: string[]; maxRecordsPerCollection?: number };
}

const SEED_CAPTURE_DEFAULT_PER_COLLECTION = 100;
/** Field types never captured as seed values (credentials and secrets). */
const UNCAPTURED_TYPES = new Set(['hash', 'alias']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function draftIdentity(draft: unknown): { slug: string; displayName: string } {
  const doc = asRecord(draft);
  const slug = doc?.['slug'];
  const displayName = doc?.['displayName'];
  if (typeof slug !== 'string' || !TEMPLATE_SLUG_RE.test(slug) || slug.length > 64) {
    throw new CatalogError('VALIDATION', 'The document needs a kebab-case "slug" (max 64).', 400);
  }
  if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 120) {
    throw new CatalogError('VALIDATION', 'The document needs a "displayName" (1–120 characters).', 400);
  }
  return { slug, displayName: displayName.trim() };
}

/** Raw JSON text goes through strict ingestion (duplicate keys, size, depth). */
function readDocument(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const ingested = ingestTemplateJson(input);
  if (!ingested.ok) {
    throw new CatalogError('INVALID_TEMPLATE', 'The document is not acceptable JSON.', 422, { errors: ingested.errors });
  }
  return ingested.value;
}

export class BackendTemplateCatalogService {
  constructor(private readonly deps: { db: Database; siteId: string; userId?: string | null }) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(params: { limit?: number; offset?: number } = {}): Promise<{ data: TemplateSummary[]; meta: { total: number; limit: number; offset: number } }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);
    const { db, siteId } = this.deps;
    const [rows, [total]] = await Promise.all([
      db.select().from(backendTemplates).where(eq(backendTemplates.siteId, siteId)).orderBy(asc(backendTemplates.slug)).limit(limit).offset(offset),
      db.select({ n: count() }).from(backendTemplates).where(eq(backendTemplates.siteId, siteId)),
    ]);
    const versions = await this.versionsByTemplate(rows.map((r) => r.id));
    return {
      data: rows.map((r) => ({
        id: r.id,
        source: 'site',
        slug: r.slug,
        displayName: r.displayName,
        draftRevision: r.draftRevision,
        versions: versions.get(r.id) ?? [],
        updatedAt: r.updatedAt,
      })),
      meta: { total: Number(total?.n ?? 0), limit, offset },
    };
  }

  /** Read-only official templates bundled with this build. */
  listOfficial(): TemplateSummary[] {
    return OFFICIAL_TEMPLATES.map((t) => ({
      id: `official:${t.slug}@${t.templateVersion}`,
      source: 'official',
      slug: t.slug,
      displayName: t.displayName,
      draftRevision: null,
      versions: [t.templateVersion],
      updatedAt: null,
    }));
  }

  private async versionsByTemplate(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await this.deps.db
      .select({ templateId: backendTemplateRevisions.templateId, version: backendTemplateRevisions.templateVersion })
      .from(backendTemplateRevisions)
      .where(eq(backendTemplateRevisions.siteId, this.deps.siteId))
      .orderBy(asc(backendTemplateRevisions.createdAt));
    for (const row of rows) {
      if (!ids.includes(row.templateId)) continue;
      out.set(row.templateId, [...(out.get(row.templateId) ?? []), row.version]);
    }
    return out;
  }

  /** By id or slug, within this site only. */
  private async row(idOrSlug: string) {
    const { db, siteId } = this.deps;
    const [byId] = await db.select().from(backendTemplates)
      .where(and(eq(backendTemplates.siteId, siteId), eq(backendTemplates.id, idOrSlug))).limit(1);
    if (byId) return byId;
    const [bySlug] = await db.select().from(backendTemplates)
      .where(and(eq(backendTemplates.siteId, siteId), eq(backendTemplates.slug, idOrSlug))).limit(1);
    return bySlug ?? null;
  }

  private async mustRow(idOrSlug: string) {
    const row = await this.row(idOrSlug);
    if (!row) throw new CatalogError('NOT_FOUND', 'Template not found.', 404);
    return row;
  }

  async get(idOrSlug: string): Promise<TemplateDetail> {
    const row = await this.mustRow(idOrSlug);
    const revisions = await this.deps.db
      .select({
        id: backendTemplateRevisions.id,
        templateVersion: backendTemplateRevisions.templateVersion,
        digest: backendTemplateRevisions.digest,
        publishedBy: backendTemplateRevisions.publishedBy,
        createdAt: backendTemplateRevisions.createdAt,
      })
      .from(backendTemplateRevisions)
      .where(and(eq(backendTemplateRevisions.siteId, this.deps.siteId), eq(backendTemplateRevisions.templateId, row.id)))
      .orderBy(desc(backendTemplateRevisions.createdAt));
    const validation = validateBackendTemplate(row.draft);
    return {
      id: row.id,
      source: 'site',
      slug: row.slug,
      displayName: row.displayName,
      draftRevision: row.draftRevision,
      versions: revisions.map((r) => r.templateVersion).reverse(),
      updatedAt: row.updatedAt,
      draft: row.draft,
      validation: validation.ok ? { ok: true } : { ok: false, errors: validation.errors },
      revisions,
    };
  }

  /** The published (canonical) document of one revision — the export. */
  async getRevision(idOrSlug: string, version: string): Promise<{ revision: RevisionSummary; document: BackendTemplate }> {
    const row = await this.mustRow(idOrSlug);
    const [revision] = await this.deps.db
      .select()
      .from(backendTemplateRevisions)
      .where(and(
        eq(backendTemplateRevisions.siteId, this.deps.siteId),
        eq(backendTemplateRevisions.templateId, row.id),
        eq(backendTemplateRevisions.templateVersion, version),
      ))
      .limit(1);
    if (!revision) throw new CatalogError('NOT_FOUND', `Version ${version} of "${row.slug}" is not published.`, 404);
    return {
      revision: {
        id: revision.id,
        templateVersion: revision.templateVersion,
        digest: revision.digest,
        publishedBy: revision.publishedBy,
        createdAt: revision.createdAt,
      },
      document: revision.document as BackendTemplate,
    };
  }

  // ── Drafts ───────────────────────────────────────────────────────────────

  /** Creates a draft. The draft may be incomplete; `validation` says what is missing. */
  async createDraft(input: unknown): Promise<TemplateDetail> {
    const draft = readDocument(input);
    const { slug, displayName } = draftIdentity(draft);
    const inserted = await this.deps.db
      .insert(backendTemplates)
      .values({ siteId: this.deps.siteId, slug, displayName, draft, createdBy: this.deps.userId ?? null })
      .onConflictDoNothing({ target: [backendTemplates.siteId, backendTemplates.slug] })
      .returning({ id: backendTemplates.id });
    if (inserted.length === 0) {
      throw new CatalogError('CONFLICT', `A template with slug "${slug}" already exists on this site.`, 409);
    }
    return this.get(inserted[0]!.id);
  }

  /**
   * Replaces the draft if — and only if — it is still at `expectedRevision`.
   * Two edits from the same revision: exactly one wins, the other gets
   * DRAFT_CONFLICT and must re-read.
   */
  async updateDraft(idOrSlug: string, input: unknown, expectedRevision: number): Promise<TemplateDetail> {
    const current = await this.mustRow(idOrSlug);
    const draft = readDocument(input);
    const { slug, displayName } = draftIdentity(draft);
    if (slug !== current.slug) {
      throw new CatalogError('VALIDATION', `The slug of a template cannot change ("${current.slug}").`, 400);
    }
    const updated = await this.deps.db
      .update(backendTemplates)
      .set({ draft, displayName, draftRevision: expectedRevision + 1, updatedAt: new Date() })
      .where(and(
        eq(backendTemplates.siteId, this.deps.siteId),
        eq(backendTemplates.id, current.id),
        eq(backendTemplates.draftRevision, expectedRevision),
      ))
      .returning({ id: backendTemplates.id });
    if (updated.length === 0) {
      throw new CatalogError('DRAFT_CONFLICT', 'The draft changed since you read it. Reload it and apply your edit again.', 409);
    }
    return this.get(current.id);
  }

  async validateDraft(idOrSlug: string): Promise<{ ok: true; digest: string } | { ok: false; errors: TemplateError[] }> {
    const row = await this.mustRow(idOrSlug);
    const result = validateBackendTemplate(row.draft);
    return result.ok ? { ok: true, digest: await templateDigest(result.template) } : { ok: false, errors: result.errors };
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  /**
   * Publishes the draft as an immutable revision of its `templateVersion`.
   * @returns `created: false` when the identical content was already published.
   */
  async publish(idOrSlug: string, expectedRevision?: number): Promise<{ created: boolean; revision: RevisionSummary }> {
    const row = await this.mustRow(idOrSlug);
    if (expectedRevision !== undefined && expectedRevision !== row.draftRevision) {
      throw new CatalogError('DRAFT_CONFLICT', 'The draft changed since you read it.', 409);
    }
    const result = validateBackendTemplate(row.draft);
    if (!result.ok) {
      throw new CatalogError('INVALID_TEMPLATE', 'The draft is not a valid template.', 422, { errors: result.errors });
    }
    const document = canonicalTemplate(result.template);
    const digest = await templateDigest(document);
    const version = document.templateVersion;
    const inserted = await this.deps.db
      .insert(backendTemplateRevisions)
      .values({
        siteId: this.deps.siteId,
        templateId: row.id,
        templateVersion: version,
        digest,
        document,
        publishedBy: this.deps.userId ?? null,
      })
      .onConflictDoNothing({
        target: [backendTemplateRevisions.siteId, backendTemplateRevisions.templateId, backendTemplateRevisions.templateVersion],
      })
      .returning();
    const revision = inserted[0] ?? (await this.getRevision(row.id, version)).revision;
    if (!inserted[0] && revision.digest !== digest) {
      throw new CatalogError(
        'IMMUTABLE_REVISION',
        `Version ${version} of "${row.slug}" is already published with different content. Publish a new templateVersion.`,
        409,
      );
    }
    return {
      created: Boolean(inserted[0]),
      revision: {
        id: revision.id,
        templateVersion: revision.templateVersion,
        digest: revision.digest,
        publishedBy: revision.publishedBy,
        createdAt: revision.createdAt,
      },
    };
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  /**
   * Builds a draft from this site's own schema for the named collections.
   * Fails with MISSING_DEPENDENCY (and the full list) when a selected
   * collection relates to one that was not selected. Reads items only when
   * `seed` is given, through `reader` (the caller's own permissions); a
   * denied read fails the whole capture and nothing is stored.
   */
  async capture(input: CaptureInput, reader?: CaptureItemReader): Promise<TemplateDetail> {
    if (!TEMPLATE_SLUG_RE.test(input.slug)) throw new CatalogError('VALIDATION', 'slug must be kebab-case.', 400);
    const templateVersion = input.templateVersion ?? '1.0.0';
    if (!SEMVER_RE.test(templateVersion)) throw new CatalogError('VALIDATION', 'templateVersion must be SemVer.', 400);
    const selected = new Set(input.collections);
    if (selected.size === 0) throw new CatalogError('VALIDATION', 'Select at least one collection.', 400);

    const manifest: ConfigManifest = await new ConfigExportService({ db: this.deps.db, siteId: this.deps.siteId }).export({ scope: 'schema' });
    const known = new Map(manifest.collections.map((c) => [c.name, c]));
    const unknown = [...selected].filter((name) => !known.has(name));
    if (unknown.length > 0) throw new CatalogError('NOT_FOUND', `Unknown collection(s): ${unknown.join(', ')}.`, 404);

    const relations = manifest.relations.filter((r) => selected.has(r.manyCollection));
    const fieldsOf = manifest.fields.filter((f) => selected.has(f.collection));
    const missing = new Set<string>();
    for (const r of relations) {
      if (!selected.has(r.oneCollection)) missing.add(r.oneCollection);
      if (r.junctionCollection && !selected.has(r.junctionCollection)) missing.add(r.junctionCollection);
    }
    // An alias (o2m) field on a selected collection depends on the relation
    // owned by the "many" side; that side must be selected too.
    for (const f of fieldsOf.filter((f) => f.type === 'alias')) {
      const owner = manifest.relations.find((r) => r.oneCollection === f.collection && r.oneField === f.field);
      if (owner && !selected.has(owner.manyCollection)) missing.add(owner.manyCollection);
    }
    if (missing.size > 0) {
      const list = [...missing].sort();
      throw new CatalogError(
        'MISSING_DEPENDENCY',
        `The selected collections depend on collections that were not selected: ${list.join(', ')}. Add them, or select fewer.`,
        422,
        { missing: list },
      );
    }

    const collections: CollectionConfig[] = manifest.collections
      .filter((c) => selected.has(c.name))
      .map(({ ...c }) => c);
    const storageModes = [...new Set(collections.map((c) => c.storageMode ?? 'jsonb'))].sort();

    const document: Record<string, unknown> = {
      formatVersion: TEMPLATE_FORMAT_VERSION,
      slug: input.slug,
      displayName: input.displayName,
      templateVersion,
      ...(input.description ? { description: input.description } : {}),
      compatibility: { cmsVersionRange: input.cmsVersionRange, storageModes },
      config: {
        version: manifest.version,
        collections,
        fields: fieldsOf as FieldConfig[],
        relations: relations as RelationConfig[],
      },
    };

    if (input.seed) {
      if (!reader) throw new CatalogError('VALIDATION', 'Seed capture is not available here.', 400);
      document['seedPacks'] = {
        [input.seed.pack ?? 'captured']: { records: await this.captureSeed(input.seed, selected, fieldsOf, relations, reader) },
      };
    }

    const validation = validateBackendTemplate(document);
    if (!validation.ok) {
      throw new CatalogError('INVALID_TEMPLATE', 'The captured schema cannot be expressed as a portable template.', 422, { errors: validation.errors });
    }
    return this.createDraft(validation.template);
  }

  private async captureSeed(
    seed: NonNullable<CaptureInput['seed']>,
    selected: Set<string>,
    fieldsOf: FieldConfig[],
    relations: RelationConfig[],
    reader: CaptureItemReader,
  ): Promise<SeedRecord[]> {
    const outside = seed.collections.filter((c) => !selected.has(c));
    if (outside.length > 0) {
      throw new CatalogError('VALIDATION', `Seed collections must be among the captured collections: ${outside.join(', ')}.`, 400);
    }
    const limit = Math.min(Math.max(seed.maxRecordsPerCollection ?? SEED_CAPTURE_DEFAULT_PER_COLLECTION, 1), 1000);
    const m2o = new Map(relations.filter((r) => (r.type ?? (r.junctionCollection ? 'm2m' : 'm2o')) === 'm2o').map((r) => [`${r.manyCollection}.${r.manyField}`, r.oneCollection]));

    // Read every collection first: a permission failure aborts before anything is built.
    const rows = new Map<string, Array<Record<string, unknown>>>();
    for (const collection of seed.collections) rows.set(collection, await reader.list(collection, limit));

    const keyOf = new Map<string, string>(); // `${collection}:${id}` → logical key
    for (const [collection, items] of rows) {
      items.forEach((item, i) => keyOf.set(`${collection}:${String(item['id'])}`, `${collection}-${i + 1}`));
    }
    const records: SeedRecord[] = [];
    for (const [collection, items] of rows) {
      const fields = fieldsOf.filter((f) => f.collection === collection);
      items.forEach((item, i) => {
        const values: Record<string, unknown> = {};
        const references: Record<string, string | null> = {};
        for (const f of fields) {
          // Never capture credentials or secrets: hash fields and encrypted fields.
          if (UNCAPTURED_TYPES.has(f.type) || f.encrypted) continue;
          const value = item[f.field];
          if (value === undefined) continue;
          const target = m2o.get(`${collection}.${f.field}`);
          if (target !== undefined) {
            references[f.field] = value === null ? null : keyOf.get(`${target}:${String(value)}`) ?? null;
          } else {
            values[f.field] = value;
          }
        }
        records.push({
          key: `${collection}-${i + 1}`,
          collection,
          values,
          ...(Object.keys(references).length > 0 ? { references } : {}),
        });
      });
    }
    return records;
  }
}
