import { z } from 'zod';

/**
 * Per-site pageview-counter configuration.
 *
 * Stored in `lumibase_settings` under the dotted `pageviews.*` keys with
 * `scope: 'module'`. The module reads the parsed value per site (cached briefly)
 * to pick a counting strategy and attribution behaviour at hit time.
 *
 * `strategy` selects one of four counting approaches:
 *   - `db-rollup`   raw events → daily rollup (default; works on every runtime).
 *   - `hot-counter` atomic cache/DO counters flushed to the rollup.
 *   - `cdc`         emit a change event for external aggregation (also rolls up
 *                   locally so the Studio panel has a read model).
 *   - `hll`         approximate unique visitors (Redis HLL / DO set; DB fallback).
 */
export const PAGEVIEW_STRATEGIES = ['db-rollup', 'hot-counter', 'cdc', 'hll'] as const;
export type PageviewStrategyName = (typeof PAGEVIEW_STRATEGIES)[number];

export const PageviewSettingsSchema = z.object({
  /** Master switch — when false the `/hit` endpoint records nothing. */
  enabled: z.boolean().default(true),
  strategy: z.enum(PAGEVIEW_STRATEGIES).default('db-rollup'),
  /** Table used to attribute authenticated hits. Default the platform users. */
  userTable: z.string().default('lumibase_users'),
  /** Per-site salt for the visitor hash; generated on first write if absent. */
  hashSalt: z.string().optional(),
  /** Gate user-attributed hits on the `analytics` consent category. */
  respectConsent: z.boolean().default(true),
  /** Hot-counter/DO flush interval hint (seconds). The cron fires every 5 min. */
  flushIntervalS: z.number().int().positive().default(300),
  /** Drop obvious bots / DNT / GPC before recording. */
  botFilter: z.boolean().default(true),
});

export type PageviewSettings = z.infer<typeof PageviewSettingsSchema>;

/** Settings key namespace + defaults helper. */
export const PAGEVIEWS_SETTINGS_KEY = 'pageviews' as const;

/** Parse a raw settings value into fully-defaulted PageviewSettings. */
export function parsePageviewSettings(value: unknown): PageviewSettings {
  const result = PageviewSettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : PageviewSettingsSchema.parse({});
}
