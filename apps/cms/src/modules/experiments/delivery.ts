/**
 * Edge resolution of A/B experiments (#763).
 *
 * Per request, before any cache tier: take the site's running experiments
 * (cached), keep the ones that can touch this page (page experiments on this
 * slug, every item experiment), and assign the visitor an arm from
 * `X-Lumi-Visitor`. Every cache tier is then keyed by the assigned arms, never
 * by the visitor id, so a page under a two-arm test has at most three copies.
 *
 * Assignment needs an analytics grant (`X-Lumi-Consent: analytics`, withdrawn
 * by DNT / Sec-GPC) and a visitor id. Without them the visitor gets the
 * control content, is not listed as in the experiment, and so is never
 * counted.
 */
import type { CacheProvider } from '@lumibase/runtime';
import { applyItemOverrides, applyPageVariant, type PageRowLike } from '../personalisation/delivery';
import type { ExperimentRepository, RunningExperiment } from './repo';
import { CONTROL_ARM, assignArm } from './stats';

export const RUNNING_CACHE_TTL_SECONDS = 60;
export const VISITOR_HEADER = 'x-lumi-visitor';
export const EXPERIMENTS_HEADER = 'X-Lumi-Experiments';
/** Synthetic query parameter that keys the edge copy by assigned arms. */
export const EDGE_EXPERIMENTS_PARAM = '__exp';
/** Token for "in no experiment, control content". */
export const UNASSIGNED = '_';
/** The visitor id is opaque, but bounded and URL-safe. */
const VISITOR_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function runningCacheKey(siteId: string): string {
  return `experiments:running:${siteId}`;
}

export async function loadRunning(repo: ExperimentRepository, cache: CacheProvider | undefined): Promise<RunningExperiment[]> {
  const key = runningCacheKey(repo.siteId);
  if (cache) {
    try {
      const hit = await cache.get<RunningExperiment[] | string>(key);
      if (hit) return typeof hit === 'string' ? (JSON.parse(hit) as RunningExperiment[]) : hit;
    } catch {
      /* fall through to the database */
    }
  }
  const rows = await repo.running();
  if (cache) await cache.set(key, JSON.stringify(rows), { ttl: RUNNING_CACHE_TTL_SECONDS }).catch(() => undefined);
  return rows;
}

export interface Assignment {
  experiment: RunningExperiment;
  /** Arm whose content is served (`control` when unassigned). */
  arm: string;
  /** The visitor is in the experiment (and may be counted). */
  assigned: boolean;
}

export interface DeliveryExperiments {
  active: boolean;
  assignments: Assignment[];
  /** Cache token: `key:arm` (or `key:_` unassigned) per relevant experiment, sorted. */
  token: string;
}

export const NO_EXPERIMENTS: DeliveryExperiments = { active: false, assignments: [], token: '' };

export async function resolveDeliveryExperiments(opts: {
  repo: ExperimentRepository;
  cache: CacheProvider | undefined;
  headers: Headers;
  slug: string;
  analyticsConsent: boolean;
}): Promise<DeliveryExperiments> {
  const list = await loadRunning(opts.repo, opts.cache);
  const relevant = list
    .filter((e) => e.subjectType === 'item' || e.pageSlug === opts.slug)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (relevant.length === 0) return NO_EXPERIMENTS;
  const raw = opts.headers.get(VISITOR_HEADER);
  const visitor = opts.analyticsConsent && raw && VISITOR_RE.test(raw) ? raw : null;
  const assignments = relevant.map((experiment): Assignment => {
    const arm = visitor ? assignArm(experiment.key, visitor, experiment.arms) : null;
    return arm ? { experiment, arm, assigned: true } : { experiment, arm: CONTROL_ARM, assigned: false };
  });
  return {
    active: true,
    assignments,
    token: assignments.map((a) => `${a.experiment.key}:${a.assigned ? a.arm : UNASSIGNED}`).join(','),
  };
}

export function edgeUrlWithExperiments(edgeUrl: string, token: string): string {
  const u = new URL(edgeUrl);
  u.searchParams.set(EDGE_EXPERIMENTS_PARAM, token);
  return u.toString();
}

function armOverrides(a: Assignment): unknown {
  return a.experiment.arms.find((x) => x.key === a.arm)?.overrides ?? {};
}

/** The page with the assigned page-experiment arm applied (over any audience variant). */
export function applyPageExperiment<T extends PageRowLike>(page: T, experiments: DeliveryExperiments): T {
  const hit = experiments.assignments.find((a) => a.experiment.subjectType === 'page' && a.experiment.subjectId === page.id);
  if (!hit || hit.arm === CONTROL_ARM) return page;
  return applyPageVariant(page, { overrides: armOverrides(hit) } as Parameters<typeof applyPageVariant>[1]);
}

interface PayloadLike {
  sections: Array<{ data?: unknown }>;
}

/**
 * Apply item-experiment arms to the hydrated items. Returns the experiments
 * that actually touched this page (page experiment + items present), for the
 * payload's `experiments` list.
 */
export function applyItemExperiments(payload: PayloadLike, experiments: DeliveryExperiments, pageId: string): Array<{ key: string; arm: string }> {
  const present = new Set<string>();
  const byItem = new Map(
    experiments.assignments.filter((a) => a.experiment.subjectType === 'item').map((a) => [a.experiment.subjectId, a]),
  );
  for (const section of payload.sections) {
    const data = section.data as { items?: Array<Record<string, unknown>> } | undefined;
    if (!Array.isArray(data?.items)) continue;
    data.items = data.items.map((item) => {
      const a = byItem.get(item.id as string);
      if (!a) return item;
      present.add(a.experiment.key);
      return a.arm === CONTROL_ARM ? item : applyItemOverrides(item, armOverrides(a));
    });
  }
  return experiments.assignments
    .filter((a) => a.assigned)
    .filter((a) => (a.experiment.subjectType === 'page' ? a.experiment.subjectId === pageId : present.has(a.experiment.key)))
    .map((a) => ({ key: a.experiment.key, arm: a.arm }));
}

/** `key=arm,key2=arm2` for the `X-Lumi-Experiments` header. */
export function experimentsHeaderValue(list: ReadonlyArray<{ key: string; arm: string }> | undefined): string | null {
  return list && list.length > 0 ? list.map((e) => `${e.key}=${e.arm}`).join(',') : null;
}
