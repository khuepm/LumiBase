/**
 * config-diff.ts — pure (DB-free) validation and diffing for {@link ConfigManifest}.
 *
 * Diffing compares an incoming manifest against the *canonical serialization of
 * the current DB state* (both produced by `serializeConfig`). Comparing two
 * canonical manifests by stable key — rather than re-deriving schema-service's
 * per-field risk — makes the round-trip property (Req 6.1) hold by construction:
 * exporting then re-importing yields all-`unchanged`.
 *
 * Risk classification (Req 3.7) is layered on top: destructive transitions
 * (delete with data, field type change, widening onDelete to cascade) are
 * flagged `high` so apply can block them without `allowDestructive`.
 */

import {
  type CollectionConfig,
  type ConfigManifest,
  type FieldConfig,
  type RelationConfig,
  type SettingConfig,
  type WebhookConfig,
  stableKey,
} from '@lumibase/contracts/schemas';
import { canonicalize } from './config-serialize';

export type ApplyMode = 'merge' | 'replace-managed' | 'replace-all';
export type DiffStatus = 'create' | 'update' | 'unchanged' | 'delete';
export type DiffRisk = 'low' | 'medium' | 'high';

export interface DiffEntry {
  key: string;
  status: DiffStatus;
  risk: DiffRisk;
  /** Field-level changes for `update` (best-effort, shallow). */
  changes?: string[];
}

export interface ResourceDiff {
  create: number;
  update: number;
  unchanged: number;
  delete: number;
  entries: DiffEntry[];
}

export interface ConfigDiff {
  collections: ResourceDiff;
  fields: ResourceDiff;
  relations: ResourceDiff;
  webhooks: ResourceDiff;
  settings: ResourceDiff;
  /** Highest risk across every entry — apply blocks `high` unless allowed. */
  risk: DiffRisk;
  /** True when nothing would change (all-unchanged). */
  clean: boolean;
}

export interface ValidationIssue {
  code: 'UNSUPPORTED_MANIFEST_VERSION' | 'DANGLING_REFERENCE' | 'DUPLICATE_KEY';
  path: string;
  message: string;
}

const RISK_ORDER: Record<DiffRisk, number> = { low: 0, medium: 1, high: 2 };

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Shallow list of changed top-level keys between two records. */
function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (stableJson(a[k]) !== stableJson(b[k])) out.push(k);
  }
  return out.sort();
}

/**
 * Validate cross-resource integrity (Req 2.2–2.5). Zod shape validation happens
 * earlier via `parseConfigManifest`; this catches dangling references and
 * duplicate stable keys, which Zod can't express. `existingCollections` is the
 * set of collection names already in the DB (so a field may reference a
 * collection that exists in the DB even if not in the manifest).
 */
export function validateManifestIntegrity(
  manifest: ConfigManifest,
  existingCollections: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Duplicate stable keys.
  const dupCheck = <T>(items: T[], key: (t: T) => string, label: string) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const k = key(item);
      if (seen.has(k)) {
        issues.push({ code: 'DUPLICATE_KEY', path: `${label}[${i}]`, message: `Duplicate ${label} key "${k}".` });
      }
      seen.add(k);
    });
  };
  dupCheck(manifest.collections, stableKey.collection, 'collections');
  dupCheck(manifest.fields, stableKey.field, 'fields');
  dupCheck(manifest.relations, stableKey.relation, 'relations');
  dupCheck(manifest.webhooks, stableKey.webhook, 'webhooks');
  dupCheck(manifest.settings, stableKey.setting, 'settings');

  // Known collections = manifest collections ∪ existing DB collections.
  const known = new Set<string>(existingCollections);
  for (const c of manifest.collections) known.add(c.name);

  manifest.fields.forEach((f, i) => {
    if (!known.has(f.collection)) {
      issues.push({
        code: 'DANGLING_REFERENCE',
        path: `fields[${i}]`,
        message: `Field "${stableKey.field(f)}" references unknown collection "${f.collection}".`,
      });
    }
  });
  manifest.relations.forEach((r, i) => {
    for (const [side, col] of [
      ['manyCollection', r.manyCollection],
      ['oneCollection', r.oneCollection],
      ['junctionCollection', r.junctionCollection],
    ] as const) {
      if (col && !known.has(col)) {
        issues.push({
          code: 'DANGLING_REFERENCE',
          path: `relations[${i}].${side}`,
          message: `Relation "${stableKey.relation(r)}" references unknown collection "${col}".`,
        });
      }
    }
  });

  return issues;
}

function riskForCollectionDelete(): DiffRisk {
  // Deleting a collection drops all its items — always destructive.
  return 'high';
}

function riskForFieldChange(prev: FieldConfig | undefined, next: FieldConfig | undefined): DiffRisk {
  if (prev && !next) return 'high'; // delete a field → data loss
  if (prev && next && prev.type !== next.type) return 'high'; // type change → migration
  if (!prev && next) return next.nullable === false ? 'medium' : 'low'; // add non-null = medium
  return 'low';
}

function riskForRelationChange(prev: RelationConfig | undefined, next: RelationConfig | undefined): DiffRisk {
  if (prev && !next) return 'medium';
  // Widening to cascade enlarges the blast radius of deletes.
  if (next?.onDelete === 'cascade' && prev?.onDelete !== 'cascade') return 'high';
  return 'low';
}

function diffResource<T>(
  incoming: T[],
  current: T[],
  key: (t: T) => string,
  mode: ApplyMode,
  managedScopes: Set<string> | null,
  scopeOf: (t: T) => string | null,
  riskOf: (prev: T | undefined, next: T | undefined, status: DiffStatus) => DiffRisk,
): ResourceDiff {
  const currentByKey = new Map(current.map((c) => [key(c), c]));
  const incomingByKey = new Map(incoming.map((c) => [key(c), c]));
  const entries: DiffEntry[] = [];

  for (const item of incoming) {
    const k = key(item);
    const existing = currentByKey.get(k);
    if (!existing) {
      entries.push({ key: k, status: 'create', risk: riskOf(undefined, item, 'create') });
    } else if (stableJson(existing) === stableJson(item)) {
      entries.push({ key: k, status: 'unchanged', risk: 'low' });
    } else {
      entries.push({
        key: k,
        status: 'update',
        risk: riskOf(existing, item, 'update'),
        changes: changedKeys(existing as Record<string, unknown>, item as Record<string, unknown>),
      });
    }
  }

  // Deletions: in DB but not in manifest. Only proposed when mode allows.
  for (const item of current) {
    const k = key(item);
    if (incomingByKey.has(k)) continue;
    const inScope =
      mode === 'replace-all' ||
      (mode === 'replace-managed' && managedScopes !== null && (scopeOf(item) === null || managedScopes.has(scopeOf(item)!)));
    if (inScope) {
      entries.push({ key: k, status: 'delete', risk: riskOf(item, undefined, 'delete') });
    }
    // merge mode: silently keep (no entry) per Req 3.6.
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return {
    create: entries.filter((e) => e.status === 'create').length,
    update: entries.filter((e) => e.status === 'update').length,
    unchanged: entries.filter((e) => e.status === 'unchanged').length,
    delete: entries.filter((e) => e.status === 'delete').length,
    entries,
  };
}

/**
 * Compute the diff between an incoming manifest and the current state (already
 * serialized to a canonical manifest by the caller). Pure — no DB.
 */
export function buildConfigDiff(
  incoming: ConfigManifest,
  current: ConfigManifest,
  mode: ApplyMode,
): ConfigDiff {
  const managedScopes = incoming.managedScopes ? new Set(incoming.managedScopes) : null;

  const collections = diffResource<CollectionConfig>(
    incoming.collections,
    current.collections,
    stableKey.collection,
    mode,
    managedScopes,
    (c) => c.name,
    (_p, _n, status) => (status === 'delete' ? riskForCollectionDelete() : status === 'create' ? 'low' : 'medium'),
  );
  const fields = diffResource<FieldConfig>(
    incoming.fields,
    current.fields,
    stableKey.field,
    mode,
    managedScopes,
    (f) => f.collection,
    (p, n) => riskForFieldChange(p, n),
  );
  const relations = diffResource<RelationConfig>(
    incoming.relations,
    current.relations,
    stableKey.relation,
    mode,
    managedScopes,
    (r) => r.manyCollection,
    (p, n) => riskForRelationChange(p, n),
  );
  const webhooks = diffResource<WebhookConfig>(
    incoming.webhooks,
    current.webhooks,
    stableKey.webhook,
    mode,
    managedScopes,
    () => null,
    () => 'low',
  );
  const settings = diffResource<SettingConfig>(
    incoming.settings,
    current.settings,
    stableKey.setting,
    mode,
    managedScopes,
    () => null,
    () => 'low',
  );

  const all = [collections, fields, relations, webhooks, settings];
  const risk = all
    .flatMap((r) => r.entries)
    .reduce<DiffRisk>((max, e) => (RISK_ORDER[e.risk] > RISK_ORDER[max] ? e.risk : max), 'low');
  const clean = all.every((r) => r.create === 0 && r.update === 0 && r.delete === 0);

  return { collections, fields, relations, webhooks, settings, risk, clean };
}

/** True if the diff contains any `high`-risk destructive change. */
export function hasDestructiveChange(diff: ConfigDiff): boolean {
  return diff.risk === 'high';
}
