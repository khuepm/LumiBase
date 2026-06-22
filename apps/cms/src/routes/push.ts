/**
 * Web Push subscription management (push-noti feature).
 *
 *   GET    /api/v1/push/vapid-public-key  — the application server public key
 *                                           the browser needs to subscribe.
 *   POST   /api/v1/push/subscriptions     — upsert the caller's PushSubscription.
 *   DELETE /api/v1/push/subscriptions     — remove a subscription by endpoint.
 *
 * Mounted under the authenticated + tenant-scoped `/api/v1` sub-app, so
 * `c.get('siteId')` and `c.get('auth')` are always populated. Subscriptions are
 * per (site, endpoint); a re-subscribe from the same browser upserts in place.
 */

import { pushSubscriptions } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';

export const pushRouter = new Hono<AppEnv>();

function vapidPublicKey(c: { env: Record<string, unknown> }): string | undefined {
  return (
    (c.env.VAPID_PUBLIC_KEY as string | undefined) ||
    (typeof process !== 'undefined' ? process.env.VAPID_PUBLIC_KEY : undefined)
  );
}

pushRouter.get('/vapid-public-key', async (c) => {
  const publicKey = vapidPublicKey(c as never);
  if (!publicKey) {
    return c.json(
      { errors: [{ code: 'PUSH_NOT_CONFIGURED', message: 'VAPID keys not configured' }] },
      404,
    );
  }
  return c.json({ data: { publicKey } });
});

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

pushRouter.post('/subscriptions', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const parsed = subscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid subscription payload' }] },
      400,
    );
  }
  const { endpoint, keys } = parsed.data;
  const userId = auth?.userId ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  // Upsert on (site_id, endpoint): a browser re-subscribing rotates its keys.
  const [existing] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.siteId, siteId), eq(pushSubscriptions.endpoint, endpoint)));

  if (existing) {
    const [row] = await db
      .update(pushSubscriptions)
      .set({ p256dh: keys.p256dh, auth: keys.auth, userId, userAgent, updatedAt: new Date() })
      .where(and(eq(pushSubscriptions.siteId, siteId), eq(pushSubscriptions.id, existing.id)))
      .returning({ id: pushSubscriptions.id });
    return c.json({ data: { id: row!.id } });
  }

  const [row] = await db
    .insert(pushSubscriptions)
    .values({ siteId, userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent })
    .returning({ id: pushSubscriptions.id });
  return c.json({ data: { id: row!.id } }, 201);
});

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

pushRouter.delete('/subscriptions', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const parsed = unsubscribeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid payload' }] }, 400);
  }
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.siteId, siteId),
        eq(pushSubscriptions.endpoint, parsed.data.endpoint),
      ),
    );
  return c.json({ data: null });
});
