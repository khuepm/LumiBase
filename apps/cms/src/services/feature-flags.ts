import { settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Content OS rollout flags (content-os design "Migration & Rollout").
 *
 * Stored per site in the `settings` table under one key so Studio can
 * toggle the whole group atomically. Every flag defaults to OFF — with all
 * flags off the system behaves exactly like the pre-Content-OS Copilot +
 * harness (L1/L2) baseline.
 */
export const CONTENT_OS_SETTINGS_KEY = 'contentOs';

export interface ContentOsFlags {
  /** Drift scans create reconciler goals (Module B). */
  reconciler: boolean;
  /** Dangerous actions at L3 stage with a veto window (Module D). */
  vetoWindow: boolean;
  /** Agents may decide approvals below the site threshold (Module C). */
  agentReview: boolean;
  /** The `/api/v1/mcp` endpoint accepts requests (Module A). */
  mcp: boolean;
}

const DEFAULTS: ContentOsFlags = {
  reconciler: false,
  vetoWindow: false,
  agentReview: false,
  mcp: false,
};

/** Reads the per-site Content OS flags; absent or malformed values are OFF. */
export async function getContentOsFlags(db: Database, siteId: string): Promise<ContentOsFlags> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, CONTENT_OS_SETTINGS_KEY)))
    .limit(1);
  const value =
    row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : {};
  return {
    reconciler: value.reconciler === true,
    vetoWindow: value.vetoWindow === true,
    agentReview: value.agentReview === true,
    mcp: value.mcp === true,
  };
}

export { DEFAULTS as CONTENT_OS_FLAG_DEFAULTS };
