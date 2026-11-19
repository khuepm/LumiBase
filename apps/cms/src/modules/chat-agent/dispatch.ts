import { Hono, type Context } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiRouter } from '../../routes/ai';

/**
 * Runs a Copilot request AS the linked LumiBase user (#711).
 *
 * The chat surface does not re-implement the Copilot: it dispatches to the
 * same `/ai` router Studio calls, with the linked user as the principal. So a
 * chat message gets exactly that user's capabilities, row/field permissions,
 * autonomy level, approvals and audit trail — and an approval clicked in chat
 * goes through the same `requireAdmin` + capability check as in Studio.
 *
 * The principal is a plain user reference; capabilities are resolved from the
 * user's current site membership on every request (#472), so removing a user
 * from the site, or changing their role, takes effect on the next message.
 */

export interface DispatchTarget {
  db: Database;
  siteId: string;
  userId: string;
  /** e.g. `slack`, `webhook` — recorded on the principal for audit. */
  channel: string;
}

export interface DispatchResult {
  status: number;
  body: {
    data?: Record<string, unknown>;
    errors?: Array<{ code?: string; message?: string }>;
  };
}

export function chatPrincipal(target: Pick<DispatchTarget, 'userId' | 'channel'>): AuthPrincipal {
  return { type: 'user', userId: target.userId, roles: [], raw: { via: `chat-agent:${target.channel}` } };
}

/** `method path` against the `/ai` router, as the linked user. */
export async function dispatchAsUser(
  c: Context<AppEnv>,
  target: DispatchTarget,
  path: string,
  body: Record<string, unknown>,
): Promise<DispatchResult> {
  const app = new Hono<AppEnv>();
  app.use('*', async (inner, next) => {
    inner.set('db', target.db);
    inner.set('siteId', target.siteId);
    inner.set('auth', chatPrincipal(target));
    inner.set('runtime', c.get('runtime'));
    const requestId = c.get('requestId');
    if (requestId) inner.set('requestId', requestId);
    await next();
  });
  app.route('/ai', aiRouter);
  let executionCtx: Context<AppEnv>['executionCtx'] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const res = await app.request(
    `/ai${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    c.env,
    executionCtx,
  );
  const parsed = (await res.json().catch(() => ({}))) as DispatchResult['body'];
  return { status: res.status, body: parsed };
}
