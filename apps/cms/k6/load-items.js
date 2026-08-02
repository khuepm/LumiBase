/**
 * load-items.js — Item list throughput + item create burst tests.
 *
 * Scenario 1 (list-throughput): ramp to 50 VUs reading items lists.
 * Scenario 2 (create-burst):    30 VUs creating items concurrently for 60 s.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:1989 \
 *          --env SITE_ID=site_test \
 *          --env TOKEN=dev:user123 \
 *          --env COLLECTION=articles \
 *          load-items.js
 */

import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const options = {
  scenarios: {
    list_throughput: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { scenario: 'list' },
    },
    create_burst: {
      executor: 'constant-vus',
      vus: 30,
      duration: '60s',
      startTime: '30s',           // start after ramp-up begins
      tags: { scenario: 'create' },
    },
    detail_throughput: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      startTime: '30s',
      tags: { scenario: 'detail' },
    },
  },
  thresholds: {
    'http_req_failed{scenario:list}': ['rate<0.01'],
    'http_req_failed{scenario:create}': ['rate<0.02'],
    'http_req_duration{scenario:list}': ['p(95)<800'],
    'http_req_duration{scenario:create}': ['p(95)<1200'],
    'items_created': ['count>0'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
const SITE_ID = __ENV.SITE_ID || 'site_test';
const TOKEN = __ENV.TOKEN || 'dev:user123';
const COLLECTION = __ENV.COLLECTION || 'articles';

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'X-Lumi-Site': SITE_ID,
  'Content-Type': 'application/json',
};

const itemsCreated = new Counter('items_created');
const createDuration = new Trend('item_create_duration_ms', true);
const listDuration = new Trend('item_list_duration_ms', true);
const detailDuration = new Trend('item_detail_duration_ms', true);
const listRequests = new Counter('item_list_requests');
const detailRequests = new Counter('item_detail_requests');

let createdIds = [];

export default function () {
  const scenario = exec.scenario.name;

  if (scenario === 'create_burst') {
    // Create an item
    const payload = JSON.stringify({
      data: {
        title: `Load test item ${Date.now()}`,
        status: 'draft',
      },
      status: 'draft',
    });
    const start = Date.now();
    const res = http.post(
      `${BASE_URL}/api/v1/items/${COLLECTION}`,
      payload,
      { headers, tags: { name: 'item_create' } },
    );
    createDuration.add(Date.now() - start);

    const ok = check(res, {
      'create 200/201': (r) => r.status === 200 || r.status === 201,
    });
    if (ok) {
      itemsCreated.add(1);
      const id = res.json()?.data?.id;
      if (id) createdIds.push(id);
    }
    sleep(0.5);
  } else if (scenario === 'detail_throughput') {
    const itemId = `I000001${String(Math.floor(Math.random() * 100000) + 1).padStart(6, '0')}00000000`;
    const res = http.get(
      `${BASE_URL}/api/v1/items/${COLLECTION}/${itemId}`,
      { headers, tags: { name: 'item_detail' } },
    );
    detailDuration.add(res.timings.duration);
    detailRequests.add(1);
    check(res, { 'detail 200': (r) => r.status === 200 });
    sleep(Math.random() * 0.5 + 0.1);
  } else {
    // List items with pagination
    const page = Math.floor(Math.random() * 5) + 1;
    const limit = [10, 25, 50][Math.floor(Math.random() * 3)];
    const res = http.get(
      `${BASE_URL}/api/v1/items/${COLLECTION}?limit=${limit}&page=${page}`,
      { headers, tags: { name: 'item_list' } },
    );
    listDuration.add(res.timings.duration);
    listRequests.add(1);
    check(res, { 'list 200': (r) => r.status === 200 });
    sleep(Math.random() * 0.5 + 0.1);
  }
}

export function teardown() {
  // Clean up created items (best-effort)
  for (const id of createdIds.slice(0, 100)) {
    http.del(`${BASE_URL}/api/v1/items/${COLLECTION}/${id}`, null, { headers });
  }
}
