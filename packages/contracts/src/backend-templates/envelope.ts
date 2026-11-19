import { z } from 'zod';
import {
  CONFIG_MANIFEST_VERSION,
  CollectionConfigSchema,
  FieldConfigSchema,
  RelationConfigSchema,
  StorageModeSchema,
} from '../schemas/config-manifest';

/**
 * Backend template envelope — `lumibase.template@v1` (#901, spec
 * `.kiro/specs/backend-templates/`, R1/R2).
 *
 * A template is a portable JSON document describing a complete content model
 * (collections, fields, relations) plus optional named seed packs. It embeds
 * the existing config manifest (`lumibase.config@v1`) rather than inventing a
 * second field vocabulary: collection / field / relation entries ARE the
 * manifest entries, so whatever installs a template later goes through the
 * same SchemaService inputs.
 *
 * The envelope is strict: unknown keys anywhere are refused, so a document
 * cannot smuggle site ids, permissions, SQL, flows or webhooks past the
 * contract. Webhooks and settings are not part of template v1 and must be
 * empty when present; `managedScopes` (replacement modes) is not allowed.
 *
 * Structural rules live here and in the generated JSON Schema; cross-reference
 * rules (dangling relations, duplicate keys, storage support, seed graph,
 * limits) live in `validate.ts` as pure helpers.
 */

export const TEMPLATE_FORMAT_VERSION = 'lumibase.template@v1' as const;

/** Semantic Versioning 2.0.0 (https://semver.org), no leading `v`. */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Kebab-case template slug. */
export const TEMPLATE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Seed pack name. */
export const SEED_PACK_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Logical record key inside a seed pack (never a persisted id). */
export const SEED_RECORD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const TemplateCompatibilitySchema = z
  .object({
    /**
     * CMS versions the template targets, as a SemVer range (e.g. `>=2.3.0 <3`).
     * Checked against the running CMS by the installer, not by this contract.
     */
    cmsVersionRange: z.string().trim().min(1).max(100),
    /** Storage modes the template's collections use; each must be supported by the target. */
    storageModes: z.array(StorageModeSchema).min(1).max(4),
  })
  .strict();

/** Template config: the config manifest, restricted to what template v1 supports. */
export const TemplateConfigSchema = z
  .object({
    version: z.literal(CONFIG_MANIFEST_VERSION),
    /** Transport metadata; ignored by the digest. */
    exportedAt: z.string().optional(),
    collections: z.array(CollectionConfigSchema).min(1),
    fields: z.array(FieldConfigSchema),
    relations: z.array(RelationConfigSchema),
    /** Not part of template v1 (no outbound side effects); empty when present. */
    webhooks: z.array(z.never()).max(0).optional(),
    /** Not part of template v1 (may hold secrets); empty when present. */
    settings: z.array(z.never()).max(0).optional(),
  })
  .strict();

/** JSON value with no functions/undefined (seed values are plain data). */
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SeedRecordSchema = z
  .object({
    /** Logical key, unique within the pack; persisted ids are generated at install. */
    key: z.string().regex(SEED_RECORD_KEY_RE),
    collection: z.string().min(1),
    /** Field values by field name (no ids, no relation fields). */
    values: z.record(z.string(), JsonValueSchema),
    /** m2o relation field → logical key of a record in the same pack, or null. */
    references: z.record(z.string(), z.string().regex(SEED_RECORD_KEY_RE).nullable()).optional(),
  })
  .strict();

export const SeedPackSchema = z
  .object({
    description: z.string().max(1000).optional(),
    records: z.array(SeedRecordSchema),
  })
  .strict();

export const BackendTemplateSchema = z
  .object({
    formatVersion: z.literal(TEMPLATE_FORMAT_VERSION),
    slug: z.string().min(1).max(64).regex(TEMPLATE_SLUG_RE),
    displayName: z.string().trim().min(1).max(120),
    templateVersion: z.string().max(128).regex(SEMVER_RE),
    description: z.string().max(4000).optional(),
    compatibility: TemplateCompatibilitySchema,
    config: TemplateConfigSchema,
    /** Optional named demo data. Omitted = schema only (the default install mode). */
    seedPacks: z.record(z.string().regex(SEED_PACK_NAME_RE), SeedPackSchema).optional(),
  })
  .strict();

export type TemplateCompatibility = z.infer<typeof TemplateCompatibilitySchema>;
export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type SeedRecord = z.infer<typeof SeedRecordSchema>;
export type SeedPack = z.infer<typeof SeedPackSchema>;
export type BackendTemplate = z.infer<typeof BackendTemplateSchema>;

/**
 * JSON Schema of the envelope (draft 2020-12), generated from the same Zod
 * schema, for MCP tool inputs and external validators (BT01-AC06).
 */
export function backendTemplateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BackendTemplateSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
