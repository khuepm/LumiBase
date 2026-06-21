import { and, eq } from 'drizzle-orm';
import { settings, type Database } from '@lumibase/database';

/**
 * Per-site envelope-encryption setting + migration progress
 * (regulated-content-readiness task 3.6; Req 4.5).
 *
 * The mode is an **operator-controlled setting** (changed from the admin UI
 * with step-up auth), not a raw env var, so it cannot be flipped accidentally
 * and every change is auditable. Toggling kicks a background migration that
 * converts existing records to the target mode; reads stay correct throughout
 * because they are self-describing (driven by `items.dek_wrapped`).
 */

export const ENVELOPE_SETTINGS_KEY = 'encryption.envelope';

export type MigrationDirection = 'to_envelope' | 'to_shared';
export type MigrationStatus = 'idle' | 'running' | 'completed';

export interface EnvelopeMigrationState {
  direction: MigrationDirection | null;
  status: MigrationStatus;
  /** Resume cursor (last processed item id) or null at start/finish. */
  cursor: string | null;
  processed: number;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface EnvelopeSetting {
  enabled: boolean;
  migration: EnvelopeMigrationState;
}

const IDLE_MIGRATION: EnvelopeMigrationState = {
  direction: null,
  status: 'idle',
  cursor: null,
  processed: 0,
  startedAt: null,
  updatedAt: null,
};

export const DEFAULT_ENVELOPE_SETTING: EnvelopeSetting = {
  enabled: false,
  migration: IDLE_MIGRATION,
};

/** Coerce a raw settings value into a well-formed {@link EnvelopeSetting}. */
export function parseEnvelopeSetting(value: unknown): EnvelopeSetting {
  const v = (value ?? {}) as Record<string, unknown>;
  const m = (v.migration ?? {}) as Record<string, unknown>;
  const direction =
    m.direction === 'to_envelope' || m.direction === 'to_shared' ? m.direction : null;
  const status =
    m.status === 'running' || m.status === 'completed' ? m.status : 'idle';
  return {
    enabled: v.enabled === true,
    migration: {
      direction,
      status,
      cursor: typeof m.cursor === 'string' ? m.cursor : null,
      processed: typeof m.processed === 'number' ? m.processed : 0,
      startedAt: typeof m.startedAt === 'string' ? m.startedAt : null,
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : null,
    },
  };
}

/** Read the per-site envelope setting (defaults to disabled/idle). */
export async function readEnvelopeSetting(
  db: Database,
  siteId: string,
): Promise<EnvelopeSetting> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, ENVELOPE_SETTINGS_KEY)))
    .limit(1);
  if (!row) return DEFAULT_ENVELOPE_SETTING;
  return parseEnvelopeSetting(row.value);
}

/** Upsert the per-site envelope setting. */
export async function writeEnvelopeSetting(
  db: Database,
  siteId: string,
  value: EnvelopeSetting,
): Promise<void> {
  const insert = db
    .insert(settings)
    .values({ siteId, key: ENVELOPE_SETTINGS_KEY, value, scope: 'site' });
  if (typeof insert.onConflictDoUpdate === 'function') {
    await insert.onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value, updatedAt: new Date() },
    });
  } else {
    await insert;
  }
}
