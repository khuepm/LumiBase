/**
 * Password policy admin surface (#733, epic #674 S04). Mounted at
 * `/api/v1/admin/password-policy` under `withAuth` (control plane + Studio
 * access wall apply via the `/api/v1/admin` prefix).
 *
 *   GET /   → `{ data: PasswordPolicy }`          — site admin (read-only view)
 *   PUT /   body `PasswordPolicyInput` → `{ data }` — bootstrap admin only
 *
 * The policy is instance-wide (passwords live on global `users` rows), so —
 * like the instance e-mail identity mode — only the bootstrap admin may change
 * it. Every applied change is audit-logged with the previous and new values
 * (the policy holds no secret). The unauthenticated, rule-set-only view lives
 * at `GET /api/v1/auth/password-policy`.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@lumibase/database';
import { PasswordPolicySchema } from '@lumibase/contracts/schemas';

import type { AppEnv } from '../env';
import { systemDbFor } from '../middleware/db';
import { requireSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { loadPasswordPolicy, savePasswordPolicy } from '../services/auth/password-policy';

export const adminPasswordPolicyRouter = new Hono<AppEnv>();

adminPasswordPolicyRouter.get('/', requireSiteAdmin(), async (c) => {
  return c.json({ data: await loadPasswordPolicy(systemDbFor(c)) });
});

adminPasswordPolicyRouter.put('/', async (c) => {
  const auth = c.get('auth');
  const systemDb = systemDbFor(c);
  // Instance-wide: only the bootstrap admin (a person, not an API key).
  const [actor] = auth?.userId && !auth.apiKeyId
    ? await systemDb.select({ bootstrap: users.isBootstrap }).from(users).where(eq(users.id, auth.userId)).limit(1)
    : [];
  if (!actor?.bootstrap) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Only the bootstrap admin can change the password policy.' }] },
      403,
    );
  }

  const parsed = PasswordPolicySchema.safeParse(await c.req.json().catch(() => ({ __invalid: true })));
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) },
      400,
    );
  }

  const previous = await loadPasswordPolicy(systemDb);
  await savePasswordPolicy(systemDb, parsed.data);
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'password_policy_changed',
    actorEmail: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { previous, current: parsed.data },
  });
  return c.json({ data: parsed.data });
});
