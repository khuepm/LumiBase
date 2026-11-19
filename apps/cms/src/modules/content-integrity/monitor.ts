/**
 * Content-integrity monitor (#989).
 *
 * Runs after a write leaves content live (an item that is `published`, or a
 * delivery page) and answers: does what just went live look like an
 * injection? It combines the content scan (`scan.ts`: download links and
 * off-site canonical / OG URLs) with a site-wide publish-burst check, and acts
 * on the site's policy:
 *
 *   - `notify` (default): one `content_integrity_alert` audit row per write
 *     that raised a signal — filterable in Studio's security audit tab;
 *   - `unpublish`: the same alert, and an item whose content carries a
 *     download link or off-site SEO URL is returned to `draft` (its revision
 *     is kept) instead of staying live. Bursts only notify: volume alone is
 *     not proof.
 *
 * Agent-authored content that raises a signal also records an autonomy
 * incident for the agent role, which demotes its grant (Req 12.6, #991).
 *
 * Policy lives in the site setting `contentIntegrity`:
 *   { enabled?: boolean, action?: 'notify' | 'unpublish',
 *     allowedHosts?: string[], burstThreshold?: number, burstWindowMinutes?: number }
 *
 * The monitor never throws: a failure to check must not fail the write. It
 * fails open for that reason, and logs.
 */
import { and, count, eq, gte, isNull } from 'drizzle-orm';
import { agentRuns, items, scopeSite, settings, siteDomains, type Database } from '@lumibase/database';
import { AuditLogger } from '../audit/logger';
import { scanContent, type ContentIntegritySignal } from './scan';

export const CONTENT_INTEGRITY_EVENT = 'content_integrity_alert';
export const CONTENT_INTEGRITY_SETTING = 'contentIntegrity';

export interface ContentIntegrityPolicy {
  enabled: boolean;
  action: 'notify' | 'unpublish';
  allowedHosts: string[];
  burstThreshold: number;
  burstWindowMinutes: number;
}

export const DEFAULT_CONTENT_INTEGRITY_POLICY: ContentIntegrityPolicy = {
  enabled: true,
  action: 'notify',
  allowedHosts: [],
  burstThreshold: 25,
  burstWindowMinutes: 10,
};

export interface ContentIntegrityActor {
  type: 'user' | 'agent' | 'api_key' | 'system';
  userId?: string | null;
  runId?: string | null;
}

export interface ContentIntegrityInput {
  /** `items` collection name, or `lumibase_pages` for a delivery page. */
  collection: string;
  itemId: string;
  content: unknown;
  /** True when this write took the item live for the first time. */
  firstPublish: boolean;
}

export interface ContentIntegrityOutcome {
  signals: ContentIntegritySignal[];
  /** The caller should take the content out of delivery. */
  unpublish: boolean;
}

export interface ContentIntegrityDeps {
  db: Database;
  siteId: string;
  actor: ContentIntegrityActor;
  /** Injected in tests; defaults to a site-scoped {@link AuditLogger}. */
  audit?: (entry: { event: string; metadata: Record<string, unknown> }) => Promise<void>;
  /** Injected in tests; defaults to `AutonomyService.recordIncident`. */
  recordIncident?: (input: { agentRole: string; capability: string; runId: string | null; detail: Record<string, unknown> }) => Promise<void>;
}

const NONE: ContentIntegrityOutcome = { signals: [], unpublish: false };

export function parseContentIntegrityPolicy(value: unknown): ContentIntegrityPolicy {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);
  return {
    enabled: raw.enabled !== false,
    action: raw.action === 'unpublish' ? 'unpublish' : 'notify',
    allowedHosts: Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.filter((h): h is string => typeof h === 'string' && h.length > 0).slice(0, 100)
      : [],
    burstThreshold: positive(raw.burstThreshold, DEFAULT_CONTENT_INTEGRITY_POLICY.burstThreshold),
    burstWindowMinutes: positive(raw.burstWindowMinutes, DEFAULT_CONTENT_INTEGRITY_POLICY.burstWindowMinutes),
  };
}

export async function checkContentIntegrity(
  deps: ContentIntegrityDeps,
  input: ContentIntegrityInput,
): Promise<ContentIntegrityOutcome> {
  try {
    const policy = await loadPolicy(deps);
    if (!policy.enabled) return NONE;

    const hosts = [...policy.allowedHosts, ...(await siteHosts(deps))];
    const signals = scanContent(input.content, { siteHosts: hosts });

    if (input.firstPublish && input.collection !== 'lumibase_pages') {
      const published = await recentFirstPublishes(deps, policy.burstWindowMinutes);
      // Alert when the count crosses the threshold, and again at each further
      // multiple of it — not on every publish of a busy legitimate import.
      if (published > policy.burstThreshold && (published - policy.burstThreshold - 1) % policy.burstThreshold === 0) {
        signals.push({ kind: 'publish_burst', count: published });
      }
    }
    if (signals.length === 0) return NONE;

    const contentSignal = signals.some((s) => s.kind !== 'publish_burst');
    const unpublish = policy.action === 'unpublish' && contentSignal;

    await (deps.audit ?? defaultAudit(deps))({
      event: CONTENT_INTEGRITY_EVENT,
      metadata: {
        collection: input.collection,
        itemId: input.itemId,
        signals,
        action: unpublish ? 'unpublished' : 'notified',
        actorType: deps.actor.type,
        userId: deps.actor.userId ?? null,
        runId: deps.actor.runId ?? null,
      },
    });

    if (deps.actor.type === 'agent' && deps.actor.runId && contentSignal) {
      await demoteAgent(deps, input, signals);
    }
    return { signals, unpublish };
  } catch (err) {
    console.error('[content-integrity] check failed', err instanceof Error ? err.message : String(err));
    return NONE;
  }
}

async function loadPolicy(deps: ContentIntegrityDeps): Promise<ContentIntegrityPolicy> {
  const [row] = await deps.db
    .select({ value: settings.value })
    .from(settings)
    .where(and(scopeSite(settings.siteId, deps.siteId), eq(settings.key, CONTENT_INTEGRITY_SETTING)))
    .limit(1);
  return parseContentIntegrityPolicy(row?.value);
}

async function siteHosts(deps: ContentIntegrityDeps): Promise<string[]> {
  const rows = await deps.db
    .select({ hostname: siteDomains.hostname })
    .from(siteDomains)
    .where(eq(siteDomains.siteId, deps.siteId))
    .limit(100);
  return rows.map((r) => r.hostname);
}

async function recentFirstPublishes(deps: ContentIntegrityDeps, windowMinutes: number): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const [row] = await deps.db
    .select({ n: count() })
    .from(items)
    .where(and(eq(items.siteId, deps.siteId), gte(items.firstPublishedAt, since), isNull(items.deletedAt)));
  return Number(row?.n ?? 0);
}

async function demoteAgent(deps: ContentIntegrityDeps, input: ContentIntegrityInput, signals: ContentIntegritySignal[]): Promise<void> {
  const [run] = await deps.db
    .select({ agentName: agentRuns.agentName })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, deps.actor.runId!), eq(agentRuns.siteId, deps.siteId)))
    .limit(1);
  if (!run?.agentName) return;
  const detail = { collection: input.collection, itemId: input.itemId, signals: signals.map((s) => s.kind) };
  const record = deps.recordIncident ?? (async (incident) => {
    const { AutonomyService } = await import('../../services/autonomy-service');
    const autonomy = new AutonomyService({ db: deps.db, siteId: deps.siteId });
    await autonomy.recordIncident({ ...incident, source: 'content_integrity', severity: 'high' });
  });
  // The grant that let it publish is the one to lower.
  for (const capability of ['items:update', 'items:create']) {
    await record({ agentRole: run.agentName, capability, runId: deps.actor.runId ?? null, detail });
  }
}

function defaultAudit(deps: ContentIntegrityDeps) {
  return async (entry: { event: string; metadata: Record<string, unknown> }) => {
    await new AuditLogger({ db: deps.db, siteId: deps.siteId }).write({
      event: entry.event,
      actorEmail: null,
      ip: null,
      userAgent: null,
      requestId: null,
      metadata: entry.metadata,
    });
  };
}
