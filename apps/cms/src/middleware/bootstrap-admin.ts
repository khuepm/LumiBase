import { users } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { systemDbFor } from './db';

/**
 * The bootstrap admin, as a person: the instance-level administrator. API
 * keys and anonymous callers never qualify, whatever their capabilities —
 * instance actions (release manifests, upgrades) must be taken by someone who
 * signed in.
 */
export async function isBootstrapAdmin(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.get('auth');
  if (!auth?.userId || auth.apiKeyId || auth.type === 'api_key' || auth.type === 'anonymous') return false;
  const [actor] = await systemDbFor(c)
    .select({ bootstrap: users.isBootstrap })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  return actor?.bootstrap === true;
}
