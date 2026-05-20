/**
 * smoke.js — Quick sanity check: 1 VU, 30 s, all main endpoints.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:8787 \
 *          --env SITE_ID=site_test \
 *          --env TOKEN=dev:user123 \
 *          smoke.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],         // <1% errors
    http_req_duration: ['p(95)<500'],       // 95th pct < 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';
const SITE_ID  = __ENV.SITE_ID  || 'site_test';
const TOKEN    = __ENV.TOKEN    || 'dev:user123';

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'X-Lumi-Site':   SITE_ID,
  'Content-Type':  'application/json',
};

export default function () {
  // Health check
  const health = http.get(`${BASE_URL}/health`, { headers });
  check(health, { 'health ok': (r) => r.status === 200 });

  // Collections list
  const cols = http.get(`${BASE_URL}/api/v1/collections`, { headers });
  check(cols, { 'collections 200': (r) => r.status === 200 });

  // Items list (first available collection)
  const colBody = cols.json();
  const firstCol = colBody?.data?.[0]?.name;
  if (firstCol) {
    const items = http.get(`${BASE_URL}/api/v1/items/${firstCol}?limit=10`, { headers });
    check(items, { 'items 200': (r) => r.status === 200 });
  }

  // Settings
  const settings = http.get(`${BASE_URL}/api/v1/settings`, { headers });
  check(settings, { 'settings 200': (r) => r.status === 200 });

  sleep(1);
}
