import { and, eq, inArray } from 'drizzle-orm';
import {
  backendTemplatePlans,
  backendTemplateRevisions,
  backendTemplates,
  type Database,
} from '@lumibase/database';
import {
  TEMPLATE_SUPPORTED_STORAGE_MODES,
  applyNamespace,
  namespaceMap,
  satisfiesVersionRange,
  selectedSeedPack,
  templateDigest,
  validateBackendTemplate,
  type BackendTemplate,
  type TemplateError,
  type TemplatePlanInput,
  type TemplateRef,
} from '@lumibase/contracts/backend-templates';
import { ConfigExportService } from '../config-export-service';
import { OFFICIAL_TEMPLATES } from './official';

/**
 * Install planner (#903, BT03).
 *
 * Plan = resolve an exact template revision → validate → authorize the
 * explicit target and, separately, the source catalog → map the namespace →
 * check storage/runtime/version → inventory conflicts → fingerprint the
 * target → persist an expiring plan. Planning never writes schema or content:
 * the only row it writes is the plan itself (site-scoped to the target).
 *
 * v1 is create-only: a target collection with a template collection's name is
 * a NAME_CONFLICT even when its schema matches. Unrelated collections are left
 * alone.
 */

export const PLAN_TTL_MS = 15 * 60 * 1000;

export type PlanErrorCode =
  | 'MISSING_INPUT'
  | 'SITE_MISMATCH'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_TEMPLATE'
  | 'INVALID_TEMPLATE'
  | 'INCOMPATIBLE_RUNTIME'
  | 'LIMIT_EXCEEDED'
  | 'NAME_CONFLICT'
  | 'STALE_PLAN';

export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly details: { errors?: TemplateError[]; conflicts?: string[]; candidates?: unknown[]; report?: PlanReport } = {},
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface PlanReport {
  template: { source: 'official' | 'site'; sourceSiteId: string | null; slug: string; version: string; digest: string; displayName: string };
  targetSiteId: string;
  namespace: Record<string, string>;
  components: {
    collections: string[];
    fields: number;
    relations: Array<{ from: string; to: string; type: string }>;
  };
  counts: { collections: number; fields: number; relations: number; seedRecords: number };
  seedPack: string | null;
  storage: { modes: string[]; transactional: boolean };
  conflicts: string[];
  /** Existing collections of the target that the install leaves untouched. */
  unrelatedCollections: number;
  warnings: string[];
}

export interface PlannerDeps {
  /** Request-scoped db of the TARGET site. */
  db: Database;
  /** The site of the request; the plan's target must equal it. */
  siteId: string;
  userId?: string | null;
  /** Db scoped to another site (private source catalogs). */
  dbForSite?: (siteId: string) => Database;
  /** Whether the caller may read the catalog of `siteId` (checked independently of the target). */
  canReadSourceCatalog?: (siteId: string) => Promise<boolean>;
  /** Running CMS version (`unknown` when not stamped). */
  cmsVersion?: string;
  /** Whether the runtime can run the install in one transaction. Defaults to probing `db.transaction`. */
  transactional?: boolean;
  supportedStorageModes?: readonly string[];
  official?: readonly BackendTemplate[];
  now?: () => Date;
}

/** sha256 of the target's current schema (collections, fields, relations). */
export async function schemaFingerprint(db: Database, siteId: string): Promise<{ fingerprint: string; collections: string[] }> {
  const manifest = await new ConfigExportService({ db, siteId }).export({ scope: 'schema' });
  const { exportedAt: _ignored, ...stable } = manifest;
  const bytes = new TextEncoder().encode(JSON.stringify(stable));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    fingerprint: `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`,
    collections: manifest.collections.map((c) => c.name),
  };
}

export type PlanRow = typeof backendTemplatePlans.$inferSelect;

export class BackendTemplatePlanner {
  constructor(private readonly deps: PlannerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private transactional(): boolean {
    return this.deps.transactional ?? typeof (this.deps.db as { transaction?: unknown }).transaction === 'function';
  }

  /** Resolves the exact revision the caller named. */
  private async resolve(ref: TemplateRef, targetSiteId: string): Promise<{
    document: BackendTemplate; digest: string; source: 'official' | 'site'; sourceSiteId: string | null;
  }> {
    const official = this.deps.official ?? OFFICIAL_TEMPLATES;
    if (ref.source === 'official') {
      const matches = official.filter((t) => (ref.slug ? t.slug === ref.slug : t.displayName.toLowerCase() === ref.displayName!.toLowerCase()));
      const slugs = [...new Set(matches.map((t) => t.slug))];
      if (slugs.length > 1) {
        throw new PlanError('AMBIGUOUS_TEMPLATE', `"${ref.displayName}" names ${slugs.length} official templates; use a slug.`, 409, { candidates: slugs.map((slug) => ({ source: 'official', slug })) });
      }
      const doc = matches.find((t) => t.templateVersion === ref.version);
      if (!doc) throw new PlanError('NOT_FOUND', `No official template ${ref.slug ?? ref.displayName}@${ref.version}.`, 404);
      return { document: doc, digest: await templateDigest(doc), source: 'official', sourceSiteId: null };
    }

    const sourceSiteId = ref.sourceSiteId ?? targetSiteId;
    if (sourceSiteId !== targetSiteId) {
      // Source and target are separate authorization checks: administering B
      // says nothing about reading A's private catalog. A refusal looks like
      // "not found" so a hidden catalog is not confirmed.
      const allowed = (await this.deps.canReadSourceCatalog?.(sourceSiteId)) ?? false;
      if (!allowed || !this.deps.dbForSite) {
        throw new PlanError('NOT_FOUND', 'Template not found.', 404);
      }
    }
    const db = sourceSiteId === targetSiteId ? this.deps.db : this.deps.dbForSite!(sourceSiteId);
    const templates = await db
      .select({ id: backendTemplates.id, slug: backendTemplates.slug, displayName: backendTemplates.displayName })
      .from(backendTemplates)
      .where(and(
        eq(backendTemplates.siteId, sourceSiteId),
        ref.slug ? eq(backendTemplates.slug, ref.slug) : eq(backendTemplates.displayName, ref.displayName!),
      ));
    if (!ref.slug) {
      // A display name must not silently resolve to the wrong catalog either.
      const officialSame = official.filter((t) => t.displayName.toLowerCase() === ref.displayName!.toLowerCase());
      if (templates.length + new Set(officialSame.map((t) => t.slug)).size > 1) {
        throw new PlanError('AMBIGUOUS_TEMPLATE', `"${ref.displayName}" names more than one template; use a slug and a source.`, 409, {
          candidates: [
            ...templates.map((t) => ({ source: 'site', sourceSiteId, slug: t.slug })),
            ...[...new Set(officialSame.map((t) => t.slug))].map((slug) => ({ source: 'official', slug })),
          ],
        });
      }
    }
    const template = templates[0];
    if (!template) throw new PlanError('NOT_FOUND', 'Template not found.', 404);
    const [revision] = await db
      .select()
      .from(backendTemplateRevisions)
      .where(and(
        eq(backendTemplateRevisions.siteId, sourceSiteId),
        eq(backendTemplateRevisions.templateId, template.id),
        eq(backendTemplateRevisions.templateVersion, ref.version),
      ))
      .limit(1);
    if (!revision) throw new PlanError('NOT_FOUND', `Version ${ref.version} of "${template.slug}" is not published.`, 404);
    return { document: revision.document as BackendTemplate, digest: revision.digest, source: 'site', sourceSiteId };
  }

  /** Builds and persists a plan, or throws a PlanError with the full report. */
  async plan(input: Partial<TemplatePlanInput>): Promise<{ plan: PlanRow; report: PlanReport }> {
    if (!input.targetSiteId) {
      throw new PlanError('MISSING_INPUT', 'targetSiteId is required: name the site to install into.', 400);
    }
    if (input.targetSiteId !== this.deps.siteId) {
      throw new PlanError('SITE_MISMATCH', 'targetSiteId must be the site of this request.', 400);
    }
    if (!input.template) throw new PlanError('MISSING_INPUT', 'template is required.', 400);
    const target = input.targetSiteId;
    const resolved = await this.resolve(input.template, target);
    if (input.template.digest && input.template.digest !== resolved.digest) {
      throw new PlanError('NOT_FOUND', `No revision of ${resolved.document.slug}@${resolved.document.templateVersion} has digest ${input.template.digest}.`, 404);
    }

    const supported = this.deps.supportedStorageModes ?? TEMPLATE_SUPPORTED_STORAGE_MODES;
    const valid = validateBackendTemplate(resolved.document, { supportedStorageModes: supported as never });
    if (!valid.ok) {
      const code = valid.errors.some((e) => e.code === 'INCOMPATIBLE_RUNTIME') ? 'INCOMPATIBLE_RUNTIME' : 'INVALID_TEMPLATE';
      throw new PlanError(code, 'The template cannot be installed by this CMS.', 422, { errors: valid.errors });
    }
    const { map, errors: nsErrors } = namespaceMap(valid.template, input.namespace);
    if (nsErrors.length > 0) throw new PlanError('INVALID_TEMPLATE', 'The namespace mapping is invalid.', 422, { errors: nsErrors });
    const mapped = applyNamespace(valid.template, map);
    const revalidated = validateBackendTemplate(mapped, { supportedStorageModes: supported as never });
    if (!revalidated.ok) throw new PlanError('INVALID_TEMPLATE', 'The template is invalid after the namespace mapping.', 422, { errors: revalidated.errors });

    if (input.seedMode === 'none' && input.seedPack) {
      throw new PlanError('INVALID_TEMPLATE', 'seedMode "none" contradicts seedPack.', 422, { errors: [{ code: 'INVALID_TEMPLATE', path: '$.seedPack', message: 'seedMode "none" installs no seed; omit seedPack.' }] });
    }
    const seedPack = selectedSeedPack(input as TemplatePlanInput);
    if (seedPack && !mapped.seedPacks?.[seedPack]) {
      throw new PlanError('INVALID_TEMPLATE', `The template has no seed pack "${seedPack}".`, 422, {
        errors: [{ code: 'INVALID_TEMPLATE', path: '$.seedPack', message: `Available packs: ${Object.keys(mapped.seedPacks ?? {}).join(', ') || 'none'}.` }],
      });
    }

    const warnings: string[] = [];
    const cmsVersion = this.deps.cmsVersion ?? 'unknown';
    const inRange = satisfiesVersionRange(cmsVersion, mapped.compatibility.cmsVersionRange);
    if (inRange === false) {
      throw new PlanError('INCOMPATIBLE_RUNTIME', `The template needs CMS ${mapped.compatibility.cmsVersionRange}; this CMS is ${cmsVersion}.`, 422);
    }
    if (inRange === null) warnings.push(`CMS version "${cmsVersion}" could not be checked against "${mapped.compatibility.cmsVersionRange}".`);

    const transactional = this.transactional();
    const { fingerprint, collections: existing } = await schemaFingerprint(this.deps.db, target);
    const names = mapped.config.collections.map((c) => c.name);
    const taken = new Set(existing);
    const conflicts = names.filter((name) => taken.has(name));

    const report: PlanReport = {
      template: {
        source: resolved.source,
        sourceSiteId: resolved.sourceSiteId,
        slug: mapped.slug,
        version: mapped.templateVersion,
        digest: resolved.digest,
        displayName: mapped.displayName,
      },
      targetSiteId: target,
      namespace: map,
      components: {
        collections: names,
        fields: mapped.config.fields.length,
        relations: mapped.config.relations.map((r) => ({
          from: `${r.manyCollection}.${r.manyField}`,
          to: r.oneCollection,
          type: r.type ?? (r.junctionCollection ? 'm2m' : 'm2o'),
        })),
      },
      counts: {
        collections: names.length,
        fields: mapped.config.fields.length,
        relations: mapped.config.relations.length,
        seedRecords: seedPack ? mapped.seedPacks![seedPack]!.records.length : 0,
      },
      seedPack,
      storage: { modes: [...mapped.compatibility.storageModes], transactional },
      conflicts,
      unrelatedCollections: existing.filter((name) => !names.includes(name)).length,
      warnings,
    };

    if (!transactional) {
      throw new PlanError('INCOMPATIBLE_RUNTIME', 'This runtime cannot install a template in one transaction.', 422, { report });
    }
    if (conflicts.length > 0) {
      throw new PlanError(
        'NAME_CONFLICT',
        `The target already has collection(s) ${conflicts.join(', ')}. Templates never merge into existing collections; choose a namespace.`,
        409,
        { conflicts, report },
      );
    }

    const [plan] = await this.deps.db
      .insert(backendTemplatePlans)
      .values({
        siteId: target,
        sourceKind: resolved.source,
        sourceSiteId: resolved.sourceSiteId,
        slug: resolved.document.slug,
        templateVersion: resolved.document.templateVersion,
        digest: resolved.digest,
        snapshot: resolved.document,
        namespaceMap: map,
        seedPack,
        targetFingerprint: fingerprint,
        inventory: report,
        createdBy: this.deps.userId ?? null,
        expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS),
      })
      .returning();
    return { plan: plan!, report };
  }

  async get(planId: string): Promise<PlanRow> {
    const [plan] = await this.deps.db
      .select()
      .from(backendTemplatePlans)
      .where(and(eq(backendTemplatePlans.siteId, this.deps.siteId), eq(backendTemplatePlans.id, planId)))
      .limit(1);
    if (!plan) throw new PlanError('NOT_FOUND', 'Plan not found.', 404);
    return plan;
  }

  /**
   * Re-checks a plan right before it is used (approval, apply): still open,
   * not expired, the target schema unchanged since planning, a transactional
   * runtime. A stale plan is marked so and refused — the caller must plan
   * again. Nothing about the target is written either way.
   */
  async verify(planId: string): Promise<PlanRow> {
    const plan = await this.get(planId);
    if (!['planned', 'awaiting_approval'].includes(plan.status)) {
      throw new PlanError('STALE_PLAN', `The plan is ${plan.status}; plan again.`, 409);
    }
    const mark = async (status: 'expired' | 'invalidated') => {
      await this.deps.db
        .update(backendTemplatePlans)
        .set({ status, updatedAt: this.now() })
        .where(and(
          eq(backendTemplatePlans.siteId, this.deps.siteId),
          eq(backendTemplatePlans.id, planId),
          inArray(backendTemplatePlans.status, ['planned', 'awaiting_approval']),
        ));
    };
    if (plan.expiresAt.getTime() <= this.now().getTime()) {
      await mark('expired');
      throw new PlanError('STALE_PLAN', 'The plan expired; plan again.', 409);
    }
    if (!this.transactional()) {
      throw new PlanError('INCOMPATIBLE_RUNTIME', 'This runtime cannot install a template in one transaction.', 422);
    }
    const { fingerprint } = await schemaFingerprint(this.deps.db, this.deps.siteId);
    if (fingerprint !== plan.targetFingerprint) {
      await mark('invalidated');
      throw new PlanError('STALE_PLAN', 'The target schema changed since the plan was made; plan again.', 409);
    }
    return plan;
  }
}
