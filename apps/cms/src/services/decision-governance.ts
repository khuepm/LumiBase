/**
 * Governance for the decision model (#511, J04): who may ask, whether the site
 * agreed to send content to the provider, how much it may spend, and what is
 * recorded about each call. HTTP is the only entry point today; internal
 * callers (content review, Flows) go through the same `authorizeDecision` +
 * `DecisionGovernanceService.decide` pair rather than calling a provider.
 *
 * Every gate runs before the provider is called, in this order:
 *   capability `ai:decide` → provider configured → site opt-in (kill switch)
 *   → state field allowlist → input budget → quota reservation.
 *
 * Quota is accounted with the runtime's atomic counter (`CacheProvider.increment`:
 * Redis INCRBY on Docker, the per-site Durable Object on Cloudflare). Each
 * limit is checked on the post-increment value and rolled back when it is
 * exceeded, so concurrent requests cannot overshoot through a read-then-write
 * race. A counter backend that is down fails closed.
 */

import { settings, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  assertDecisionInputBudget,
  DecisionProviderError,
  readBound,
  type ConfiguredDecisionProvider,
  type DecisionErrorCode,
  type DecisionPayload,
  type DecisionRequest,
  type DecisionResponse,
} from './decision-provider';
import { DECISION_CAPABILITY, satisfiesCapability } from './effective-capability-service';

export { DECISION_CAPABILITY, DECISION_PERMISSION_COLLECTION } from './effective-capability-service';

/** `lumibase_settings` key holding the per-site opt-in and limits. */
export const DECISION_SETTINGS_KEY = 'aiDecisions';

// ---------------------------------------------------------------------------
// Site settings: opt-in, kill switch, field allowlist, tighter limits
// ---------------------------------------------------------------------------

const siteSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  allowedStateFields: z.array(z.string().min(1).max(128)).max(256).optional(),
  requestsPerHour: z.number().int().min(0).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  // Not `tokensPerDay`: the settings read API redacts any key containing "token".
  budgetPerDay: z.number().int().min(0).optional(),
});

export interface DecisionSiteSettings {
  /** Opt-in to sending content to the provider. Off by default; off again is the site kill switch. */
  enabled: boolean;
  /** When set, `state` must be an object whose top-level keys are all listed. */
  allowedStateFields: string[] | null;
  requestsPerHour?: number;
  maxConcurrent?: number;
  budgetPerDay?: number;
}

const DISABLED: DecisionSiteSettings = { enabled: false, allowedStateFields: null };

/** Parses the stored value; anything malformed reads as disabled, never as open. */
export function parseDecisionSettings(value: unknown): DecisionSiteSettings {
  const parsed = siteSettingsSchema.safeParse(value);
  if (!parsed.success) return DISABLED;
  const { allowedStateFields, ...rest } = parsed.data;
  return { ...rest, allowedStateFields: allowedStateFields ?? null };
}

export async function readDecisionSettings(db: Database, siteId: string): Promise<DecisionSiteSettings> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, DECISION_SETTINGS_KEY)))
    .limit(1);
  return row ? parseDecisionSettings(row.value) : DISABLED;
}

/** `null` when allowed; otherwise the offending top-level keys (or `[]` for a non-object state). */
export function disallowedStateFields(state: DecisionPayload, allowed: readonly string[] | null): string[] | null {
  if (allowed === null) return null;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return [];
  const extra = Object.keys(state).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? extra : null;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export interface DecisionQuota {
  /** Admitted decisions per site per clock hour. */
  requestsPerHour: number;
  /** Decisions in flight per site. */
  maxConcurrent: number;
  /** Estimated tokens (input + output, every attempt) per site per UTC day. */
  budgetPerDay: number;
}

export const DEFAULT_DECISION_QUOTA: DecisionQuota = {
  requestsPerHour: 600,
  maxConcurrent: 4,
  budgetPerDay: 2_000_000,
};

export interface DecisionQuotaEnv {
  DECISION_SITE_REQUESTS_PER_HOUR?: string;
  DECISION_SITE_MAX_CONCURRENT?: string;
  DECISION_SITE_TOKENS_PER_DAY?: string;
}

/** Platform ceilings from the environment; invalid values fall back to the defaults. */
export function decisionQuotaFromEnv(env: DecisionQuotaEnv): DecisionQuota {
  const d = DEFAULT_DECISION_QUOTA;
  return {
    requestsPerHour: readBound(
      env.DECISION_SITE_REQUESTS_PER_HOUR, d.requestsPerHour, 0, 1_000_000, 'DECISION_SITE_REQUESTS_PER_HOUR',
    ),
    maxConcurrent: readBound(env.DECISION_SITE_MAX_CONCURRENT, d.maxConcurrent, 1, 1_000, 'DECISION_SITE_MAX_CONCURRENT'),
    budgetPerDay: readBound(
      env.DECISION_SITE_TOKENS_PER_DAY, d.budgetPerDay, 0, 1_000_000_000, 'DECISION_SITE_TOKENS_PER_DAY',
    ),
  };
}

/** A site may tighten the platform ceiling, never raise it. */
export function effectiveDecisionQuota(platform: DecisionQuota, site: DecisionSiteSettings): DecisionQuota {
  return {
    requestsPerHour: Math.min(platform.requestsPerHour, site.requestsPerHour ?? Infinity),
    maxConcurrent: Math.min(platform.maxConcurrent, site.maxConcurrent ?? Infinity),
    budgetPerDay: Math.min(platform.budgetPerDay, site.budgetPerDay ?? Infinity),
  };
}

/**
 * Output tokens are unknown until the provider answers, so they are reserved
 * from the shape of the questions: a fixed envelope plus a probability per
 * option. An estimate, not a tokenizer count.
 */
export function estimateDecisionOutputTokens(request: DecisionRequest): number {
  let total = 32;
  for (const question of Object.values(request.questions)) {
    const options =
      question.type === 'noul'
        ? 2
        : question.type === 'choice'
          ? Object.keys(question.criteria).length
          : question.criteria.length;
    total += 16 + 12 * options;
  }
  return total;
}

export type DecisionGovernanceCode =
  | 'FORBIDDEN'
  | 'DECISION_NOT_CONFIGURED'
  | 'DECISION_DISABLED'
  | 'DECISION_FIELD_NOT_ALLOWED'
  | 'DECISION_QUOTA_EXCEEDED'
  | 'DECISION_CONCURRENCY_LIMITED'
  | 'DECISION_QUOTA_UNAVAILABLE';

export class DecisionGovernanceError extends Error {
  readonly code: DecisionGovernanceCode;
  /** Seconds until the exhausted window resets, for `Retry-After`. */
  readonly retryAfterSeconds?: number;

  constructor(code: DecisionGovernanceCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'DecisionGovernanceError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface Reservation {
  reservedTokens: number;
  /** Upstream was never called: return the request, the slot and the tokens. */
  release(): Promise<void>;
  /** Upstream was called: keep the request, free the slot, true the tokens up to `charged`. */
  settle(chargedTokens: number): Promise<void>;
}

/**
 * Per-site counters. Keys are `dq:{siteId}:…` — the Cloudflare counter routes
 * on the second segment, so each site's counters live in its own Durable Object.
 *
 * Windows are part of the key, so a window resets even on a backend that
 * ignores TTLs (the Durable Object). The concurrency key rotates every
 * `slotWindowMs` for the same reason: a slot leaked by a crashed isolate
 * frees itself at the next rotation instead of blocking the site forever.
 * The trade-off: right after a rotation, requests still running in the old
 * window are not counted, so in-flight work can briefly reach twice the limit.
 */
export class DecisionQuotaLedger {
  constructor(
    private readonly cache: CacheProvider,
    private readonly siteId: string,
    private readonly quota: DecisionQuota,
    private readonly slotWindowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(tokens: number): Promise<Reservation> {
    const at = this.now();
    const hour = Math.floor(at / HOUR_MS);
    const day = Math.floor(at / DAY_MS);
    const slot = Math.floor(at / this.slotWindowMs);
    const keys = {
      requests: `dq:${this.siteId}:req:${hour}`,
      running: `dq:${this.siteId}:run:${slot}`,
      tokens: `dq:${this.siteId}:tok:${day}`,
    };
    // Each key outlives its window by more than the longest deadline (120 s),
    // so a late settlement never recreates an expired key without a TTL.
    const ttl: Record<string, number> = {
      [keys.requests]: HOUR_MS / 1000 + 600,
      [keys.running]: Math.ceil((this.slotWindowMs * 2) / 1000),
      [keys.tokens]: DAY_MS / 1000 + 600,
    };
    const taken: Array<[string, number]> = [];
    const undo = async () => {
      // Best effort: a failed rollback over-counts (denies sooner), never under-counts.
      await Promise.allSettled(taken.map(([key, by]) => this.cache.increment(key, -by, { ttl: ttl[key] })));
    };
    const take = async (key: string, by: number) => {
      let value: number;
      try {
        value = await this.cache.increment(key, by, { ttl: ttl[key] });
      } catch {
        await undo();
        throw new DecisionGovernanceError('DECISION_QUOTA_UNAVAILABLE', 'Decision quota accounting is unavailable.');
      }
      taken.push([key, by]);
      return value;
    };

    if ((await take(keys.requests, 1)) > this.quota.requestsPerHour) {
      await undo();
      throw new DecisionGovernanceError(
        'DECISION_QUOTA_EXCEEDED',
        `This site reached its limit of ${this.quota.requestsPerHour} decisions per hour.`,
        secondsUntil(at, (hour + 1) * HOUR_MS),
      );
    }
    if ((await take(keys.running, 1)) > this.quota.maxConcurrent) {
      await undo();
      throw new DecisionGovernanceError(
        'DECISION_CONCURRENCY_LIMITED',
        `This site already has ${this.quota.maxConcurrent} decisions in flight.`,
        1,
      );
    }
    if ((await take(keys.tokens, tokens)) > this.quota.budgetPerDay) {
      await undo();
      throw new DecisionGovernanceError(
        'DECISION_QUOTA_EXCEEDED',
        `This site's daily decision budget of ${this.quota.budgetPerDay} estimated tokens is used up.`,
        secondsUntil(at, (day + 1) * DAY_MS),
      );
    }

    const adjust = async (changes: Array<[string, number]>) => {
      const results = await Promise.allSettled(
        changes.filter(([, by]) => by !== 0).map(([key, by]) => this.cache.increment(key, by, { ttl: ttl[key] })),
      );
      if (results.some((result) => result.status === 'rejected')) {
        console.warn('[decision] quota settlement failed; counters may over-count until the window resets');
      }
    };

    return {
      reservedTokens: tokens,
      release: () => adjust([[keys.requests, -1], [keys.running, -1], [keys.tokens, -tokens]]),
      settle: (charged) => adjust([[keys.running, -1], [keys.tokens, charged - tokens]]),
    };
  }
}

function secondsUntil(now: number, at: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export interface DecisionGrant {
  allowed: boolean;
  capabilities: readonly string[];
}

/** Throws FORBIDDEN unless the resolved grant carries `ai:decide` (admin satisfies it). */
export function authorizeDecision(grant: DecisionGrant): void {
  if (!grant.allowed || !satisfiesCapability(grant.capabilities, DECISION_CAPABILITY)) {
    throw new DecisionGovernanceError('FORBIDDEN', `The ${DECISION_CAPABILITY} capability is required.`);
  }
}

// ---------------------------------------------------------------------------
// Governed call
// ---------------------------------------------------------------------------

/** What the audit event records. No state, instructions, criteria or answers. */
export interface DecisionAccounting {
  /** Upstream requests sent, retries included. */
  attempts: number;
  inputBytes: number | null;
  estimatedInputTokens: number | null;
  reservedTokens: number;
  /** Tokens charged to the site budget; unknown usage is charged at the estimate. */
  chargedTokens: number;
}

export interface DecisionGovernanceDeps {
  configured: ConfiguredDecisionProvider | null;
  settings: DecisionSiteSettings;
  /** Platform ceilings (see decisionQuotaFromEnv). */
  quota: DecisionQuota;
  cache: CacheProvider;
  siteId: string;
  now?: () => number;
}

export type GovernedDecisionResult =
  | { ok: true; data: DecisionResponse; accounting: DecisionAccounting }
  | { ok: false; error: DecisionGovernanceError | DecisionProviderError | Error; accounting: DecisionAccounting };

export class DecisionGovernanceService {
  constructor(private readonly deps: DecisionGovernanceDeps) {}

  /**
   * Runs the site gates, reserves quota, calls the provider and settles.
   * Never throws: the caller maps the error and writes the audit event from
   * `accounting`. Call `authorizeDecision` first.
   */
  async decide(request: DecisionRequest, options: { signal?: AbortSignal } = {}): Promise<GovernedDecisionResult> {
    const accounting: DecisionAccounting = {
      attempts: 0,
      inputBytes: null,
      estimatedInputTokens: null,
      reservedTokens: 0,
      chargedTokens: 0,
    };
    const fail = (error: Error): GovernedDecisionResult => ({ ok: false, error, accounting });

    const { configured, settings: site } = this.deps;
    if (!configured) {
      return fail(new DecisionGovernanceError(
        'DECISION_NOT_CONFIGURED',
        'Set DECISION_PROVIDER (typesafe | openrouter | llm) and its credentials.',
      ));
    }
    if (!site.enabled) {
      return fail(new DecisionGovernanceError(
        'DECISION_DISABLED',
        `Decisions are not enabled for this site. A site admin opts in with the "${DECISION_SETTINGS_KEY}" setting.`,
      ));
    }
    const extra = disallowedStateFields(request.state, site.allowedStateFields);
    if (extra) {
      return fail(new DecisionGovernanceError(
        'DECISION_FIELD_NOT_ALLOWED',
        extra.length === 0
          ? 'This site only sends allowlisted fields, so state must be an object.'
          : `State fields not allowed for this site: ${extra.join(', ')}.`,
      ));
    }

    let inputTokens: number;
    try {
      const size = assertDecisionInputBudget(request, configured.limits);
      accounting.inputBytes = size.bytes;
      accounting.estimatedInputTokens = size.estimatedTokens;
      inputTokens = size.estimatedTokens;
    } catch (error) {
      return fail(error as Error);
    }

    const outputTokens = estimateDecisionOutputTokens(request);
    const perAttempt = inputTokens + outputTokens;
    // Worst case: every retry is sent and billed.
    const reserve = perAttempt * (configured.limits.maxRetries + 1);
    const now = this.deps.now ?? Date.now;
    const ledger = new DecisionQuotaLedger(
      this.deps.cache,
      this.deps.siteId,
      effectiveDecisionQuota(this.deps.quota, site),
      Math.max(60_000, configured.limits.deadlineMs * 2),
      now,
    );

    let reservation: Reservation;
    try {
      reservation = await ledger.reserve(reserve);
    } catch (error) {
      return fail(error as Error);
    }
    accounting.reservedTokens = reserve;

    try {
      const data = await configured.provider.decide(request, {
        signal: options.signal,
        onAttempt: () => {
          accounting.attempts += 1;
        },
      });
      // Earlier failed attempts are charged at the estimate; unknown counts too.
      accounting.chargedTokens =
        Math.max(accounting.attempts - 1, 0) * perAttempt +
        (data.usage.inputTokens ?? inputTokens) +
        (data.usage.outputTokens ?? outputTokens);
      await reservation.settle(accounting.chargedTokens);
      return { ok: true, data, accounting };
    } catch (error) {
      if (accounting.attempts === 0) {
        await reservation.release();
      } else {
        // A timed-out or failed attempt may still be billed upstream.
        accounting.chargedTokens = accounting.attempts * perAttempt;
        await reservation.settle(accounting.chargedTokens);
      }
      return fail(error as Error);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP mapping and audit
// ---------------------------------------------------------------------------

export type DecisionOutcomeCode = DecisionGovernanceCode | DecisionErrorCode | 'INTERNAL';

/** Audit-safe fingerprint of the rubric: same questions → same version. Content is not recoverable from it. */
export async function decisionRubricVersion(request: DecisionRequest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(request.questions));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function decisionQuestionTypes(request: DecisionRequest): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of Object.values(request.questions)) {
    counts[question.type] = (counts[question.type] ?? 0) + 1;
  }
  return counts;
}
