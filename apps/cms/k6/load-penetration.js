/**
 * load-penetration.js — Cache-penetration scenario
 * (high-load-cache-readiness Req 19.13–19.14; task 22.9).
 *
 * Mix: 95% probes against a *finite* pool of shape-valid missing slugs (so
 * tombstones can absorb repeats after the first miss per key); 5% hit a known
 * good page. A tiny fraction of probes use shape-invalid slugs to exercise the
 * identifier guard (0 DB queries).
 *
 * After the defence lands, DB-query-per-404 should fall to ≤ 0.05
 * (measure via Postgres `pg_stat_user_tables` / `pg_stat_statements` on
 * `lumibase_pages`, or the Vitest harness in `cache-penetration.test.ts`).
 *
 * Tip: for DB-query measurement from a single IP, either raise
 * `LUMIBASE_DELIVER_RATE_LIMIT` above arrival-rate×60 or set it to `0` so 429s
 * do not truncate the sample. Default 1200/min is intentional anti-abuse.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:1989 \
 *          --env SITE_ID=site_test \
 *          --env GOOD_SLUG=home \
 *          --env MISS_POOL=40 \
 *          load-penetration.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const notFoundRate = new Rate('penetration_404_rate');
const okRate = new Rate('penetration_200_rate');
const limitedRate = new Rate('penetration_429_rate');
const requests = new Counter('penetration_requests');

const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || '2m';

export const options = {
  scenarios: {
    penetration: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    // 404 is the expected majority outcome — treat 200/404/429 as success.
    http_req_failed: ['rate<0.05'],
    penetration_404_rate: ['rate>0.8'], // most traffic should be 404 probes
  },
};

// Mark penetration statuses as expected so http_req_failed stays meaningful.
http.setResponseCallback(http.expectedStatuses(200, 404, 429));

const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
const SITE_ID = __ENV.SITE_ID || 'site_test';
const GOOD_SLUG = __ENV.GOOD_SLUG || 'home';
const MISS_POOL = Math.max(1, Number(__ENV.MISS_POOL || 40));

function missSlug() {
  // Shape-valid (lowercase + hyphen) so the request reaches the tombstone tier.
  // Finite pool → after warm-up, repeats are served from tombstones.
  const n = Math.floor(Math.random() * MISS_POOL);
  return `miss-${n}`;
}

function badShapeSlug() {
  // Identifier guard rejects before DB (uppercase / spaces).
  return `Bad Shape ${Math.floor(Math.random() * 100)}`;
}

export default function () {
  requests.add(1);
  const roll = Math.random();
  let url;
  if (roll < 0.05) {
    url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${GOOD_SLUG}`;
  } else if (roll < 0.08) {
    url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${encodeURIComponent(badShapeSlug())}`;
  } else {
    url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${missSlug()}`;
  }

  const res = http.get(url);
  notFoundRate.add(res.status === 404);
  okRate.add(res.status === 200);
  limitedRate.add(res.status === 429);

  check(res, {
    'status is 200, 404, or 429': (r) =>
      r.status === 200 || r.status === 404 || r.status === 429,
  });

  sleep(0.01);
}
