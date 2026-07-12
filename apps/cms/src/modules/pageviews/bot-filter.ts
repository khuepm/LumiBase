/**
 * Pure, testable bot / opt-out filtering for pageview ingestion. Applied before
 * a hit is recorded. Intentionally conservative — it favours dropping obvious
 * automated traffic and honouring privacy signals over perfect accuracy.
 */

/** Common bot/crawler/preview-agent markers (case-insensitive substring). */
const BOT_UA_PATTERN =
  /bot|crawl|spider|slurp|headless|preview|monitor|scan|curl|wget|python-requests|axios|node-fetch|http-client|lighthouse|pingdom|uptimerobot/i;

export interface BotFilterInput {
  userAgent?: string | null;
  /** `DNT` request header value. */
  dnt?: string | null;
  /** `Sec-GPC` (Global Privacy Control) request header value. */
  gpc?: string | null;
}

export interface BotFilterResult {
  record: boolean;
  reason?: 'bot-ua' | 'empty-ua' | 'dnt' | 'gpc';
}

/**
 * Decide whether a hit should be recorded.
 *
 * - Missing/empty UA → drop (`empty-ua`): almost always automation.
 * - UA matches a bot marker → drop (`bot-ua`).
 * - `DNT: 1` or `Sec-GPC: 1` → drop (`dnt`/`gpc`): respect the opt-out.
 */
export function shouldRecord(input: BotFilterInput): BotFilterResult {
  if (input.dnt === '1') return { record: false, reason: 'dnt' };
  if (input.gpc === '1') return { record: false, reason: 'gpc' };

  const ua = (input.userAgent ?? '').trim();
  if (ua.length === 0) return { record: false, reason: 'empty-ua' };
  if (BOT_UA_PATTERN.test(ua)) return { record: false, reason: 'bot-ua' };

  return { record: true };
}
