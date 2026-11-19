import { settings } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { resolveStoredSiteFlags } from '../modules/release-flags/gate';
import type { ReleaseFlagKey } from '../modules/release-flags/registry';

/**
 * Content OS rollout flags (content-os design "Migration & Rollout").
 *
 * Stored per site in the `settings` table under one key so Studio can
 * toggle the whole group atomically. Every flag defaults to OFF — with all
 * flags off the system behaves exactly like the pre-Content-OS Copilot +
 * harness (L1/L2) baseline.
 *
 * Each flag is also a release flag (#896): the site's stored value is its
 * choice, and the release gate (`LUMIBASE_RELEASE_FLAGS` → signed manifest →
 * stage `ga`) can withdraw the feature on a whole deployment. With no
 * override and no manifest the gate is open, so the stored value decides
 * exactly as before.
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

/** Registry key of each Content OS switch. */
export const CONTENT_OS_RELEASE_FLAGS = {
  reconciler: 'content-os.reconciler',
  vetoWindow: 'content-os.veto-window',
  agentReview: 'content-os.agent-review',
  mcp: 'content-os.mcp',
} as const satisfies Record<keyof ContentOsFlags, ReleaseFlagKey>;

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
  const stored: ContentOsFlags = {
    reconciler: value.reconciler === true,
    vetoWindow: value.vetoWindow === true,
    agentReview: value.agentReview === true,
    mcp: value.mcp === true,
  };
  const fields = Object.keys(CONTENT_OS_RELEASE_FLAGS) as (keyof ContentOsFlags)[];
  // Every site default is OFF, so a site with nothing switched on needs no
  // gate check: the gate can only narrow, never widen.
  if (!fields.some((field) => stored[field])) return stored;

  const siteValues: Partial<Record<ReleaseFlagKey, boolean | null>> = {};
  for (const field of fields) {
    siteValues[CONTENT_OS_RELEASE_FLAGS[field]] = typeof value[field] === 'boolean' ? (value[field] as boolean) : null;
  }
  const states = await resolveStoredSiteFlags(db, siteValues);
  const out = { ...DEFAULTS };
  for (const field of fields) {
    out[field] = stored[field] && states.get(CONTENT_OS_RELEASE_FLAGS[field])?.enabled === true;
  }
  return out;
}

export { DEFAULTS as CONTENT_OS_FLAG_DEFAULTS };
