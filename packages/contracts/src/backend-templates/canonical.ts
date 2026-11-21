import type { BackendTemplate } from './envelope';

/**
 * Canonical form and digest of a template (#901, BT01-W3, R2).
 *
 * - Object keys are sorted at every level.
 * - Keyed resource lists are sorted by their stable key: collections by
 *   `name`, fields by `collection.field`, relations by
 *   `manyCollection.manyField`, seed records by `key`, and
 *   `compatibility.storageModes` alphabetically. Their order carries no
 *   meaning (field display order is `sortOrder`).
 * - Every other array keeps its order (`special`, `conditions`, validation
 *   rules, JSON values…): there, order is data.
 * - Transport metadata (`config.exportedAt`) and empty v1-unsupported lists
 *   (`config.webhooks`, `config.settings`) are dropped.
 *
 * The digest is SHA-256 over the canonical UTF-8 bytes, seed packs included,
 * as `sha256:<hex>`. It is derived, never embedded in the document.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value as Json;
}

const byKey = <T>(key: (item: T) => string) => (a: T, b: T): number => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** The canonical template object (a deep copy; the input is not modified). */
export function canonicalTemplate(template: BackendTemplate): BackendTemplate {
  const t = JSON.parse(JSON.stringify(template)) as BackendTemplate;
  const config = t.config as BackendTemplate['config'] & Record<string, unknown>;
  delete config.exportedAt;
  if (Array.isArray(config.webhooks) && config.webhooks.length === 0) delete config.webhooks;
  if (Array.isArray(config.settings) && config.settings.length === 0) delete config.settings;
  config.collections.sort(byKey((c) => c.name));
  config.fields.sort(byKey((f) => `${f.collection}.${f.field}`));
  config.relations.sort(byKey((r) => `${r.manyCollection}.${r.manyField}`));
  t.compatibility.storageModes.sort();
  for (const pack of Object.values(t.seedPacks ?? {})) {
    pack.records.sort(byKey((r) => r.key));
  }
  return sortKeys(t) as unknown as BackendTemplate;
}

/** Canonical JSON text (no whitespace). */
export function canonicalTemplateJson(template: BackendTemplate): string {
  return JSON.stringify(canonicalTemplate(template));
}

/** `sha256:<hex>` of the canonical bytes. */
export async function templateDigest(template: BackendTemplate): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalTemplateJson(template));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Portable export: the canonical object. A validated template never holds
 * site ids, record ids or secrets (the contract refuses them), so the export
 * cannot either.
 */
export function exportBackendTemplate(template: BackendTemplate): BackendTemplate {
  return canonicalTemplate(template);
}
