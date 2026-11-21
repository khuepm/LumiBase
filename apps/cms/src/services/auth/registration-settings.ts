/**
 * Self-registration switch (#994).
 *
 * `POST /api/v1/auth/register` is the one public write that creates an
 * account. It already starts the account `invited`, forces the `subscriber`
 * role and a `frontend` token, and is rate-limited — but a site with no public
 * audience gains nothing from it and keeps an extra surface for credential
 * abuse. The site setting `auth.registration` closes it:
 *
 *   { "enabled": false }
 *
 * Absent or malformed means enabled, so existing sites keep their behaviour.
 * A read failure also means enabled (fail open), because a database hiccup
 * must not silently close sign-ups for sites that rely on them; the other
 * registration guards still apply.
 */
import { and, eq } from 'drizzle-orm';
import { scopeSite, settings, type Database } from '@lumibase/database';

export const REGISTRATION_SETTING_KEY = 'auth.registration';

export function parseRegistrationSetting(value: unknown): { enabled: boolean } {
  if (!value || typeof value !== 'object') return { enabled: true };
  return { enabled: (value as Record<string, unknown>).enabled !== false };
}

export async function isSelfRegistrationEnabled(db: Database, siteId: string | undefined): Promise<boolean> {
  if (!siteId) return true;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(scopeSite(settings.siteId, siteId), eq(settings.key, REGISTRATION_SETTING_KEY)))
      .limit(1);
    return parseRegistrationSetting(row?.value).enabled;
  } catch {
    return true;
  }
}
