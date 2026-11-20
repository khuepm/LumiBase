/**
 * A/B experiment reporting for the public site (#763).
 *
 * The CMS delivery API tells the frontend which arms it was served
 * (`X-Lumi-Experiments: key=arm,…` and `experiments` in the payload). This
 * reports exposures and conversions to the CMS beacon
 * `POST /api/v1/experiment-events/:site_id`, under the same rule as the tag:
 * nothing is sent without an explicit analytics grant.
 *
 * The visitor id is the site's own opaque, first-party id (the same one it
 * sends as `X-Lumi-Visitor` to the delivery API); this package does not create
 * or store one. The CMS counts each visitor once per experiment: one exposure,
 * at most one conversion (with the experiment's goal) after it.
 */
import type { ConsentDecision } from './consent';

export interface ExperimentArm {
  key: string;
  arm: string;
}

export type ExperimentEventKind = 'exposure' | 'conversion';

export interface ExperimentEvent extends ExperimentArm {
  kind: ExperimentEventKind;
  /** Conversions: the experiment's goal name. */
  goal?: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Parse `X-Lumi-Experiments` (`hero=b,cta=control`). Malformed pairs are dropped. */
export function experimentsFromHeaders(headers: Pick<Headers, 'get'>): ExperimentArm[] {
  const raw = headers.get('x-lumi-experiments');
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => pair.trim().split('='))
    .filter((p): p is [string, string] => p.length === 2 && KEY_RE.test(p[0]!) && KEY_RE.test(p[1]!))
    .map(([key, arm]) => ({ key, arm }));
}

export interface SendExperimentEventsOptions {
  /** CMS origin, e.g. `https://cms.example.com`. */
  cmsUrl: string;
  siteId: string;
  /** The visitor id the page was delivered with (`X-Lumi-Visitor`), 8–128 URL-safe characters. */
  visitor: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Report events (at most 10 per call, as the beacon accepts). Returns `false`
 * and sends nothing without a grant or without events.
 */
export async function sendExperimentEvents(
  consent: ConsentDecision | null,
  events: readonly ExperimentEvent[],
  opts: SendExperimentEventsOptions,
): Promise<boolean> {
  if (consent !== 'granted' || events.length === 0 || !/^[A-Za-z0-9_-]{8,128}$/.test(opts.visitor)) return false;
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return false;
  const url = `${opts.cmsUrl.replace(/\/+$/, '')}/api/v1/experiment-events/${encodeURIComponent(opts.siteId)}`;
  const body = {
    events: events.slice(0, 10).map((e) => ({
      experiment: e.key,
      arm: e.arm,
      kind: e.kind,
      ...(e.kind === 'conversion' && e.goal ? { goal: e.goal } : {}),
    })),
  };
  try {
    const res = await doFetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Lumi-Consent': 'analytics', 'X-Lumi-Visitor': opts.visitor },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Exposure events for every arm a delivery response says was served. */
export function exposuresFor(arms: readonly ExperimentArm[]): ExperimentEvent[] {
  return arms.map((a) => ({ ...a, kind: 'exposure' }));
}

/** Conversion events for a goal, for every arm the visitor is in. */
export function conversionsFor(arms: readonly ExperimentArm[], goal: string): ExperimentEvent[] {
  return arms.map((a) => ({ ...a, kind: 'conversion', goal }));
}
