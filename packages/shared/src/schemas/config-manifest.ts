import { z } from 'zod';

/**
 * Config Manifest schemas — the declarative, version-controllable representation
 * of a site's *schema configuration* (collections, fields, relations, settings,
 * webhooks). Shared by CMS (export/import/validate) and, in future, Studio (a
 * diff viewer) and the SDK. Mirrors the proven `access-manifest` pattern
 * (`apps/cms/src/services/access-export.ts`): a versioned envelope of resources
 * keyed by a stable, human-meaningful key rather than a generated nanoid.
 *
 * Resource shapes intentionally track the service input types in
 * `apps/cms/src/services/schema-service.ts` (`CollectionInput`, `FieldInput`,
 * `RelationInput`) so a manifest round-trips through `updateSchema()` without a
 * lossy translation step.
 *
 * What a manifest NEVER contains (see `requirements.md` Req 1.3): `id` (nanoid),
 * `siteId`, `createdAt`/`updatedAt`, content items, secrets, or password/API-key
 * hashes. Stable keys: collection → `name`; field → `collection.field`;
 * relation → `manyCollection.manyField`; webhook → `name`; setting → `key`.
 */

export const CONFIG_MANIFEST_VERSION = 'lumibase.config@v1' as const;

/** Mirrors `PrimaryKeyType` in schema-service. */
export const PrimaryKeyTypeSchema = z.enum([
  'nanoid',
  'uuid',
  'integer',
  'bigInteger',
  'string',
]);

/** Mirrors `StorageMode` in schema-service. */
export const StorageModeSchema = z.enum([
  'jsonb',
  'materialized',
  'physical',
  'external',
]);

/** Mirrors the `relations.on_delete` column (`cms.ts:168`). */
export const OnDeleteSchema = z.enum([
  'restrict',
  'cascade',
  'set null',
  'no action',
]);

export const RelationTypeSchema = z.enum(['m2o', 'o2m', 'm2m', 'm2a']);

/**
 * Collection config entry. Keyed by `name`. `meta` and `translations` are
 * free-form JSON kept verbatim; everything else maps to `CollectionInput`.
 */
export const CollectionConfigSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().nullable().optional(),
    pluralLabel: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    system: z.boolean().optional(),
    singleton: z.boolean().optional(),
    icon: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    primaryKeyField: z.string().optional(),
    primaryKeyType: PrimaryKeyTypeSchema.optional(),
    storageMode: StorageModeSchema.optional(),
    displayTemplate: z.string().nullable().optional(),
    sortField: z.string().nullable().optional(),
    archiveField: z.string().nullable().optional(),
    archiveValue: z.string().nullable().optional(),
    unarchiveValue: z.string().nullable().optional(),
    itemDuplicationFields: z.array(z.unknown()).optional(),
    translations: z.record(z.string(), z.unknown()).optional(),
    accountability: z.enum(['all', 'activity', 'none']).optional(),
    versioning: z.boolean().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Field config entry. Keyed by `collection` + `field`. Maps to `FieldInput`. */
export const FieldConfigSchema = z
  .object({
    collection: z.string().min(1),
    field: z.string().min(1),
    type: z.string().min(1),
    interface: z.string().min(1),
    display: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    defaultValue: z.unknown().optional(),
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    indexed: z.boolean().optional(),
    searchable: z.boolean().optional(),
    length: z.number().int().nullable().optional(),
    precision: z.number().int().nullable().optional(),
    scale: z.number().int().nullable().optional(),
    special: z.array(z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    displayOptions: z.record(z.string(), z.unknown()).optional(),
    validation: z.record(z.string(), z.unknown()).optional(),
    conditions: z.array(z.unknown()).optional(),
    required: z.boolean().optional(),
    readonly: z.boolean().optional(),
    hidden: z.boolean().optional(),
    encrypted: z.boolean().optional(),
    classification: z.string().nullable().optional(),
    versioned: z.boolean().optional(),
    rawEnabled: z.boolean().optional(),
    width: z.enum(['half', 'full', 'fill']).optional(),
    group: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

/**
 * Relation config entry. Keyed by `manyCollection` + `manyField`. References
 * collections by stable name (never id). Maps to `RelationInput`.
 */
export const RelationConfigSchema = z
  .object({
    manyCollection: z.string().min(1),
    manyField: z.string().min(1),
    oneCollection: z.string().min(1),
    oneField: z.string().nullable().optional(),
    junctionCollection: z.string().nullable().optional(),
    type: RelationTypeSchema.optional(),
    aliasField: z.string().nullable().optional(),
    relatedDisplayTemplate: z.string().nullable().optional(),
    junctionManyField: z.string().nullable().optional(),
    junctionOneField: z.string().nullable().optional(),
    sortField: z.string().nullable().optional(),
    onDelete: OnDeleteSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Webhook config entry. Keyed by `name`. */
export const WebhookConfigSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
    actions: z.array(z.string()).default([]),
    collections: z.array(z.string()).default([]),
    headers: z.record(z.string(), z.string()).default({}),
    status: z.enum(['active', 'inactive']).default('active'),
  })
  .strict();

/** Setting config entry. Keyed by `key`. `value` is free-form JSON. */
export const SettingConfigSchema = z
  .object({
    key: z.string().min(1),
    value: z.unknown(),
    scope: z.enum(['site', 'module']).default('site'),
  })
  .strict();

/**
 * The full manifest. `exportedAt` is informational only — importers MUST ignore
 * it (it is not part of the diff). `managedScopes` is an optional list of
 * collection names the manifest claims to manage; `replace-managed` apply mode
 * only deletes resources within these scopes (see design §2, §4.5).
 */
export const ConfigManifestSchema = z
  .object({
    version: z.literal(CONFIG_MANIFEST_VERSION),
    exportedAt: z.string().optional(),
    collections: z.array(CollectionConfigSchema).default([]),
    fields: z.array(FieldConfigSchema).default([]),
    relations: z.array(RelationConfigSchema).default([]),
    webhooks: z.array(WebhookConfigSchema).default([]),
    settings: z.array(SettingConfigSchema).default([]),
    managedScopes: z.array(z.string()).optional(),
  })
  .strip(); // drop unknown top-level keys (forward compat, Req 6.4)

export type PrimaryKeyType = z.infer<typeof PrimaryKeyTypeSchema>;
export type StorageMode = z.infer<typeof StorageModeSchema>;
export type OnDelete = z.infer<typeof OnDeleteSchema>;
export type RelationType = z.infer<typeof RelationTypeSchema>;
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;
export type FieldConfig = z.infer<typeof FieldConfigSchema>;
export type RelationConfig = z.infer<typeof RelationConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type SettingConfig = z.infer<typeof SettingConfigSchema>;
export type ConfigManifest = z.infer<typeof ConfigManifestSchema>;

/** Stable keys used to match resources between a manifest and the DB. */
export const stableKey = {
  collection: (c: Pick<CollectionConfig, 'name'>) => c.name,
  field: (f: Pick<FieldConfig, 'collection' | 'field'>) => `${f.collection}.${f.field}`,
  relation: (r: Pick<RelationConfig, 'manyCollection' | 'manyField'>) =>
    `${r.manyCollection}.${r.manyField}`,
  webhook: (w: Pick<WebhookConfig, 'name'>) => w.name,
  setting: (s: Pick<SettingConfig, 'key'>) => s.key,
};

/**
 * Parse + validate an unknown value as a ConfigManifest. Returns a discriminated
 * result so callers can surface `errors` in the `{ errors: [...] }` envelope
 * without throwing.
 */
export function parseConfigManifest(
  input: unknown,
):
  | { ok: true; manifest: ConfigManifest }
  | { ok: false; errors: Array<{ code: string; path: string; message: string }> } {
  const parsed = ConfigManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      code: 'INVALID_MANIFEST',
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
