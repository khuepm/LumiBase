import { AsyncLocalStorage } from 'node:async_hooks';
import { v7 as uuidv7 } from 'uuid';
import type { TenantRef, UsageAttributes, UsageEvent, UsageUnit } from '@lumibase/contracts/platform';
import type { Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import { siteOrganizationId } from '../services/domains/site-organization-cache';
import { isPlatformSeamRegistered, platform } from './registry';
import { reportSeamFailure } from './request';
import type { CmsSeamContext } from './types';

/**
 * Usage reporting — the CMS side of the usage emitter seam.
 *
 * Call sites describe what was consumed with {@link recordUsage}. Nothing else
 * is their concern: with no emitter registered the call returns at its first
 * line, and with one registered it only appends to a list. Everything that
 * costs something — attributing the event to an organization, handing it to
 * the emitter, flushing — happens when the surrounding *usage scope* ends, and
 * for a request that is after the response, detached from it.
 *
 * A scope is opened by `withUsage()` for every request and by
 * {@link runWithUsageScope} for background jobs. It travels with the async
 * context (AsyncLocalStorage — `nodejs_compat` on Workers), so a service deep
 * in the call stack (the email transport, a model provider) records into the
 * scope of whatever request or job it is serving without being handed one.
 * An event recorded outside every scope is dropped: there is no tenant to
 * attribute it to.
 */

/** What a call site supplies. Id and timestamp are assigned by {@link recordUsage}. */
export interface UsageInput {
  kind: string;
  quantity: number;
  unit: UsageUnit;
  attributes?: UsageAttributes;
  /** Defaults to the scope's site. `null` for organization-plane events. */
  siteId?: string | null;
  /** Skips the site → organization lookup when the caller already knows it. */
  organizationId?: string | null;
}

interface PendingUsage {
  input: UsageInput;
  id: string;
  occurredAt: string;
}

/** Where a scope gets its site and its tenants from. */
export interface UsageScopeSource {
  /** Seam context passed to `flush`. */
  ctx: CmsSeamContext;
  /** The site of the work in progress, read lazily when an event names none. */
  siteId(): string | null;
  /** Site → tenant. Called after the work is done, once per distinct site. */
  tenant(siteId: string | null): Promise<TenantRef>;
}

interface UsageScope extends UsageScopeSource {
  pending: PendingUsage[];
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Whether usage reporting is live. Call sites may use it to skip computing an input. */
export function usageEnabled(): boolean {
  return isPlatformSeamRegistered('usage');
}

/**
 * Record one usage event in the current scope. Synchronous, allocation-free
 * when nothing is registered, never throws.
 */
export function recordUsage(input: UsageInput): void {
  if (!isPlatformSeamRegistered('usage')) return;
  const scope = storage.getStore();
  if (!scope) return;
  if (!Number.isFinite(input.quantity) || input.quantity === 0) return;
  try {
    scope.pending.push({ input, id: uuidv7(), occurredAt: new Date().toISOString() });
  } catch {
    // Recording is best-effort by contract.
  }
}

/**
 * Run `fn` inside a new usage scope. When `fn` settles — resolved or not — the
 * scope's drain (attribute every recorded event, emit it, flush) is started and
 * handed to `onDrain`, which passes it to `waitUntil` or simply lets it run.
 * The drain never rejects, and `fn`'s outcome is returned unchanged.
 *
 * With nothing registered `fn` runs as-is and `onDrain` is not called.
 */
export async function runInUsageScope<T>(
  source: UsageScopeSource,
  fn: () => Promise<T>,
  onDrain: (drain: Promise<void>) => void,
): Promise<T> {
  if (!isPlatformSeamRegistered('usage')) return fn();
  const scope: UsageScope = { ...source, pending: [] };
  try {
    return await storage.run(scope, fn);
  } finally {
    onDrain(drainUsageScope(scope));
  }
}

async function drainUsageScope(scope: UsageScope): Promise<void> {
  const { ctx } = scope;
  const emitter = platform().usage;
  try {
    if (scope.pending.length > 0) {
      const tenants = new Map<string, Promise<TenantRef>>();
      const tenantFor = (siteId: string | null): Promise<TenantRef> => {
        const key = siteId ?? '';
        let ref = tenants.get(key);
        if (!ref) {
          ref = scope.tenant(siteId).catch(() => ({ siteId, organizationId: null }));
          tenants.set(key, ref);
        }
        return ref;
      };
      for (const item of scope.pending) {
        const { input } = item;
        let siteId: string | null;
        try {
          siteId = input.siteId !== undefined ? input.siteId : scope.siteId();
        } catch {
          siteId = null;
        }
        const tenant: TenantRef = input.organizationId
          ? { siteId, organizationId: input.organizationId }
          : await tenantFor(siteId);
        // Unattributable (no site, no organization): nothing to report it against.
        if (!tenant.siteId && !tenant.organizationId) continue;
        const event: UsageEvent = {
          id: item.id,
          kind: input.kind,
          tenant,
          quantity: input.quantity,
          unit: input.unit,
          occurredAt: item.occurredAt,
          ...(input.attributes ? { attributes: input.attributes } : {}),
        };
        try {
          emitter.emit(event);
        } catch (err) {
          reportSeamFailure('usage', 'emit', ctx.requestId, err);
        }
      }
      scope.pending.length = 0;
    }
    await emitter.flush(ctx);
  } catch (err) {
    reportSeamFailure('usage', 'flush', ctx.requestId, err);
  }
}

/**
 * Scope source for background work (queue consumers, cron): the site is fixed
 * and the organization is read through the cached site → organization lookup.
 */
export function backgroundUsageSource(input: {
  runtime: RuntimeContext;
  db: Database;
  siteId: string | null;
}): UsageScopeSource {
  return {
    ctx: { runtime: input.runtime, requestId: null },
    siteId: () => input.siteId,
    tenant: async (siteId) => ({
      siteId,
      organizationId: siteId ? await siteOrganizationId(input.db, input.runtime.cache, siteId) : null,
    }),
  };
}

/**
 * Run background work in a usage scope and drain it before returning. For a
 * job, not a request: the drain is awaited here because nothing is waiting on
 * the job's latency, and a Worker queue invocation may end once it resolves.
 */
export async function runWithUsageScope<T>(source: UsageScopeSource, fn: () => Promise<T>): Promise<T> {
  let drain: Promise<void> | undefined;
  try {
    return await runInUsageScope(source, fn, (p) => { drain = p; });
  } finally {
    if (drain) await drain;
  }
}
