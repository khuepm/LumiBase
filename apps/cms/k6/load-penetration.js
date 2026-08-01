/**
 * load-penetration.js — Cache-penetration scenario
 * (high-load-cache-readiness Req 19.13–19.14; task 22.9).
 *
 * 95% of requests use random non-existent slugs / site ids (shape-valid so
 * they pass the identifier guard and exercise tombstones); 5% hit a known
 * good page. After the defence lands, DB-query-per-404 should fall to ≤ 0.05
 * (measure via Postgres `pg_stat_statements` or the CMS query counter).
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:1989 \
 *          --env SITE_ID=site_test \
 *          --env GOOD_SLUG=home \
 *          load-penetration.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const notFoundRate = new Rate('penetration_404_rate');
const okRate = new Rate('penetration_200_rate');
const limitedRate = new Rate('penetration_429_rate');
const requests = new Counter('penetration_requests');

export const options = {
  scenarios: {
    penetration: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.5'], // 404s count as "failed" for k6; tolerate them
    penetration_404_rate: ['rate>0.8'], // most traffic should be 404 probes
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
const SITE_ID = __ENV.SITE_ID || 'site_test';
const GOOD_SLUG = __ENV.GOOD_SLUG || 'home';

function randomSlug() {
  // Shape-valid (lowercase + hyphen) so the request reaches the tombstone tier.
  const n = Math.floor(Math.random() * 1e9);
  return `miss-${n}`;
}

export default function () {
  requests.add(1);
  const roll = Math.random();
  let url;
  if (roll < 0.05) {
    url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${GOOD_SLUG}`;
  } else {
    url = `${BASE_URL}/api/v1/deliver/page/${SITE_ID}/${randomSlug()}`;
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
