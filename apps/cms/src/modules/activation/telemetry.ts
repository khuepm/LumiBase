/**
 * Anonymous usage telemetry — opt-in, off by default.
 *
 * What it is: on the hourly tick, an install that has opted in reports the
 * first time ANY of its sites reaches each activation milestone. At most four
 * requests in the lifetime of an install, each carrying exactly the fields of
 * `TelemetryEventSchema` (`@lumibase/contracts`) and nothing else.
 *
 * The switches, in the order they are evaluated:
 *
 *   1. `LUMIBASE_TELEMETRY_DISABLED` truthy → off. Wins over everything.
 *   2. `DO_NOT_TRACK` truthy                → off.
 *   3. `LUMIBASE_TELEMETRY_ENABLED` not truthy → off. This is the default.
 *   4. `LUMIBASE_TELEMETRY_ENDPOINT` unset or not a usable URL → off.
 *
 * There is no built-in endpoint: an operator has to name one. While the
 * emitter is off it does not touch the database at all — no install id is
 * generated, no state row exists, and `fetch` is never called.
 *
 * What it never reads: users, consents, items, API keys, hostnames, site ids.
 * The queries below return one timestamp each and the payload keeps only its
 * UTC day. User-level consent records (`modules/consent`) govern per-user
 * processing and are neither consulted nor overridden here, because no
 * per-user data is involved; the lawful switch for this feature is the
 * operator's, at instance level.
 *
 * Runtime-neutral: plain `fetch` and Web Crypto, driven by the same hourly
 * tick on Workers (`cloudflare.ts`) and Node (`serve.ts`).
 */

import { activationMilestones, agentRuns, items, sites, telemetryState } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventSchema,
  type TelemetryEvent,
  type TelemetryEventName,
} from '@lumibase/contracts';
import { and, eq, isNull, min, sql } from 'drizzle-orm';

const LOG_PREFIX = '[telemetry]';
const REQUEST_TIMEOUT_MS = 5_000;
const SINGLETON = 'singleton';

export type TelemetryEnv = Record<string, string | undefined>;

export type TelemetryOffReason = 'kill_switch' | 'do_not_track' | 'not_opted_in' | 'no_endpoint';

export type TelemetryConfig =
  | { active: false; reason: TelemetryOffReason }
  | { active: true; endpoint: string };

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/** `https:` anywhere; `http:` only to loopback (local testing of a collector). */
function usableEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.toString();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'http:' && loopback ? url.toString() : null;
}

export function resolveTelemetryConfig(env: TelemetryEnv): TelemetryConfig {
  if (truthy(env.LUMIBASE_TELEMETRY_DISABLED)) return { active: false, reason: 'kill_switch' };
  if (truthy(env.DO_NOT_TRACK)) return { active: false, reason: 'do_not_track' };
  if (!truthy(env.LUMIBASE_TELEMETRY_ENABLED)) return { active: false, reason: 'not_opted_in' };
  const endpoint = usableEndpoint(env.LUMIBASE_TELEMETRY_ENDPOINT);
  if (!endpoint) return { active: false, reason: 'no_endpoint' };
  return { active: true, endpoint };
}

export interface TelemetryRunDeps {
  /** System connection: the milestone lookups span every site on the install. */
  db: Database;
  env: TelemetryEnv;
  runtime: 'cloudflare' | 'docker';
  /** LumiBase version string; `unknown` when the build did not stamp one. */
  version: string;
  fetch?: typeof fetch;
}

export interface TelemetryRunResult {
  active: boolean;
  reason?: TelemetryOffReason;
  sent: TelemetryEventName[];
}

/** Earliest moment any site on the install reached the event's milestone. */
async function firstOccurrence(db: Database, event: TelemetryEventName): Promise<Date | null> {
  switch (event) {
    case 'first_site_created': {
      const [row] = await db.select({ at: min(sites.createdAt) }).from(sites);
      return row?.at ?? null;
    }
    case 'first_item_published': {
      // Unindexed across sites, but it runs at most hourly and only until the
      // event has gone out once.
      const [row] = await db
        .select({ at: min(items.updatedAt) })
        .from(items)
        .where(and(eq(items.status, 'published'), isNull(items.deletedAt)));
      return row?.at ?? null;
    }
    case 'first_agent_run': {
      const [row] = await db.select({ at: min(agentRuns.startedAt) }).from(agentRuns);
      return row?.at ?? null;
    }
    case 'first_delivery_request': {
      const [row] = await db
        .select({ at: min(activationMilestones.reachedAt) })
        .from(activationMilestones)
        .where(eq(activationMilestones.milestone, 'delivery_request'));
      return row?.at ?? null;
    }
  }
}

async function loadOrCreateState(db: Database): Promise<{ installId: string; sent: Record<string, string> }> {
  // UUID v4 on purpose: v7 would embed the creation time in the identifier.
  await db
    .insert(telemetryState)
    .values({ id: SINGLETON, installId: crypto.randomUUID() })
    .onConflictDoNothing({ target: telemetryState.id });
  const [row] = await db.select().from(telemetryState).where(eq(telemetryState.id, SINGLETON)).limit(1);
  if (!row) throw new Error('telemetry state row missing after insert');
  return { installId: row.installId, sent: row.sent ?? {} };
}

/** Build the request body for one event. Exported so tests can assert the shape. */
export function buildTelemetryEvent(input: {
  installId: string;
  event: TelemetryEventName;
  occurredAt: Date;
  version: string;
  runtime: 'cloudflare' | 'docker';
}): TelemetryEvent {
  return TelemetryEventSchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    installId: input.installId,
    event: input.event,
    occurredOn: input.occurredAt.toISOString().slice(0, 10),
    version: input.version.trim().slice(0, 64) || 'unknown',
    runtime: input.runtime,
  });
}

async function post(doFetch: typeof fetch, endpoint: string, body: TelemetryEvent): Promise<boolean> {
  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // Never follow a redirect to a host the operator did not name.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.ok;
}

/**
 * One telemetry pass. Best-effort: resolves with what was sent and never
 * throws, so it is safe on a cron tick. An event is marked sent only after the
 * endpoint answered 2xx; anything else is retried on a later tick.
 *
 * Overlapping ticks can deliver the same event twice (Workers has no leader
 * lock). The body is identical both times, so a collector dedupes on
 * `(installId, event)`.
 */
export async function runScheduledTelemetry(deps: TelemetryRunDeps): Promise<TelemetryRunResult> {
  const config = resolveTelemetryConfig(deps.env);
  // Off: return before touching the database or the network.
  if (!config.active) return { active: false, reason: config.reason, sent: [] };

  const doFetch = deps.fetch ?? fetch;
  const sent: TelemetryEventName[] = [];
  try {
    const state = await loadOrCreateState(deps.db);
    for (const event of TELEMETRY_EVENTS) {
      if (state.sent[event]) continue;
      const occurredAt = await firstOccurrence(deps.db, event);
      if (!occurredAt) continue;

      const body = buildTelemetryEvent({
        installId: state.installId,
        event,
        occurredAt,
        version: deps.version,
        runtime: deps.runtime,
      });

      let ok = false;
      try {
        ok = await post(doFetch, config.endpoint, body);
      } catch {
        ok = false;
      }
      if (!ok) continue;

      await deps.db
        .update(telemetryState)
        .set({
          sent: sql`${telemetryState.sent} || ${JSON.stringify({ [event]: body.occurredOn })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(telemetryState.id, SINGLETON));
      sent.push(event);
      console.info(`${LOG_PREFIX} sent ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} pass failed:`, err instanceof Error ? err.message : String(err));
  }
  return { active: true, sent };
}
