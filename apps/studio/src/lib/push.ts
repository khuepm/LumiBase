/**
 * Web Push enrolment for the Studio (push-noti feature).
 *
 * Wraps the browser Push API + service-worker registration and syncs the
 * resulting `PushSubscription` with the CMS (`/api/v1/push/subscriptions`).
 * The CMS encrypts and delivers notifications to these endpoints via VAPID, so
 * an operator is reached even with the Studio tab closed.
 *
 * All functions are no-ops / report a reason on browsers without push support
 * so callers can render a disabled control rather than crash.
 */

import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

const SW_URL = '/sw.js';

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

/** Per-tenant server-side push status (Studio Settings → Notifications). */
export interface PushServerStatus {
  /** VAPID keys configured on the deployment (shared across all tenants). */
  vapidConfigured: boolean;
  /** SiteRoom Durable Object bound (in-app realtime available). */
  realtimeAvailable: boolean;
  /** Enrolled Web Push subscriptions for THIS tenant. */
  subscriptions: number;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Convert a base64url VAPID public key into the `Uint8Array` the API expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function authHeaders(): Record<string, string> {
  const token = getActiveToken();
  const site = getActiveSite();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(site ? { 'x-site-id': site } : {}),
  };
}

async function fetchVapidPublicKey(): Promise<string | null> {
  const res = await fetch(`${getApiBaseUrl()}/api/v1/push/vapid-public-key`, {
    headers: authHeaders(),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { data?: { publicKey?: string } };
  return body.data?.publicKey ?? null;
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_URL);
}

/** Current enrolment state for rendering the toggle. */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

/**
 * Request permission, subscribe, and register the subscription with the CMS.
 * Returns the resulting state plus an optional human-readable reason on failure.
 */
export async function enablePush(): Promise<{ state: PushState; reason?: string }> {
  if (!isPushSupported()) return { state: 'unsupported', reason: 'Push not supported in this browser' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { state: permission === 'denied' ? 'denied' : 'unsubscribed', reason: 'Permission not granted' };
  }

  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) {
    return { state: 'unsubscribed', reason: 'Push not configured on the server (no VAPID key)' };
  }

  const reg = await registerServiceWorker();
  await navigator.serviceWorker.ready;

  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  const res = await fetch(`${getApiBaseUrl()}/api/v1/push/subscriptions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!res.ok) {
    return { state: 'unsubscribed', reason: 'Failed to register subscription with the server' };
  }
  return { state: 'subscribed' };
}

/** Fetch the per-tenant push status used by the Settings check panel. */
export async function getPushStatus(): Promise<PushServerStatus> {
  const res = await fetch(`${getApiBaseUrl()}/api/v1/push/status`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load push status (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as { data?: PushServerStatus };
  return (
    body.data ?? { vapidConfigured: false, realtimeAvailable: false, subscriptions: 0 }
  );
}

/**
 * Ask the server to dispatch a one-off test notification to this tenant
 * (in-app + Web Push). Returns the server's dispatch summary.
 */
export async function sendTestPush(): Promise<{
  dispatched: boolean;
  vapidConfigured: boolean;
  realtimeAvailable: boolean;
  subscriptions: number;
}> {
  const res = await fetch(`${getApiBaseUrl()}/api/v1/push/test`, {
    method: 'POST',
    headers: authHeaders(),
    body: '{}',
  });
  if (!res.ok) throw new Error(`Failed to send test notification (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  return body.data as never;
}

/** Unsubscribe locally and tell the CMS to drop the row. Idempotent. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch {
    /* already gone */
  }
  await fetch(`${getApiBaseUrl()}/api/v1/push/subscriptions`, {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
