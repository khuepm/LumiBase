import { z } from 'zod';
import { SEED_PACK_NAME_RE, SEMVER_RE, TEMPLATE_SLUG_RE, type BackendTemplate } from './envelope';
import { RESERVED_COLLECTION_PREFIXES, TEMPLATE_NAME_RE } from './validate';
import { templateError, type TemplateError } from './errors';

/**
 * Plan contract (#903, BT03): what a caller asks for when planning an install,
 * and the pure pieces of planning — namespace rewriting and CMS version
 * ranges. Shared by REST, MCP (#906) and Studio (#908).
 */

/** Which template: an exact catalog + slug + version, optionally pinned by digest. */
export const TemplateRefSchema = z
  .object({
    /** `official` = bundled with the CMS; `site` = a site's private catalog. */
    source: z.enum(['official', 'site']),
    /** The catalog site of a private template; defaults to the target site. */
    sourceSiteId: z.string().min(1).max(64).optional(),
    slug: z.string().min(1).max(64).regex(TEMPLATE_SLUG_RE).optional(),
    /** Alternative to `slug`; must match exactly one template, else AMBIGUOUS_TEMPLATE. */
    displayName: z.string().trim().min(1).max(120).optional(),
    version: z.string().max(128).regex(SEMVER_RE),
    /** Optional pin: the plan fails unless the revision has this digest. */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((ref) => Boolean(ref.slug) !== Boolean(ref.displayName), {
    message: 'Give exactly one of slug or displayName.',
  });

/**
 * Collection names in the target. `map` renames individual collections;
 * `prefix` is prepended to every other one. Only structural references are
 * rewritten (collection names in collections, fields, relations and seed
 * records) — never text that happens to contain the old name.
 */
export const TemplateNamespaceSchema = z
  .object({
    prefix: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).optional(),
    map: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const TemplatePlanInputSchema = z
  .object({
    template: TemplateRefSchema,
    /** Required and explicit: must equal the site of the request. */
    targetSiteId: z.string().min(1).max(64),
    namespace: TemplateNamespaceSchema.optional(),
    /**
     * `none` (the default at every boundary) installs schema only, even when the
     * template has packs; `pack` installs `seedPack`. Contradictory input —
     * `none` with a pack, or `pack` without one — is refused.
     */
    seedMode: z.enum(['none', 'pack']).optional(),
    /** Seed pack to install with `seedMode: 'pack'`. */
    seedPack: z.string().regex(SEED_PACK_NAME_RE).nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.seedMode === 'none' && input.seedPack) {
      ctx.addIssue({ code: 'custom', path: ['seedPack'], message: 'seedMode "none" installs no seed; omit seedPack or use seedMode "pack".' });
    }
    if (input.seedMode === 'pack' && !input.seedPack) {
      ctx.addIssue({ code: 'custom', path: ['seedPack'], message: 'seedMode "pack" needs a seedPack name.' });
    }
  });

/** The seed pack a plan input selects, or null (schema only). */
export function selectedSeedPack(input: Pick<TemplatePlanInput, 'seedMode' | 'seedPack'>): string | null {
  if (input.seedMode === 'none') return null;
  return input.seedPack ?? null;
}

export type TemplateRef = z.infer<typeof TemplateRefSchema>;
export type TemplateNamespace = z.infer<typeof TemplateNamespaceSchema>;
export type TemplatePlanInput = z.infer<typeof TemplatePlanInputSchema>;

/** Template collection name → target collection name, for every collection. */
export function namespaceMap(
  template: BackendTemplate,
  namespace: TemplateNamespace | undefined,
): { map: Record<string, string>; errors: TemplateError[] } {
  const errors: TemplateError[] = [];
  const names = template.config.collections.map((c) => c.name);
  const known = new Set(names);
  for (const from of Object.keys(namespace?.map ?? {})) {
    if (!known.has(from)) errors.push(templateError('INVALID_TEMPLATE', `$.namespace.map[${JSON.stringify(from)}]`, `"${from}" is not a collection of the template.`));
  }
  const map: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const name of names) {
    const target = namespace?.map?.[name] ?? `${namespace?.prefix ?? ''}${name}`;
    const at = `$.namespace.map[${JSON.stringify(name)}]`;
    if (!TEMPLATE_NAME_RE.test(target)) {
      errors.push(templateError('INVALID_TEMPLATE', at, `Target name "${target}" must match ${TEMPLATE_NAME_RE}.`));
    }
    const reserved = RESERVED_COLLECTION_PREFIXES.find((p) => target.startsWith(p));
    if (reserved) errors.push(templateError('INVALID_TEMPLATE', at, `Target name "${target}" uses the reserved prefix "${reserved}".`));
    const clash = seen.get(target);
    if (clash) errors.push(templateError('INVALID_TEMPLATE', at, `"${name}" and "${clash}" would both become "${target}".`));
    seen.set(target, name);
    map[name] = target;
  }
  return { map, errors };
}

/**
 * Returns a copy of the template with every structural collection reference
 * renamed. Field names, descriptions, notes, options, display templates and
 * seed values are untouched.
 */
export function applyNamespace(template: BackendTemplate, map: Record<string, string>): BackendTemplate {
  const t = JSON.parse(JSON.stringify(template)) as BackendTemplate;
  const rename = (name: string) => map[name] ?? name;
  for (const c of t.config.collections) c.name = rename(c.name);
  for (const f of t.config.fields) f.collection = rename(f.collection);
  for (const r of t.config.relations) {
    r.manyCollection = rename(r.manyCollection);
    r.oneCollection = rename(r.oneCollection);
    if (r.junctionCollection) r.junctionCollection = rename(r.junctionCollection);
  }
  for (const pack of Object.values(t.seedPacks ?? {})) {
    for (const record of pack.records) record.collection = rename(record.collection);
  }
  return t;
}

// ── SemVer ranges (node-semver subset) ─────────────────────────────────────

type Version = [number, number, number, string[]];

function parseVersion(v: string): Version | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  const pa = a[3];
  const pb = b[3];
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length; // release > prerelease
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]!) ? Number(pa[i]) : NaN;
    const nb = /^\d+$/.test(pb[i]!) ? Number(pb[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/** Partial version `1`, `1.2`, `1.2.x` → lower bound and the next excluded bound. */
function partial(text: string): { lo: Version; hi: Version | null } | null {
  const parts = text.split('.');
  if (parts.length > 3 || parts.some((p) => !/^(\d+|x|X|\*)$/.test(p.split('-')[0]!))) {
    const full = parseVersion(text);
    return full ? { lo: full, hi: null } : null;
  }
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : null));
  const fixed = nums.findIndex((n) => n === null);
  const count = fixed === -1 ? nums.length : fixed;
  if (count === 3) return { lo: [nums[0]!, nums[1]!, nums[2]!, []], hi: null };
  const lo: Version = [nums[0] ?? 0, count > 1 ? nums[1]! : 0, 0, []];
  if (count === 0) return { lo: [0, 0, 0, []], hi: null };
  const hi: Version = count === 1 ? [lo[0] + 1, 0, 0, []] : [lo[0], lo[1] + 1, 0, []];
  return { lo, hi };
}

function satisfiesComparator(v: Version, comp: string): boolean | null {
  if (comp === '' || comp === '*' || comp === 'x' || comp === 'X') return true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/.exec(comp);
  if (!m) return null;
  const op = m[1] ?? '=';
  const p = partial(m[2]!);
  if (!p) return null;
  const { lo, hi } = p;
  switch (op) {
    case '>=': return compare(v, lo) >= 0;
    case '>': return hi ? compare(v, hi) >= 0 : compare(v, lo) > 0;
    case '<': return compare(v, lo) < 0;
    case '<=': return hi ? compare(v, hi) < 0 : compare(v, lo) <= 0;
    case '=': return compare(v, lo) >= 0 && (hi ? compare(v, hi) < 0 : compare(v, lo) === 0);
    case '~': {
      const upper: Version = hi ?? [lo[0], lo[1] + 1, 0, []];
      return compare(v, lo) >= 0 && compare(v, upper) < 0;
    }
    case '^': {
      const upper: Version = lo[0] > 0 ? [lo[0] + 1, 0, 0, []] : lo[1] > 0 ? [0, lo[1] + 1, 0, []] : (hi ?? [0, 0, lo[2] + 1, []]);
      return compare(v, lo) >= 0 && compare(v, upper) < 0;
    }
    default: return null;
  }
}

/**
 * Whether `version` satisfies `range`. Supports `*`, `x`, partial versions,
 * `>=`/`>`/`<`/`<=`/`=`, `^`, `~`, space-separated AND and `||` OR.
 * Returns `null` when the version or range cannot be parsed.
 */
export function satisfiesVersionRange(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  let any = false;
  for (const alternative of range.split('||')) {
    const comps = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    let all = true;
    for (const comp of comps.length > 0 ? comps : ['*']) {
      const result = satisfiesComparator(v, comp);
      if (result === null) return null;
      if (!result) all = false;
    }
    if (all) any = true;
  }
  return any;
}
