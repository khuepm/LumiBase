import type { z } from 'zod';
import type { FieldType } from '../field/index';
import { CONFIG_MANIFEST_VERSION, type StorageMode } from '../schemas/config-manifest';
import {
  BackendTemplateSchema,
  TEMPLATE_FORMAT_VERSION,
  type BackendTemplate,
} from './envelope';
import { templateError, type TemplateError } from './errors';
import { ingestTemplateJson, jsonDepth, jsonPath, utf8ByteLength } from './ingest';
import { TEMPLATE_LIMITS, TEMPLATE_SUPPORTED_STORAGE_MODES } from './limits';

/**
 * Template validation (#901, BT01-W2): structure (Zod) first, then pure
 * cross-reference checks. Nothing here touches a database or a service — a
 * template that fails validation can never reach a write.
 *
 * Every check reports ALL problems it finds, each with a stable code and a
 * JSON path, rather than stopping at the first.
 */

export interface TemplateValidationOptions {
  /**
   * Storage modes the target runtime can install. Defaults to
   * {@link TEMPLATE_SUPPORTED_STORAGE_MODES}; a mode outside it fails with
   * INCOMPATIBLE_RUNTIME instead of being downgraded.
   */
  supportedStorageModes?: readonly StorageMode[];
}

export type TemplateValidation =
  | { ok: true; template: BackendTemplate }
  | { ok: false; errors: TemplateError[] };

/** Field types a template may declare (the CMS field vocabulary). */
export const TEMPLATE_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'string', 'text', 'integer', 'bigInteger', 'decimal', 'boolean', 'json', 'uuid', 'date', 'datetime',
  'time', 'timestamp', 'csv', 'hash', 'geometry', 'alias', 'blocks', 'geopoint', 'richtext',
]);

/** Mirrors SchemaService: collection and field names. */
export const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** Mirrors SchemaService RESERVED_COLLECTION_PREFIXES. */
export const RESERVED_COLLECTION_PREFIXES: readonly string[] = ['lumibase_', 'mat_'];
/** Field names owned by the platform on every item. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['id', 'site_id']);

const STRING_TYPES = new Set(['string', 'text', 'uuid', 'date', 'datetime', 'time', 'timestamp']);

/** Whether a seed value has a JSON shape the field type can store. */
export function seedValueFits(type: string, value: unknown): boolean {
  if (value === null) return true;
  if (STRING_TYPES.has(type)) return typeof value === 'string';
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bigInteger':
      return (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^-?\d+$/.test(value));
    case 'decimal':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'csv':
      return typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    default:
      // json, geometry, blocks, geopoint, richtext: structured JSON, validated
      // by the field validator at install.
      return true;
  }
}

function zodIssues(error: z.ZodError): TemplateError[] {
  return error.issues.map((issue) => {
    const path = jsonPath(issue.path.filter((p): p is string | number => typeof p !== 'symbol'));
    if (issue.code === 'unrecognized_keys') {
      return templateError(
        'INVALID_TEMPLATE',
        path,
        `Not allowed in a template: ${issue.keys.map((k) => `"${k}"`).join(', ')}. Templates carry no ids, site ids, permissions, code, settings or webhooks.`,
      );
    }
    return templateError('INVALID_TEMPLATE', path, issue.message);
  });
}

/** Fast, structure-free gate: wrong format versions and count limits. */
function preflight(input: unknown): TemplateError[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [templateError('INVALID_TEMPLATE', '$', 'A template is a JSON object.')];
  }
  const doc = input as Record<string, unknown>;
  const errors: TemplateError[] = [];
  if (doc['formatVersion'] !== TEMPLATE_FORMAT_VERSION) {
    errors.push(templateError(
      'UNSUPPORTED_FORMAT',
      '$.formatVersion',
      `Unsupported formatVersion ${JSON.stringify(doc['formatVersion'])}; this CMS reads "${TEMPLATE_FORMAT_VERSION}".`,
    ));
  }
  const config = doc['config'];
  if (config && typeof config === 'object' && (config as Record<string, unknown>)['version'] !== CONFIG_MANIFEST_VERSION) {
    errors.push(templateError(
      'UNSUPPORTED_FORMAT',
      '$.config.version',
      `Unsupported config version ${JSON.stringify((config as Record<string, unknown>)['version'])}; this CMS reads "${CONFIG_MANIFEST_VERSION}".`,
    ));
  }
  if (errors.length > 0) return errors;

  const depth = jsonDepth(input);
  if (depth > TEMPLATE_LIMITS.maxDepth) {
    errors.push(templateError('LIMIT_EXCEEDED', '$', `Nesting depth ${depth} exceeds ${TEMPLATE_LIMITS.maxDepth}.`));
  }
  const cfg = (config ?? {}) as Record<string, unknown>;
  const count = (key: string, max: number, label: string) => {
    const list = cfg[key];
    if (Array.isArray(list) && list.length > max) {
      errors.push(templateError('LIMIT_EXCEEDED', `$.config.${key}`, `${list.length} ${label}; the limit is ${max}.`));
    }
  };
  count('collections', TEMPLATE_LIMITS.maxCollections, 'collections');
  count('fields', TEMPLATE_LIMITS.maxFields, 'fields');
  count('relations', TEMPLATE_LIMITS.maxRelations, 'relations');
  const packs = doc['seedPacks'];
  if (packs && typeof packs === 'object') {
    let records = 0;
    for (const pack of Object.values(packs as Record<string, unknown>)) {
      const list = (pack as Record<string, unknown> | null)?.['records'];
      if (Array.isArray(list)) records += list.length;
    }
    if (records > TEMPLATE_LIMITS.maxSeedRecords) {
      errors.push(templateError('LIMIT_EXCEEDED', '$.seedPacks', `${records} seed records; the limit is ${TEMPLATE_LIMITS.maxSeedRecords}.`));
    }
  }
  return errors;
}

/** Cross-reference checks on a structurally valid template. */
export function semanticErrors(t: BackendTemplate, options: TemplateValidationOptions = {}): TemplateError[] {
  const errors: TemplateError[] = [];
  const supported = new Set<string>(options.supportedStorageModes ?? TEMPLATE_SUPPORTED_STORAGE_MODES);
  const declaredModes = new Set<string>(t.compatibility.storageModes);

  // ── Compatibility ────────────────────────────────────────────────────────
  if (declaredModes.size !== t.compatibility.storageModes.length) {
    errors.push(templateError('INVALID_TEMPLATE', '$.compatibility.storageModes', 'storageModes lists a mode twice.'));
  }
  t.compatibility.storageModes.forEach((mode, i) => {
    if (!supported.has(mode)) {
      errors.push(templateError(
        'INCOMPATIBLE_RUNTIME',
        `$.compatibility.storageModes[${i}]`,
        `Storage mode "${mode}" is not supported by this CMS for templates (supported: ${[...supported].join(', ')}).`,
      ));
    }
  });

  // ── Collections ──────────────────────────────────────────────────────────
  const collections = new Map<string, number>();
  t.config.collections.forEach((c, i) => {
    const at = `$.config.collections[${i}]`;
    if (collections.has(c.name)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.name`, `Duplicate collection "${c.name}".`));
    } else collections.set(c.name, i);
    if (!TEMPLATE_NAME_RE.test(c.name)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.name`, `Collection name must match ${TEMPLATE_NAME_RE}.`));
    }
    const reserved = RESERVED_COLLECTION_PREFIXES.find((prefix) => c.name.startsWith(prefix));
    if (reserved || c.system === true) {
      errors.push(templateError(
        'INVALID_TEMPLATE',
        reserved ? `${at}.name` : `${at}.system`,
        reserved ? `Collection names starting with "${reserved}" are reserved for the platform.` : 'System collections cannot be part of a template.',
      ));
    }
    if (c.primaryKeyType !== undefined && c.primaryKeyType !== 'nanoid') {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.primaryKeyType`, 'Portable templates use nanoid primary keys.'));
    }
    if (c.primaryKeyField !== undefined && c.primaryKeyField !== 'id') {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.primaryKeyField`, 'Portable templates use the "id" primary key.'));
    }
    const mode = c.storageMode ?? 'jsonb';
    if (!declaredModes.has(mode)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.storageMode`, `Storage mode "${mode}" is not declared in compatibility.storageModes.`));
    }
    if (!supported.has(mode)) {
      errors.push(templateError('INCOMPATIBLE_RUNTIME', `${at}.storageMode`, `Storage mode "${mode}" cannot be installed from a template; it is refused, never downgraded.`));
    }
  });

  // ── Fields ───────────────────────────────────────────────────────────────
  const fields = new Map<string, { type: string; required: boolean; hasDefault: boolean; nullable: boolean }>();
  t.config.fields.forEach((f, i) => {
    const at = `$.config.fields[${i}]`;
    const key = `${f.collection}.${f.field}`;
    if (!collections.has(f.collection)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.collection`, `Field "${key}" belongs to an undeclared collection.`));
    }
    if (fields.has(key)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.field`, `Duplicate field "${key}".`));
    } else {
      fields.set(key, {
        type: f.type,
        required: f.required === true,
        hasDefault: f.defaultValue !== undefined && f.defaultValue !== null,
        nullable: f.nullable !== false,
      });
    }
    if (!TEMPLATE_NAME_RE.test(f.field)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.field`, `Field name must match ${TEMPLATE_NAME_RE}.`));
    }
    if (RESERVED_FIELD_NAMES.has(f.field)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.field`, `"${f.field}" is managed by the platform and cannot be declared.`));
    }
    if (!TEMPLATE_FIELD_TYPES.has(f.type as FieldType)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.type`, `Unsupported field type "${f.type}".`));
    }
  });
  t.config.fields.forEach((f, i) => {
    if (f.group && !fields.has(`${f.collection}.${f.group}`)) {
      errors.push(templateError('INVALID_TEMPLATE', `$.config.fields[${i}].group`, `Group field "${f.collection}.${f.group}" is not declared.`));
    }
  });
  t.config.collections.forEach((c, i) => {
    for (const prop of ['sortField', 'archiveField'] as const) {
      const name = c[prop];
      if (name && !fields.has(`${c.name}.${name}`)) {
        errors.push(templateError('INVALID_TEMPLATE', `$.config.collections[${i}].${prop}`, `Field "${c.name}.${name}" is not declared.`));
      }
    }
  });

  // ── Relations ────────────────────────────────────────────────────────────
  const relationKeys = new Set<string>();
  /** collection.field → target collection, for m2o relation fields (seed references). */
  const m2o = new Map<string, string>();
  t.config.relations.forEach((r, i) => {
    const at = `$.config.relations[${i}]`;
    const key = `${r.manyCollection}.${r.manyField}`;
    if (relationKeys.has(key)) {
      errors.push(templateError('INVALID_TEMPLATE', `${at}.manyField`, `Duplicate relation "${key}".`));
    }
    relationKeys.add(key);
    const type = r.type ?? (r.junctionCollection ? 'm2m' : 'm2o');
    if (type === 'm2a') {
      errors.push(templateError('INCOMPATIBLE_RUNTIME', `${at}.type`, 'm2a relations are not supported in template v1.'));
    }
    const needCollection = (name: string | null | undefined, prop: string) => {
      if (name && !collections.has(name)) {
        errors.push(templateError('INVALID_TEMPLATE', `${at}.${prop}`, `Relation "${key}" points to undeclared collection "${name}".`));
      }
    };
    const needField = (collection: string | null | undefined, field: string | null | undefined, prop: string) => {
      if (collection && field && collections.has(collection) && !fields.has(`${collection}.${field}`)) {
        errors.push(templateError('INVALID_TEMPLATE', `${at}.${prop}`, `Relation "${key}" points to undeclared field "${collection}.${field}".`));
      }
    };
    needCollection(r.manyCollection, 'manyCollection');
    needCollection(r.oneCollection, 'oneCollection');
    needCollection(r.junctionCollection, 'junctionCollection');
    needField(r.manyCollection, r.manyField, 'manyField');
    needField(r.oneCollection, r.oneField, 'oneField');
    needField(r.junctionCollection, r.junctionManyField, 'junctionManyField');
    needField(r.junctionCollection, r.junctionOneField, 'junctionOneField');
    if (type === 'm2o') {
      const field = fields.get(key);
      if (field?.type === 'alias') {
        errors.push(templateError('INVALID_TEMPLATE', `${at}.manyField`, `m2o field "${key}" must store a value, not be an alias.`));
      }
      m2o.set(key, r.oneCollection);
    }
  });

  // ── Seed packs ───────────────────────────────────────────────────────────
  let seedBytes = 0;
  for (const [packName, pack] of Object.entries(t.seedPacks ?? {})) {
    const packAt = `$.seedPacks[${JSON.stringify(packName)}]`;
    const records = new Map<string, { collection: string; index: number }>();
    pack.records.forEach((record, index) => {
      if (records.has(record.key)) {
        errors.push(templateError('INVALID_TEMPLATE', `${packAt}.records[${index}].key`, `Duplicate record key "${record.key}".`));
      } else records.set(record.key, { collection: record.collection, index });
    });
    /** key → keys it requires (required non-null references), for cycle checks. */
    const requiredEdges = new Map<string, string[]>();
    pack.records.forEach((record, index) => {
      const at = `${packAt}.records[${index}]`;
      seedBytes += utf8ByteLength(JSON.stringify(record.values)) + utf8ByteLength(JSON.stringify(record.references ?? {}));
      if (!collections.has(record.collection)) {
        errors.push(templateError('INVALID_TEMPLATE', `${at}.collection`, `Seed record "${record.key}" targets an undeclared collection.`));
        return;
      }
      for (const [field, value] of Object.entries(record.values)) {
        const fkey = `${record.collection}.${field}`;
        const def = fields.get(fkey);
        const vat = `${at}.values[${JSON.stringify(field)}]`;
        if (!def) {
          errors.push(templateError('INVALID_TEMPLATE', vat, RESERVED_FIELD_NAMES.has(field)
            ? `"${field}" is generated at install; seed records never carry ids.`
            : `Field "${fkey}" is not declared.`));
        } else if (m2o.has(fkey)) {
          errors.push(templateError('INVALID_TEMPLATE', vat, `"${fkey}" is a relation; set it in references with a record key.`));
        } else if (def.type === 'alias') {
          errors.push(templateError('INVALID_TEMPLATE', vat, `Alias field "${fkey}" stores no value.`));
        } else if (def.type === 'hash') {
          errors.push(templateError('INVALID_TEMPLATE', vat, `Hash field "${fkey}" cannot be seeded; templates carry no secrets.`));
        } else if (!seedValueFits(def.type, value)) {
          errors.push(templateError('INVALID_TEMPLATE', vat, `Value does not fit field type "${def.type}".`));
        }
      }
      const edges: string[] = [];
      for (const [field, target] of Object.entries(record.references ?? {})) {
        const fkey = `${record.collection}.${field}`;
        const rat = `${at}.references[${JSON.stringify(field)}]`;
        const targetCollection = m2o.get(fkey);
        if (targetCollection === undefined) {
          errors.push(templateError('INVALID_TEMPLATE', rat, `"${fkey}" is not an m2o relation field of the template.`));
          continue;
        }
        if (target === null) continue;
        const resolved = records.get(target);
        if (!resolved) {
          errors.push(templateError('INVALID_TEMPLATE', rat, `Reference "${target}" is not a record of pack "${packName}"; external references are not allowed.`));
        } else if (resolved.collection !== targetCollection) {
          errors.push(templateError('INVALID_TEMPLATE', rat, `Reference "${target}" is a "${resolved.collection}" record; "${fkey}" points to "${targetCollection}".`));
        } else if (fields.get(fkey)?.required) {
          edges.push(target);
        }
      }
      requiredEdges.set(record.key, edges);
      // Required plain fields must be present (or have a default).
      for (const [fkey, def] of fields) {
        const [collection, field] = fkey.split('.') as [string, string];
        if (collection !== record.collection || !def.required || def.hasDefault || def.type === 'alias') continue;
        const present = m2o.has(fkey)
          ? typeof record.references?.[field] === 'string'
          : record.values[field] !== undefined && record.values[field] !== null;
        if (!present) {
          errors.push(templateError('INVALID_TEMPLATE', at, `Required field "${fkey}" is missing.`));
        }
      }
    });
    // Required references must be insertable in one pass: no cycles.
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (key: string, trail: string[]): void => {
      if (state.get(key) === 'done') return;
      if (state.get(key) === 'visiting') {
        const cycle = [...trail.slice(trail.indexOf(key)), key];
        const index = records.get(key)?.index ?? 0;
        errors.push(templateError(
          'INVALID_TEMPLATE',
          `${packAt}.records[${index}].references`,
          `Required references form a cycle (${cycle.join(' → ')}); one side must be optional.`,
        ));
        return;
      }
      state.set(key, 'visiting');
      for (const next of requiredEdges.get(key) ?? []) visit(next, [...trail, key]);
      state.set(key, 'done');
    };
    for (const key of requiredEdges.keys()) visit(key, []);
  }
  if (seedBytes > TEMPLATE_LIMITS.maxSeedValueBytes) {
    errors.push(templateError('LIMIT_EXCEEDED', '$.seedPacks', `Seed values are ${seedBytes} bytes; the limit is ${TEMPLATE_LIMITS.maxSeedValueBytes}.`));
  }
  return errors;
}

/** Validates an already-parsed value. Use {@link parseBackendTemplate} for raw JSON text. */
export function validateBackendTemplate(input: unknown, options: TemplateValidationOptions = {}): TemplateValidation {
  const early = preflight(input);
  if (early.length > 0) return { ok: false, errors: early };
  const parsed = BackendTemplateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error) };
  const errors = semanticErrors(parsed.data, options);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, template: parsed.data };
}

/**
 * The authoring entry point: raw JSON text → validated template. Duplicate
 * keys, size and depth are checked on the text (see `ingest.ts`).
 */
export function parseBackendTemplate(text: string, options: TemplateValidationOptions = {}): TemplateValidation {
  const ingested = ingestTemplateJson(text);
  if (!ingested.ok) return ingested;
  return validateBackendTemplate(ingested.value, options);
}
