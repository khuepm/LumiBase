/**
 * load-deliver.js — public delivery read mix for the Phase 0 baseline.
 *
 * 90% of requests are public page reads using a finite Zipf distribution over
 * the seeded slugs. The remaining 10% exercise the authenticated item-list
 * path. The summary is also written by k6 when --summary-export is supplied;
 * handleSummary keeps a self-contained JSON artifact for direct runs.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:1989 \
 *     --env SITE_ID=loadtest-main-00000001 \
 *     --env TOKEN=dev:admin@lumibase.dev:admin \
 *     --env COLLECTION=loadtest_collection_01 \
 *     --env PAGE_COUNT=100 load-deliver.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const PAGE_COUNT = Number(__ENV.PAGE_COUNT || 100);
const ZIPF_EXPONENT = Number(__ENV.ZIPF_EXPONENT || 1.1);
const DELIVERY_RATIO = 0.9;
const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
const SITE_ID = __ENV.SITE_ID || 'loadtest-main-00000001';
const TOKEN = __ENV.TOKEN || 'dev:admin@lumibase.dev:admin';
const COLLECTION = __ENV.COLLECTION || 'loadtest_collection_01';

export const options = {
  scenarios: {
    delivery_mix: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || '2m',
      tags: { workload: 'phase0-delivery' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{operation:delivery}': ['p(95)<800'],
    'http_req_duration{operation:item_list}': ['p(95)<800'],
  },
};

const publicHeaders = { Accept: 'application/json' };
const itemHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Lumi-Site': SITE_ID,
  Accept: 'application/json',
};
const deliveryRequests = new Counter('delivery_requests');
const itemListRequests = new Counter('item_list_requests');

// Build the finite Zipf CDF once per VU. This is O(n), with n normally 100.
const cumulativeWeights = [];
let totalWeight = 0;
for (let rank = 1; rank <= PAGE_COUNT; rank += 1) {
  totalWeight += 1 / Math.pow(rank, ZIPF_EXPONENT);
  cumulativeWeights.push(totalWeight);
}

function zipfRank() {
  const target = Math.random() * totalWeight;
  let low = 0;
  let high = cumulativeWeights.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulativeWeights[middle] >= target) high = middle;
    else low = middle + 1;
  }
  return low + 1;
}

function pageSlug(rank) {
  return `loadtest-page-${String(rank).padStart(3, '0')}`;
}

export default function () {
  if (Math.random() < DELIVERY_RATIO) {
    const rank = zipfRank();
    const response = http.get(
      `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${pageSlug(rank)}`,
      { headers: publicHeaders, tags: { operation: 'delivery' } },
    );
    deliveryRequests.add(1);
    check(response, { 'delivery 200': (r) => r.status === 200 });
  } else {
    const page = Math.floor(Math.random() * 20) + 1;
    const response = http.get(
      `${BASE_URL}/api/v1/items/${COLLECTION}?limit=25&offset=${(page - 1) * 25}&meta=none`,
      { headers: itemHeaders, tags: { operation: 'item_list' } },
    );
    itemListRequests.add(1);
    check(response, { 'item list 200': (r) => r.status === 200 });
  }
  sleep(Number(__ENV.THINK_TIME || 0.1));
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(data),
    'summary.json': JSON.stringify(data, null, 2),
  };
}
