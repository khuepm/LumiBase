/**
 * Edge resolution of personalised content (#762).
 *
 * Per request: build the context, pick the audience from the site's
 * (cached) audience list, then key every cache tier by that audience only —
 * never by the raw attributes — so a site with three audiences has at most
 * four cached copies of a page, however many countries, tiers or campaigns
 * its visitors come with.
 */
import type { CacheProvider } from '@lumibase/runtime';
import { requestContext } from './context';
import { resolveAudience, type RequestContext } from './rules';
import type { AudienceRecord, PersonalisationRepository, VariantRecord } from './repo';

export const AUDIENCES_CACHE_TTL_SECONDS = 60;
/** Cache-key and edge-URL token for "no audience matched". */
export const DEFAULT_AUDIENCE_TOKEN = '_';
/** Synthetic query parameter that keys the edge copy by audience. */
export const EDGE_AUDIENCE_PARAM = '__aud';

export function audiencesCacheKey(siteId: string): string {
  return `personalisation:audiences:${siteId}`;
}

type CachedAudience = Pick<AudienceRecord, 'id' | 'key' | 'priority' | 'enabled' | 'rules'>;

/** The site's enabled audiences, from the app cache when possible. */
export async function loadAudiences(repo: PersonalisationRepository, cache: CacheProvider | undefined): Promise<CachedAudience[]> {
  const key = audiencesCacheKey(repo.siteId);
  if (cache) {
    try {
      const hit = await cache.get<CachedAudience[] | string>(key);
      if (hit) return typeof hit === 'string' ? (JSON.parse(hit) as CachedAudience[]) : hit;
    } catch {
      /* fall through to the database */
    }
  }
  const rows = (await repo.listAudiences())
    .filter((a) => a.enabled)
    .map(({ id, key: k, priority, enabled, rules }) => ({ id, key: k, priority, enabled, rules }));
  if (cache) {
    await cache.set(key, JSON.stringify(rows), { ttl: AUDIENCES_CACHE_TTL_SECONDS }).catch(() => undefined);
  }
  return rows;
}

export interface DeliveryAudience {
  /** The site uses personalisation (has at least one enabled audience). */
  active: boolean;
  audience: { id: string; key: string } | null;
  ctx: RequestContext;
  /** Audience key, or `_` for the default content. */
  token: string;
}

export async function resolveDeliveryAudience(opts: {
  repo: PersonalisationRepository;
  cache: CacheProvider | undefined;
  headers: Headers;
  url: URL;
}): Promise<DeliveryAudience> {
  const ctx = requestContext(opts.headers, opts.url);
  const list = await loadAudiences(opts.repo, opts.cache);
  if (list.length === 0) return { active: false, audience: null, ctx, token: DEFAULT_AUDIENCE_TOKEN };
  const hit = resolveAudience(list, ctx);
  return {
    active: true,
    audience: hit ? { id: hit.id, key: hit.key } : null,
    ctx,
    token: hit?.key ?? DEFAULT_AUDIENCE_TOKEN,
  };
}

/** Add the audience to the canonical edge URL so each audience gets its own edge copy. */
export function edgeUrlWithAudience(edgeUrl: string, token: string): string {
  const u = new URL(edgeUrl);
  u.searchParams.set(EDGE_AUDIENCE_PARAM, token);
  return u.toString();
}

/** Keys a variant may never override on a delivered item. */
const RESERVED_ITEM_KEYS = new Set(['id', 'status', 'sort', 'createdAt', 'updatedAt', '_provenance', '_seo', '_jsonLd']);

export function applyItemOverrides(item: Record<string, unknown>, overrides: unknown): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return item;
  const out = { ...item };
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (!RESERVED_ITEM_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export interface PageRowLike {
  id: string;
  title: string;
  slug: string;
  layoutConfig: unknown;
}

/** The page row with a published page variant's `title` / `layoutConfig` applied. */
export function applyPageVariant<T extends PageRowLike>(page: T, variant: VariantRecord | undefined): T {
  if (!variant) return page;
  const o = (variant.overrides ?? {}) as { title?: unknown; layoutConfig?: unknown };
  return {
    ...page,
    ...(typeof o.title === 'string' && o.title.length > 0 ? { title: o.title } : {}),
    ...(o.layoutConfig && typeof o.layoutConfig === 'object' ? { layoutConfig: o.layoutConfig } : {}),
  };
}

interface PayloadLike {
  sections: Array<{ data?: unknown }>;
}

/** Apply published item variants of `audienceId` to every item in the hydrated payload. Returns the variant ids used. */
export async function applyItemVariants(repo: PersonalisationRepository, payload: PayloadLike, audienceId: string): Promise<string[]> {
  const items: Array<Record<string, unknown>> = [];
  for (const section of payload.sections) {
    const list = (section.data as { items?: unknown } | undefined)?.items;
    if (Array.isArray(list)) items.push(...(list as Array<Record<string, unknown>>));
  }
  const ids = [...new Set(items.map((i) => i.id).filter((id): id is string => typeof id === 'string'))];
  const variants = await repo.publishedVariants('item', ids, audienceId);
  if (variants.length === 0) return [];
  const byItem = new Map(variants.map((v) => [v.subjectId, v]));
  for (const section of payload.sections) {
    const data = section.data as { items?: Array<Record<string, unknown>> } | undefined;
    if (!data?.items) continue;
    data.items = data.items.map((item) => {
      const v = byItem.get(item.id as string);
      return v ? applyItemOverrides(item, v.overrides) : item;
    });
  }
  return variants.map((v) => v.id);
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
