/**
 * Studio intent registry (issue #759).
 *
 * Extensions claim intents with `IntentHandlerDefinition`s from
 * `@lumibase/extension-sdk`. A claim is only considered when the extension's
 * GRANTED capabilities (server-side subset of the manifest) cover it:
 *
 *   intents:claim:<action>:<collection>     either part may be `*`
 *
 * Resolution is deterministic and always ends somewhere internal:
 *   1. covered handlers whose `canHandle` returns a finite number > 0;
 *   2. highest priority first, ties broken by extension name then handler id;
 *   3. the winner's `handle` must return an internal path (open-redirect
 *      check) — a throw, an invalid path or `{ fallback: true }` falls back
 *      to the built-in route. Only the winner runs; a failing winner does not
 *      hand over to the runner-up, so the outcome never depends on timing.
 */
import type { IntentHandlerDefinition, IntentHandleResult } from '@lumibase/extension-sdk';
import { studioIntentRoute, type StudioIntent } from '@lumibase/contracts/intents';
import { toSafeInternalPath, isIntentPathname } from './paths';

interface RegisteredHandler {
  extension: string;
  capabilities: readonly string[];
  handler: IntentHandlerDefinition;
}

const handlers: RegisteredHandler[] = [];

const CLAIM_PREFIX = 'intents:claim:';

/** Whether granted `capabilities` let an extension claim `intent`. */
export function capabilitiesCoverIntent(
  capabilities: readonly string[],
  intent: Pick<StudioIntent, 'action' | 'collection'>,
): boolean {
  return capabilities.some((cap) => {
    if (!cap.startsWith(CLAIM_PREFIX)) return false;
    const [action, collection, ...extra] = cap.slice(CLAIM_PREFIX.length).split(':');
    if (extra.length > 0 || !action || !collection) return false;
    return (action === '*' || action === intent.action) && (collection === '*' || collection === intent.collection);
  });
}

/** True when any granted capability is an intent claim (worth loading the bundle for). */
export function hasIntentCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((cap) => cap.startsWith(CLAIM_PREFIX));
}

function isHandlerDefinition(value: unknown): value is IntentHandlerDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.canHandle === 'function' &&
    typeof v.handle === 'function'
  );
}

/**
 * Register an extension's handlers (replacing any previous registration for
 * that extension). Invalid entries are ignored; returns how many were kept.
 */
export function registerIntentHandlers(
  extension: string,
  capabilities: readonly string[],
  defs: unknown,
): number {
  unregisterIntentHandlers(extension);
  if (!Array.isArray(defs) || !hasIntentCapability(capabilities)) return 0;
  const seen = new Set<string>();
  let kept = 0;
  for (const def of defs) {
    if (!isHandlerDefinition(def) || seen.has(def.id)) continue;
    seen.add(def.id);
    handlers.push({ extension, capabilities: [...capabilities], handler: def });
    kept += 1;
  }
  return kept;
}

export function unregisterIntentHandlers(extension: string): void {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    if (handlers[i]?.extension === extension) handlers.splice(i, 1);
  }
}

export function clearIntentHandlers(): void {
  handlers.length = 0;
}

export interface IntentCandidate {
  extension: string;
  handlerId: string;
  priority: number;
}

function compare(a: IntentCandidate, b: IntentCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.extension !== b.extension) return a.extension < b.extension ? -1 : 1;
  if (a.handlerId !== b.handlerId) return a.handlerId < b.handlerId ? -1 : 1;
  return 0;
}

/** Ranked claims for an intent (exported for tests and diagnostics). */
export function rankIntentClaims(intent: StudioIntent): IntentCandidate[] {
  const out: IntentCandidate[] = [];
  for (const entry of handlers) {
    if (!capabilitiesCoverIntent(entry.capabilities, intent)) continue;
    let priority: unknown;
    try {
      priority = entry.handler.canHandle({ ...intent });
    } catch {
      continue;
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority) || priority <= 0) continue;
    out.push({ extension: entry.extension, handlerId: entry.handler.id, priority });
  }
  return out.sort(compare);
}

export type IntentResolution =
  | { source: 'built-in'; path: string; reason?: 'no_claim' | 'handler_error' | 'unsafe_target' | 'declined' }
  | { source: 'extension'; path: string; extension: string; handlerId: string };

function builtInPath(intent: StudioIntent): string {
  const route = studioIntentRoute(intent);
  const params = new URLSearchParams();
  if (route.search.locale) params.set('locale', route.search.locale);
  if (route.search.field) params.set('field', route.search.field);
  const qs = params.toString();
  return qs ? `${route.pathname}?${qs}` : route.pathname;
}

/** Resolve an intent to an admin-relative internal path. Never throws. */
export async function resolveIntent(intent: StudioIntent, siteId: string): Promise<IntentResolution> {
  const fallback = builtInPath(intent);
  const [winner] = rankIntentClaims(intent);
  if (!winner) return { source: 'built-in', path: fallback, reason: 'no_claim' };
  const entry = handlers.find(
    (h) => h.extension === winner.extension && h.handler.id === winner.handlerId,
  );
  if (!entry) return { source: 'built-in', path: fallback, reason: 'no_claim' };

  let result: IntentHandleResult;
  try {
    result = await entry.handler.handle({ ...intent }, { siteId, builtInPath: fallback });
  } catch {
    return { source: 'built-in', path: fallback, reason: 'handler_error' };
  }
  if (!result || typeof result !== 'object' || 'fallback' in result) {
    return { source: 'built-in', path: fallback, reason: 'declined' };
  }
  const target = toSafeInternalPath((result as { navigate?: unknown }).navigate);
  // An intent path would re-enter resolution; refuse it like any unsafe target.
  if (!target || isIntentPathname(target.split('?')[0] ?? '')) {
    return { source: 'built-in', path: fallback, reason: 'unsafe_target' };
  }
  return { source: 'extension', path: target, extension: entry.extension, handlerId: entry.handler.id };
}
