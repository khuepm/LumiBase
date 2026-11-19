import { z } from 'zod';
import { SEED_PACK_NAME_RE, SEMVER_RE, TEMPLATE_SLUG_RE } from './envelope';
import { TemplateNamespaceSchema } from './plan';

/**
 * Agent tool contracts for backend templates (#906, BT06): the input of every
 * governed MCP / Agent API template tool. One definition for both uses: the
 * harness validates `args` against it before any side effect, and `tools/list`
 * advertises the JSON Schema derived from it.
 *
 * The tools call the same catalog, planner and installer services as REST
 * (`/api/v1/backend-templates`), so a field here is a field those services read.
 */

const id = z.string().min(1).max(64);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A template document: a JSON object, or raw JSON text (checked for duplicate keys). */
const document = z.union([z.record(z.string(), z.unknown()), z.string().min(2)]);

/**
 * What an install approval is bound to (#906 AC04). `planBackendTemplate`
 * returns it; `instantiateBackendTemplate` must send it back unchanged. The
 * installer compares it with the stored plan inside the install transaction,
 * so an approval whose target site, template, version, digest, seed choice,
 * namespace or target schema differs from the plan writes nothing.
 */
export const TemplatePlanBindingSchema = z
  .object({
    targetSiteId: id,
    source: z.enum(['official', 'site']),
    sourceSiteId: id.nullable(),
    slug: z.string().regex(TEMPLATE_SLUG_RE),
    templateVersion: z.string().regex(SEMVER_RE),
    digest,
    seedPack: z.string().regex(SEED_PACK_NAME_RE).nullable(),
    namespaceMap: z.record(z.string(), z.string()),
    targetFingerprint: z.string().min(1).max(128),
  })
  .strict();

export type TemplatePlanBinding = z.infer<typeof TemplatePlanBindingSchema>;

/**
 * The template reference of the plan tool: REST's `TemplateRefSchema` minus
 * `displayName`. The REST alternative "slug OR displayName" is an exclusive
 * choice JSON Schema cannot advertise, so agents name templates by slug (from
 * `listBackendTemplates`); `displayName` stays a REST/Studio convenience.
 */
const toolTemplateRef = z
  .object({
    source: z.enum(['official', 'site']),
    sourceSiteId: id.optional(),
    slug: z.string().min(1).max(64).regex(TEMPLATE_SLUG_RE),
    version: z.string().max(128).regex(SEMVER_RE),
    digest: digest.optional(),
  })
  .strict();

export const BackendTemplateToolSchemas = {
  listBackendTemplates: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  getBackendTemplate: z
    .object({
      /** `official` = bundled with the CMS; `site` = this site's private catalog. */
      source: z.enum(['official', 'site']),
      /** Template slug (or, for a private template, its id). */
      slug: z.string().min(1).max(64),
      /** A published revision; without it a private template returns its draft and revision list. */
      version: z.string().max(128).regex(SEMVER_RE).optional(),
    })
    .strict(),
  /** Validates a document without storing it (a stored draft is validated again on publish). */
  validateBackendTemplate: z.object({ document }).strict(),
  createBackendTemplate: z.object({ document }).strict(),
  updateBackendTemplate: z
    .object({ templateId: id, document, draftRevision: z.number().int().min(1) })
    .strict(),
  publishBackendTemplate: z
    .object({ templateId: id, draftRevision: z.number().int().min(1).optional() })
    .strict(),
  captureBackendTemplate: z
    .object({
      collections: z.array(z.string().min(1)).min(1).max(100),
      slug: z.string().min(1).max(64),
      displayName: z.string().trim().min(1).max(120),
      templateVersion: z.string().max(128).optional(),
      description: z.string().max(4000).optional(),
      seed: z
        .object({
          pack: z.string().regex(SEED_PACK_NAME_RE).optional(),
          collections: z.array(z.string().min(1)).min(1).max(100),
          maxRecordsPerCollection: z.number().int().min(1).max(1000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /**
   * Same fields as `POST /backend-templates/plans`, except that `targetSiteId`
   * is optional HERE so its absence reaches the handler and comes back as
   * `MISSING_INPUT` with guidance (AC06), rather than as a generic VALIDATION.
   * No default site is ever used.
   */
  planBackendTemplate: z
    .object({
      template: toolTemplateRef,
      targetSiteId: id.optional(),
      namespace: TemplateNamespaceSchema.optional(),
      seedMode: z.enum(['none', 'pack']).optional(),
      seedPack: z.string().regex(SEED_PACK_NAME_RE).nullable().optional(),
    })
    .strict(),
  instantiateBackendTemplate: z
    .object({
      planId: id,
      /** The `binding` returned by `planBackendTemplate`, unchanged. */
      expect: TemplatePlanBindingSchema,
      /** Defaults to `plan:<planId>`, so instantiating one plan twice returns the same installation. */
      idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
    })
    .strict(),
  /** An installation id, or the planId it was installed from. */
  getBackendTemplateInstallation: z.object({ installationId: id }).strict(),
} as const satisfies Record<string, z.ZodType>;

export type BackendTemplateToolName = keyof typeof BackendTemplateToolSchemas;

export const BACKEND_TEMPLATE_TOOL_NAMES = Object.keys(BackendTemplateToolSchemas) as BackendTemplateToolName[];
