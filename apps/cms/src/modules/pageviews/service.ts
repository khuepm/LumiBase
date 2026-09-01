import { and, eq } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { settings, userConsents } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import {
  parsePageviewSettings,
  PAGEVIEWS_SETTINGS_KEY,
  type PageviewSettings,
} from '@lumibase/contracts/schemas';
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from './strategy';
import { DbRollupStrategy } from './strategies/db-rollup';
import { HotCounterStrategy } from './strategies/hot-counter';
import { CdcEventStrategy } from './strategies/cdc-event';
import { HllStrategy } from './strategies/hll';

/** Raw request signals the service needs to build a HitContext + gate consent. */
export interface RecordHitInput {
  path: string;
  /** Authenticated user id, when the request carried a session. */
  userId?: string;
  /** Client IP (already extracted upstream). Hashed, never stored raw. */
  ip?: string;
  userAgent?: string;
  referrer?: string;
  countryCode?: string;
}

export interface PageviewServiceDeps {
  db: Database;
  runtime: RuntimeContext;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const SETTINGS_CACHE_TTL_MS = 30_000;

/**
 * Orchestrates pageview recording: resolves per-site settings (briefly cached),
 * builds a privacy-preserving HitContext (salted visitor hash, never a raw IP),
 * gates authenticated hits on the `analytics` consent category, and delegates
 * to the configured strategy. Reads delegate straight to the strategy's rollup.
 */
export class PageviewService {
  private readonly db: Database;
  private readonly runtime: RuntimeContext;
  private readonly now: () => Date;
  private settingsCache = new Map<string, { at: number; value: PageviewSettings }>();

  constructor(deps: PageviewServiceDeps) {
    this.db = deps.db;
    this.runtime = deps.runtime;
    this.now = deps.now ?? (() => new Date());
  }

  /** Record one hit if enabled + permitted. Returns whether it was recorded. */
  async recordHit(siteId: string, input: RecordHitInput): Promise<boolean> {
    const cfg = await this.getSettings(siteId);
    if (!cfg.enabled) return false;

    const occurredAt = this.now();

    // Consent gate: an authenticated, identifiable hit needs analytics consent
    // when respectConsent is on. Withdrawn → fall through as anonymous.
    let userId = input.userId;
    if (userId && cfg.respectConsent) {
      const granted = await this.hasAnalyticsConsent(siteId, userId);
      if (!granted) userId = undefined;
    }

    const visitorHash = await this.visitorHash(siteId, cfg, input, occurredAt);

    const ctx: HitContext = {
      path: input.path,
      userId,
      visitorHash,
      referrer: input.referrer,
      userAgent: input.userAgent,
      countryCode: input.countryCode,
      occurredAt,
    };

    await this.strategyFor(cfg).recordHit(siteId, ctx);
    return true;
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    const cfg = await this.getSettings(siteId);
    return this.strategyFor(cfg).getStats(siteId, range);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private strategyFor(cfg: PageviewSettings): PageviewStrategy {
    const deps: StrategyDeps = { db: this.db, runtime: this.runtime };
    switch (cfg.strategy) {
      case 'hot-counter':
        return new HotCounterStrategy(deps);
      case 'cdc':
        return new CdcEventStrategy(deps);
      case 'hll':
        return new HllStrategy(deps);
      case 'db-rollup':
      default:
        return new DbRollupStrategy(deps);
    }
  }

  private async getSettings(siteId: string): Promise<PageviewSettings> {
    const cached = this.settingsCache.get(siteId);
    if (cached && this.now().getTime() - cached.at < SETTINGS_CACHE_TTL_MS) {
      return cached.value;
    }
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, PAGEVIEWS_SETTINGS_KEY), eq(settings.siteId, siteId)))
      .limit(1);
    const value = parsePageviewSettings(row?.value);
    this.settingsCache.set(siteId, { at: this.now().getTime(), value });
    return value;
  }

  private async hasAnalyticsConsent(siteId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ granted: userConsents.granted })
      .from(userConsents)
      .where(
        and(
          eq(userConsents.siteId, siteId),
          eq(userConsents.userId, userId),
          eq(userConsents.consentType, 'analytics'),
        ),
      )
      .limit(1);
    return row?.granted === true;
  }

  /**
   * SHA-256 of siteId + IP + UA + a per-site salt + the UTC day, hex-encoded.
   * Including the day rotates the identifier daily (privacy) and matches the
   * daily-unique dedup semantics. Uses WebCrypto so it runs on both runtimes.
   */
  private async visitorHash(
    siteId: string,
    cfg: PageviewSettings,
    input: RecordHitInput,
    occurredAt: Date,
  ): Promise<string> {
    const day = occurredAt.toISOString().slice(0, 10);
    const salt = cfg.hashSalt ?? 'lumibase-pageviews';
    const material = `${siteId}|${input.ip ?? ''}|${input.userAgent ?? ''}|${salt}|${day}`;
    const bytes = new TextEncoder().encode(material);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
