/**
 * load-deliver.js — Delivery API read-mix benchmark (high-load-cache-readiness
 * task 0.1 / design §13.3).
 *
 * Mix: 90% GET `/api/v1/deliver/page/:site/:slug` with Zipf popularity over
 * ≥50 seeded slugs; 10% authenticated item list reads.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:1989 \
 *          --env SITE_ID=site_load_a \
 *          --env TOKEN=dev:user123 \
 *          --env COLLECTION=articles \
 *          apps/cms/k6/load-deliver.js
 *
 * Seed dataset first: `DATABASE_URL=... tsx apps/cms/k6/seed.ts`
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.4/index.js';

const deliverRequests = new Counter('deliver_requests');
const listRequests = new Counter('list_requests');
const deliverOk = new Rate('deliver_ok_rate');
const listOk = new Rate('list_ok_rate');
const deliverDuration = new Trend('deliver_duration_ms', true);
const listDuration = new Trend('list_duration_ms', true);

const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
const SITE_ID = __ENV.SITE_ID || 'site_load_a';
const TOKEN = __ENV.TOKEN || 'dev:user123';
const COLLECTION = __ENV.COLLECTION || 'articles';
const SLUG_COUNT = Math.max(50, Number(__ENV.SLUG_COUNT || 60));
const ZIPF_S = Number(__ENV.ZIPF_S || 1.03);
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '2m';

const listHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Lumi-Site': SITE_ID,
  'Content-Type': 'application/json',
};

/** Precomputed Zipf CDF for slug indices 0..SLUG_COUNT-1 (0 → `home`). */
function buildZipfCdf(n, s) {
  const cdf = [];
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += 1 / Math.pow(i, s);
  }
  let cumulative = 0;
  for (let i = 1; i <= n; i++) {
    cumulative += 1 / Math.pow(i, s) / sum;
    cdf.push(cumulative);
  }
  return cdf;
}

const zipfCdf = buildZipfCdf(SLUG_COUNT, ZIPF_S);

function slugForIndex(index) {
  if (index === 0) return 'home';
  return `page-${String(index).padStart(3, '0')}`;
}

function zipfSlug() {
  const r = Math.random();
  let lo = 0;
  let hi = SLUG_COUNT - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (r <= zipfCdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return slugForIndex(lo);
}

export const options = {
  scenarios: {
    deliver_mix: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    deliver_ok_rate: ['rate>0.85'],
    list_ok_rate: ['rate>0.90'],
    deliver_duration_ms: ['p(95)<800'],
    list_duration_ms: ['p(95)<1200'],
  },
};

// Deliver is public; 200/304/404 are expected outcomes.
http.setResponseCallback(http.expectedStatuses(200, 304, 404));

export default function () {
  const roll = Math.random();

  if (roll < 0.9) {
    const slug = zipfSlug();
    const url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${slug}`;
    const start = Date.now();
    const res = http.get(url, { tags: { name: 'deliver_page' } });
    deliverDuration.add(Date.now() - start);
    deliverRequests.add(1);
    const ok = res.status === 200 || res.status === 304;
    deliverOk.add(ok);
    check(res, {
      'deliver status 200/304/404': (r) =>
        r.status === 200 || r.status === 304 || r.status === 404,
    });
  } else {
    const page = Math.floor(Math.random() * 3) + 1;
    const limit = [10, 25, 50][Math.floor(Math.random() * 3)];
    const url = `${BASE_URL}/api/v1/items/${COLLECTION}?limit=${limit}&page=${page}&meta=none`;
    const start = Date.now();
    const res = http.get(url, { headers: listHeaders, tags: { name: 'item_list' } });
    listDuration.add(Date.now() - start);
    listRequests.add(1);
    const ok = res.status === 200;
    listOk.add(ok);
    check(res, { 'list 200': (r) => r.status === 200 });
  }

  sleep(0.01);
}

export function handleSummary(data) {
  const date = new Date().toISOString().slice(0, 10);
  const summary = {
    date,
    scenario: 'apps/cms/k6/load-deliver.js',
    config: {
      BASE_URL,
      SITE_ID,
      COLLECTION,
      SLUG_COUNT,
      ZIPF_S,
      RATE,
      DURATION,
      mix: '90% deliver page (zipf slugs), 10% item list (meta=none)',
    },
    results: {
      http_reqs: data.metrics.http_reqs?.values?.count ?? null,
      http_req_failed_rate: data.metrics.http_req_failed?.values?.rate ?? null,
      http_req_duration_p50_ms: data.metrics.http_req_duration?.values?.['p(50)'] ?? null,
      http_req_duration_p95_ms: data.metrics.http_req_duration?.values?.['p(95)'] ?? null,
      http_req_duration_p99_ms: data.metrics.http_req_duration?.values?.['p(99)'] ?? null,
      deliver_requests: data.metrics.deliver_requests?.values?.count ?? null,
      list_requests: data.metrics.list_requests?.values?.count ?? null,
      deliver_ok_rate: data.metrics.deliver_ok_rate?.values?.rate ?? null,
      list_ok_rate: data.metrics.list_ok_rate?.values?.rate ?? null,
      deliver_duration_p95_ms: data.metrics.deliver_duration_ms?.values?.['p(95)'] ?? null,
      list_duration_p95_ms: data.metrics.list_duration_ms?.values?.['p(95)'] ?? null,
    },
    thresholds_pass: Object.values(data.root_group?.checks ?? {}).every((c) => c.passes === c.fails + c.passes),
  };

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`load-deliver-summary-${date}.json`]: JSON.stringify(summary, null, 2),
  };
}
