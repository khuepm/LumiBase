#!/usr/bin/env node
/**
 * Client-side push connection test (push-noti feature).
 *
 * Exercises the full server path for a tenant: checks push status, then
 * dispatches a one-off test notification (in-app + Web Push) to that site's
 * enrolled browsers. Useful for ops/CI smoke checks without opening Studio.
 *
 * Usage:
 *   LUMIBASE_URL=https://api.example.com \
 *   LUMIBASE_TOKEN=<bearer> \
 *   LUMIBASE_SITE=<siteId> \
 *   node apps/cms/scripts/push-test.mjs
 *
 * Defaults: URL=http://localhost:1989. TOKEN and SITE are required (the
 * endpoints sit behind the authenticated, tenant-scoped /api/v1 chain).
 */

const base = (process.env.LUMIBASE_URL || 'http://localhost:1989').replace(/\/+$/, '');
const token = process.env.LUMIBASE_TOKEN || '';
const site = process.env.LUMIBASE_SITE || '';

if (!token || !site) {
  console.error('Set LUMIBASE_TOKEN and LUMIBASE_SITE (and optionally LUMIBASE_URL).');
  process.exit(2);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'x-lumi-site': site,
};

async function main() {
  const statusRes = await fetch(`${base}/api/v1/push/status`, { headers });
  if (!statusRes.ok) {
    console.error(`status check failed: HTTP ${statusRes.status}`);
    process.exit(1);
  }
  const status = (await statusRes.json()).data;
  console.log('Push status for site', site);
  console.log('  VAPID configured :', status.vapidConfigured);
  console.log('  Realtime (in-app):', status.realtimeAvailable);
  console.log('  Subscriptions    :', status.subscriptions);

  const testRes = await fetch(`${base}/api/v1/push/test`, { method: 'POST', headers, body: '{}' });
  if (!testRes.ok) {
    console.error(`test dispatch failed: HTTP ${testRes.status}`);
    process.exit(1);
  }
  const result = (await testRes.json()).data;
  console.log('\nTest notification dispatched:', JSON.stringify(result));

  if (!status.vapidConfigured && !status.realtimeAvailable) {
    console.warn('\n⚠ Neither transport is available — nothing was actually delivered.');
    process.exit(1);
  }
  if (status.subscriptions === 0 && status.realtimeAvailable) {
    console.warn('\nℹ No Web Push subscriptions yet — only in-app realtime was sent.');
  }
}

main().catch((err) => {
  console.error('push-test failed:', err);
  process.exit(1);
});
