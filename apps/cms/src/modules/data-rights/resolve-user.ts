import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import type { AppEnv } from '../../env';

/**
 * Resolve the current request's `users.id`.
 *
 * Frontend (custom JWT) principals carry `userId` directly; Cloudflare Access /
 * dev admins only carry `externalId`, so fall back to a lookup. API-key
 * principals have neither and resolve to `null` — a key is not a person who can
 * hold consent, request an export, or be erased. Shared by the data-subject
 * rights routes (`/me/consents`, `/me/data-export`, `/me/restriction`).
 */
export async function resolveCurrentUserId(c: Context<AppEnv>): Promise<string | null> {
  const auth = c.get('auth');
  if (auth?.userId) return auth.userId;
  if (auth?.externalId) {
    const [row] = await c
      .get('db')
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, auth.externalId))
      .limit(1);
    return row?.id ?? null;
  }
  return null;
}
