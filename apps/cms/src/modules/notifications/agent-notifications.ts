/**
 * Agent notification broadcaster (push-noti feature).
 *
 * A single fan-out point for the operational events a human operator wants to
 * hear about the moment they happen: HITL approvals, L3 veto windows, agent
 * incidents, and goal/run status changes. It pushes through two transports:
 *
 *   1. In-app realtime — the per-site `SiteRoom` Durable Object broadcasts a
 *      `notification` frame to every connected Studio session. Cloudflare-only;
 *      a no-op (graceful) when the DO namespace isn't bound (Docker / tests /
 *      background contexts without a request env).
 *   2. Web Push — encrypted delivery to every stored `push_subscriptions` row
 *      for the site, so an operator is reached even with the tab closed.
 *      Active only when VAPID keys are configured.
 *
 * Both transports are best-effort and fully isolated: a failure in either (or
 * the absence of either) never propagates to the caller. Producers call
 * {@link emitAgentNotification} after their DB write commits; the existing
 * 60s Mission-Control inbox poll remains the fallback when neither transport
 * is available, so no event is ever lost — only its latency changes.
 */

import { pushSubscriptions, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { readVapidKeys, sendWebPush, type VapidKeys } from './web-push';

/** The operational event classes that produce a notification. */
export type AgentNotificationKind = 'approval' | 'veto' | 'incident' | 'goal' | 'run';

export type AgentNotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * Wire shape delivered to clients (in-app frame `notification` field, and the
 * Web Push JSON body). Kept flat and JSON-serialisable so the service worker
 * and the Studio panel can consume it without translation.
 */
export interface AgentNotification {
  /** Stable id for client-side dedupe across the two transports. */
  id: string;
  kind: AgentNotificationKind;
  severity: AgentNotificationSeverity;
  title: string;
  body: string;
  /** Admin-relative deep link, e.g. `/mission-control/inbox?entry=approval:<id>`. */
  deepLink?: string;
  /** Source entity id (approval/incident/goal/run id) for client dedupe. */
  entityId: string;
  /** ISO-8601 UTC timestamp of when the event was emitted. */
  ts: string;
}

/** What a producer supplies; `id`/`ts` are filled in by the broadcaster. */
export type AgentNotificationInput = Omit<AgentNotification, 'id' | 'ts'>;

export interface EmitNotificationDeps {
  db: Database;
  siteId: string;
  /** SiteRoom DO namespace (Cloudflare only). Omit to skip in-app delivery. */
  doNamespace?: DurableObjectNamespace;
  /** Pre-resolved VAPID keys; when omitted they are read from {@link env}. */
  vapid?: VapidKeys | null;
  /** Loose env bag used to resolve VAPID keys when {@link vapid} is absent. */
  env?: Record<string, string | undefined>;
}

/** A bound notifier callback threaded into services that only hold `db`+`siteId`. */
export type AgentNotifier = (input: AgentNotificationInput) => void;

function randomId(): string {
  // crypto.randomUUID is available on Workers and Node 18+.
  try {
    return crypto.randomUUID();
  } catch {
    return `n_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Fan a single notification out to in-app + Web Push transports. Fire-and-
 * forget friendly: callers may `void emitAgentNotification(...)`. Resolves once
 * both transports have settled; never rejects.
 */
export async function emitAgentNotification(
  deps: EmitNotificationDeps,
  input: AgentNotificationInput,
): Promise<void> {
  const notification: AgentNotification = {
    ...input,
    id: randomId(),
    ts: new Date().toISOString(),
  };

  await Promise.allSettled([
    publishInApp(deps, notification),
    publishWebPush(deps, notification),
  ]);
}

async function publishInApp(deps: EmitNotificationDeps, notification: AgentNotification): Promise<void> {
  if (!deps.doNamespace) return;
  try {
    const id = deps.doNamespace.idFromName(deps.siteId);
    const stub = deps.doNamespace.get(id);
    await stub.fetch(
      new Request('https://internal/publish-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'notification', notification }),
      }),
    );
  } catch (err) {
    console.error('[agent-notifications] in-app publish failed', {
      siteId: deps.siteId,
      kind: notification.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function publishWebPush(deps: EmitNotificationDeps, notification: AgentNotification): Promise<void> {
  const vapid = deps.vapid ?? readVapidKeys(deps.env ?? {});
  if (!vapid) return;

  let subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  try {
    subs = await deps.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.siteId, deps.siteId));
  } catch (err) {
    console.error('[agent-notifications] subscription lookup failed', {
      siteId: deps.siteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (subs.length === 0) return;

  const payloadJson = JSON.stringify(notification);
  const expiredIds: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      const result = await sendWebPush(sub, payloadJson, vapid);
      if (result.expired) expiredIds.push(sub.id);
    }),
  );

  // Prune subscriptions the push service reported as gone (404/410).
  if (expiredIds.length > 0) {
    await Promise.allSettled(
      expiredIds.map((subId) =>
        deps.db
          .delete(pushSubscriptions)
          .where(and(eq(pushSubscriptions.siteId, deps.siteId), eq(pushSubscriptions.id, subId))),
      ),
    );
  }
}
