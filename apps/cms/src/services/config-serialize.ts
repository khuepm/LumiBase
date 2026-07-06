/**
 * config-serialize.ts — pure (DB-free) serialization between the database row
 * shape of schema config and the declarative {@link ConfigManifest}.
 *
 * Keeping this pure means the round-trip property (Req 6.1) and deterministic
 * output (Req 1.5) can be unit-tested with `fast-check` without a database,
 * exactly like `apps/cms/src/modules/setup/policy-codec.ts`.
 */

import {
  CONFIG_MANIFEST_VERSION,
  type CollectionConfig,
  type ConfigManifest,
  type FieldConfig,
  type RelationConfig,
  type SettingConfig,
  type WebhookConfig,
  stableKey,
} from '@lumibase/shared/schemas';

/** Row shapes as loaded from the DB (a structural subset of the Drizzle rows). */
export interface ConfigState {
  collections: CollectionRowLike[];
  fields: FieldRowLike[];
  relations: RelationRowLike[];
  webhooks: WebhookRowLike[];
  settings: SettingRowLike[];
}

export interface CollectionRowLike {
  name: string;
  label?: string | null;
  pluralLabel?: string | null;
  hidden?: boolean | null;
  system?: boolean | null;
  singleton?: boolean | null;
  icon?: string | null;
  color?: string | null;
  note?: string | null;
  primaryKeyField?: string | null;
  primaryKeyType?: string | null;
  storageMode?: string | null;
  displayTemplate?: string | null;
  sortField?: string | null;
  archiveField?: string | null;
  archiveValue?: string | null;
  unarchiveValue?: string | null;
  itemDuplicationFields?: unknown;
  translations?: unknown;
  accountability?: string | null;
  versioning?: boolean | null;
  meta?: unknown;
}

export interface FieldRowLike {
  collection: string;
  name: string;
  type: string;
  interface: string;
  display?: string | null;
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean | null;
  unique?: boolean | null;
  indexed?: boolean | null;
  searchable?: boolean | null;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown;
  options?: unknown;
  displayOptions?: unknown;
  validation?: unknown;
  conditions?: unknown;
  required?: boolean | null;
  readonly?: boolean | null;
  hidden?: boolean | null;
  encrypted?: boolean | null;
  classification?: string | null;
  versioned?: boolean | null;
  rawEnabled?: boolean | null;
  width?: string | null;
  group?: string | null;
  sortOrder?: number | null;
}

export interface RelationRowLike {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField?: string | null;
  junctionCollection?: string | null;
  type?: string | null;
  aliasField?: string | null;
  relatedDisplayTemplate?: string | null;
  junctionManyField?: string | null;
  junctionOneField?: string | null;
  sortField?: string | null;
  onDelete?: string | null;
  meta?: unknown;
}

export interface WebhookRowLike {
  name: string;
  url: string;
  actions?: unknown;
  collections?: unknown;
  headers?: unknown;
  status?: string | null;
}

export interface SettingRowLike {
  key: string;
  value: unknown;
  scope?: string | null;
}

/**
 * Recursively sort object keys so two structurally-equal JSON values serialize
 * to byte-identical strings (Req 1.5, 6.5). Arrays keep their order — callers
 * sort top-level resource arrays by stable key explicitly (mirrors
 * `access-export.ts`).
 */
export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

/** Drop undefined entries so optional-field presence doesn't perturb output. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function serializeCollection(row: CollectionRowLike): CollectionConfig {
  return compact({
    name: row.name,
    label: row.label ?? undefined,
    pluralLabel: row.pluralLabel ?? undefined,
    hidden: row.hidden ?? undefined,
    system: row.system ?? undefined,
    singleton: row.singleton ?? undefined,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    note: row.note ?? undefined,
    primaryKeyField: row.primaryKeyField ?? undefined,
    primaryKeyType: (row.primaryKeyType ?? undefined) as CollectionConfig['primaryKeyType'],
    storageMode: (row.storageMode ?? undefined) as CollectionConfig['storageMode'],
    displayTemplate: row.displayTemplate ?? undefined,
    sortField: row.sortField ?? undefined,
    archiveField: row.archiveField ?? undefined,
    archiveValue: row.archiveValue ?? undefined,
    unarchiveValue: row.unarchiveValue ?? undefined,
    itemDuplicationFields: (row.itemDuplicationFields as unknown[]) ?? undefined,
    translations: (row.translations as Record<string, unknown>) ?? undefined,
    accountability: (row.accountability ?? undefined) as CollectionConfig['accountability'],
    versioning: row.versioning ?? undefined,
    meta: (row.meta as Record<string, unknown>) ?? undefined,
  }) as CollectionConfig;
}

function serializeField(row: FieldRowLike): FieldConfig {
  return compact({
    collection: row.collection,
    field: row.name,
    type: row.type,
    interface: row.interface,
    display: row.display ?? undefined,
    label: row.label ?? undefined,
    note: row.note ?? undefined,
    defaultValue: row.defaultValue ?? undefined,
    nullable: row.nullable ?? undefined,
    unique: row.unique ?? undefined,
    indexed: row.indexed ?? undefined,
    searchable: row.searchable ?? undefined,
    length: row.length ?? undefined,
    precision: row.precision ?? undefined,
    scale: row.scale ?? undefined,
    special: (row.special as unknown[]) ?? undefined,
    options: (row.options as Record<string, unknown>) ?? undefined,
    displayOptions: (row.displayOptions as Record<string, unknown>) ?? undefined,
    validation: (row.validation as Record<string, unknown>) ?? undefined,
    conditions: (row.conditions as unknown[]) ?? undefined,
    required: row.required ?? undefined,
    readonly: row.readonly ?? undefined,
    hidden: row.hidden ?? undefined,
    encrypted: row.encrypted ?? undefined,
    classification: row.classification ?? undefined,
    versioned: row.versioned ?? undefined,
    rawEnabled: row.rawEnabled ?? undefined,
    width: (row.width ?? undefined) as FieldConfig['width'],
    group: row.group ?? undefined,
    sortOrder: row.sortOrder ?? undefined,
  }) as FieldConfig;
}

function serializeRelation(row: RelationRowLike): RelationConfig {
  return compact({
    manyCollection: row.manyCollection,
    manyField: row.manyField,
    oneCollection: row.oneCollection,
    oneField: row.oneField ?? undefined,
    junctionCollection: row.junctionCollection ?? undefined,
    type: (row.type ?? undefined) as RelationConfig['type'],
    aliasField: row.aliasField ?? undefined,
    relatedDisplayTemplate: row.relatedDisplayTemplate ?? undefined,
    junctionManyField: row.junctionManyField ?? undefined,
    junctionOneField: row.junctionOneField ?? undefined,
    sortField: row.sortField ?? undefined,
    onDelete: (row.onDelete ?? undefined) as RelationConfig['onDelete'],
    meta: (row.meta as Record<string, unknown>) ?? undefined,
  }) as RelationConfig;
}

function serializeWebhook(row: WebhookRowLike): WebhookConfig {
  return {
    name: row.name,
    url: row.url,
    actions: (row.actions as string[]) ?? [],
    collections: (row.collections as string[]) ?? [],
    headers: (row.headers as Record<string, string>) ?? {},
    status: (row.status as WebhookConfig['status']) ?? 'active',
  };
}

function serializeSetting(row: SettingRowLike): SettingConfig {
  return {
    key: row.key,
    value: row.value ?? null,
    scope: (row.scope as SettingConfig['scope']) ?? 'site',
  };
}

export interface SerializeOptions {
  /** Restrict to a scope; defaults to `all`. */
  scope?: 'all' | 'schema' | 'settings' | 'webhooks';
  /** Stamp `exportedAt` (caller supplies — keeps this fn pure/deterministic). */
  exportedAt?: string;
}

/**
 * Build a canonical {@link ConfigManifest} from a {@link ConfigState}. Arrays are
 * sorted by stable key; nested JSON is key-sorted; `undefined` is dropped. Two
 * calls on equal state produce byte-identical `JSON.stringify` output.
 */
export function serializeConfig(state: ConfigState, opts: SerializeOptions = {}): ConfigManifest {
  const scope = opts.scope ?? 'all';
  const wantSchema = scope === 'all' || scope === 'schema';
  const wantSettings = scope === 'all' || scope === 'settings';
  const wantWebhooks = scope === 'all' || scope === 'webhooks';

  const collections = wantSchema
    ? state.collections
        .map(serializeCollection)
        .sort((a, b) => stableKey.collection(a).localeCompare(stableKey.collection(b)))
    : [];
  const fields = wantSchema
    ? state.fields
        .map(serializeField)
        .sort((a, b) => stableKey.field(a).localeCompare(stableKey.field(b)))
    : [];
  const relations = wantSchema
    ? state.relations
        .map(serializeRelation)
        .sort((a, b) => stableKey.relation(a).localeCompare(stableKey.relation(b)))
    : [];
  const webhooks = wantWebhooks
    ? state.webhooks
        .map(serializeWebhook)
        .sort((a, b) => stableKey.webhook(a).localeCompare(stableKey.webhook(b)))
    : [];
  const settings = wantSettings
    ? state.settings
        .map(serializeSetting)
        .sort((a, b) => stableKey.setting(a).localeCompare(stableKey.setting(b)))
    : [];

  const manifest: ConfigManifest = {
    version: CONFIG_MANIFEST_VERSION,
    collections,
    fields,
    relations,
    webhooks,
    settings,
  };
  if (opts.exportedAt) manifest.exportedAt = opts.exportedAt;
  return canonicalize(manifest);
}
