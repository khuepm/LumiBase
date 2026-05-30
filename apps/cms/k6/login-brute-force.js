/**
 * login-brute-force.js — Brute-force defence load test (admin-setup-wizard
 * Req 8.2, 8.3; design §13.4).
 *
 * Scenarios:
 *
 *   1. **brute_force** — 50 concurrent VUs spam `/api/v1/auth/login` with
 *      wrong passwords for ~2 minutes. We expect the LoginGuard
 *      middleware (apps/cms/src/modules/login-guard/middleware.ts) to
 *      flip from 401 INVALID_CREDENTIALS to 429 IP_BLOCKED once the
 *      rolling failure count for the source IP reaches
 *      `ipMaxFailedAttempts` over `lockoutWindowSeconds` (Standard
 *      preset: 20 / 900 s — Req 6.3).
 *
 *   2. **baseline_traffic** — a small constant-rate scenario hitting
 *      unaffected routes (`/health`, `/api/v1/setup/state`) so we can
 *      assert the brute-force storm does *not* degrade the rest of
 *      the API. Threshold-checks `http_req_duration{scenario:
 *      baseline_traffic}` p95 against a configurable budget.
 *
 * Assertions exposed as k6 thresholds (test fails if violated):
 *
 *   - `login_blocked_responses` count > 0 — the IP **must** trip the
 *     block at some point during the run (Req 8.3).
 *   - `attempts_before_first_block` p95 ≤ N_MAX — the block kicks in
 *     within roughly the configured threshold (default Standard = 20).
 *     Some headroom is allowed because 50 VUs race for the
 *     server-counted N-th failure and a few extra requests can
 *     overlap before the counter materialises.
 *   - `http_req_failed{scenario:baseline_traffic}` < 1% — non-login
 *     routes keep returning 2xx during the spam.
 *   - `http_req_duration{scenario:baseline_traffic}` p95 ≤
 *     BASELINE_P95_MS — non-login routes keep their latency budget.
 *
 * This test is **on-demand** (not part of CI). It assumes a running
 * CMS instance whose system_state is `initialized` and the bootstrap
 * admin / configured `LOGIN_EMAIL` exists. The test never hits the
 * Studio admin path — only `/api/v1/*` and `/health` — so the
 * adminPathGuard does not gate it.
 *
 * Environment variables:
 *
 *   - BASE_URL                  CMS base URL (default
 *                               http://localhost:8787).
 *   - LOGIN_EMAIL               Email used in the wrong-password POST
 *                               (default `bruteforce-target@example.test`).
 *                               The email does not need to exist —
 *                               the LoginGuard's no-enumeration design
 *                               (Property 8) means failed lookups for
 *                               unknown emails are still counted toward
 *                               the IP rate limit, so the same block
 *                               behaviour applies either way.
 *   - WRONG_PASSWORD            Password to send (default
 *                               `definitely-not-the-password`). Must
 *                               not match a real account.
 *   - IP_MAX_FAILED_ATTEMPTS    Expected `ipMaxFailedAttempts` from the
 *                               configured Lockout_Policy (default 20
 *                               for the Standard preset).
 *   - IP_BLOCK_HEADROOM         Extra attempts tolerated before the
 *                               first observed 429 (default 10).
 *                               Sets the `attempts_before_first_block`
 *                               p95 threshold.
 *   - BASELINE_P95_MS           p95 latency budget for the
 *                               baseline_traffic scenario in ms
 *                               (default 800).
 *   - DURATION                  Brute-force scenario duration (default
 *                               `2m`).
 *
 * Run:
 *
 *   k6 run \
 *     --env BASE_URL=http://localhost:8787 \
 *     --env LOGIN_EMAIL=bruteforce@example.test \
 *     apps/cms/k6/login-brute-force.js
 *
 * Validates: Requirements 8.2, 8.3.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ── env / configuration ─────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';
const LOGIN_EMAIL = __ENV.LOGIN_EMAIL || 'bruteforce-target@example.test';
const WRONG_PASSWORD = __ENV.WRONG_PASSWORD || 'definitely-not-the-password';

const IP_MAX_FAILED_ATTEMPTS = Number.parseInt(
  __ENV.IP_MAX_FAILED_ATTEMPTS || '20',
  10,
);
const IP_BLOCK_HEADROOM = Number.parseInt(
  __ENV.IP_BLOCK_HEADROOM || '10',
  10,
);
const BASELINE_P95_MS = Number.parseInt(__ENV.BASELINE_P95_MS || '800', 10);
const DURATION = __ENV.DURATION || '2m';

const ATTEMPTS_BEFORE_BLOCK_P95_THRESHOLD =
  IP_MAX_FAILED_ATTEMPTS + IP_BLOCK_HEADROOM;

// ── custom metrics ──────────────────────────────────────────────────────

const loginBlockedResponses = new Counter('login_blocked_responses');
const loginInvalidCredentialResponses = new Counter(
  'login_invalid_credential_responses',
);
const loginUnexpectedResponses = new Counter('login_unexpected_responses');
const attemptsBeforeFirstBlock = new Trend(
  'attempts_before_first_block',
  /* isTime= */ false,
);
const blockObservedRate = new Rate('block_observed');

// ── scenarios + thresholds ──────────────────────────────────────────────

export const options = {
  scenarios: {
    brute_force: {
      executor: 'constant-vus',
      vus: 50,
      duration: DURATION,
      tags: { scenario: 'brute_force' },
      exec: 'bruteForce',
    },
    baseline_traffic: {
      executor: 'constant-arrival-rate',
      rate: 20, // 20 RPS — small steady stream so we can assert no degradation
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 10,
      tags: { scenario: 'baseline_traffic' },
      exec: 'baselineTraffic',
    },
  },
  thresholds: {
    // ── Req 8.3: IP must be blocked at some point during the run ──
    // The brute_force scenario sends ~50 × N requests; well above the
    // Standard 20-attempt threshold, so the count of 429 responses
    // must be strictly positive.
    login_blocked_responses: ['count>0'],
    // The fraction of brute-force requests observed as blocked must
    // also climb — useful as a smoke signal in the summary table.
    block_observed: ['rate>0'],
    // ── Req 8.2: block kicks in close to the configured N ──
    // The first 429 observed by any VU should be near the policy
    // threshold + a small headroom that accounts for the 50-VU race.
    attempts_before_first_block: [
      `p(95)<${ATTEMPTS_BEFORE_BLOCK_P95_THRESHOLD}`,
    ],
    // ── No throughput / latency degradation on unrelated routes ──
    'http_req_failed{scenario:baseline_traffic}': ['rate<0.01'],
    'http_req_duration{scenario:baseline_traffic}': [
      `p(95)<${BASELINE_P95_MS}`,
    ],
    // The brute-force scenario itself is *expected* to produce a high
    // failure rate (every request is wrong-on-purpose), so we don't
    // gate it on http_req_failed. We do still want unexpected response
    // codes (anything that's neither 401 nor 429) to stay rare:
    login_unexpected_responses: ['count<10'],
  },
};

// ── shared request shaping ──────────────────────────────────────────────

const loginHeaders = {
  'Content-Type': 'application/json',
};

const loginBody = JSON.stringify({
  email: LOGIN_EMAIL,
  password: WRONG_PASSWORD,
});

// ── brute-force VU code ─────────────────────────────────────────────────

/**
 * Each VU keeps a per-iteration counter of how many login attempts it
 * has issued before observing the first 429. We record that into the
 * `attempts_before_first_block` Trend so we can assert (Req 8.2) that
 * the block kicks in close to the configured `ipMaxFailedAttempts`.
 */
export function bruteForce() {
  // `__ITER` is k6's per-VU iteration counter, but we want attempts
  // observed *by this VU* up to the first block, so track it locally.
  // VUs share state across iterations via the `__VU` partition — k6
  // re-runs the default function on each iteration; we maintain a
  // module-level Map keyed by `__VU` so the counter survives across
  // iterations within the same VU but never leaks across processes.
  const attempts = incrementAttemptsForVu();

  const res = http.post(`${BASE_URL}/api/v1/auth/login`, loginBody, {
    headers: loginHeaders,
    tags: { name: 'auth_login_brute' },
  });

  if (res.status === 429) {
    loginBlockedResponses.add(1);
    blockObservedRate.add(true);
    if (!hasRecordedFirstBlockForVu()) {
      attemptsBeforeFirstBlock.add(attempts);
      markFirstBlockForVu();
    }
  } else if (res.status === 401) {
    loginInvalidCredentialResponses.add(1);
    blockObservedRate.add(false);
  } else if (res.status === 423) {
    // ACCOUNT_LOCKED is a *different* lockout path than IP_BLOCKED.
    // It can fire if LOGIN_EMAIL exists and accumulates per-account
    // failures faster than the IP threshold. Count it as blocked for
    // the rate metric but not toward IP_BLOCKED — we still want the
    // 429 count to be strictly positive.
    blockObservedRate.add(true);
  } else {
    loginUnexpectedResponses.add(1);
    blockObservedRate.add(false);
  }

  // Sanity check (visible in the per-iteration check summary, doesn't
  // gate the run).
  check(res, {
    'auth_login returned a known status': (r) =>
      r.status === 401 || r.status === 423 || r.status === 429,
  });

  // Tiny pause keeps the run from melting the loopback while still
  // generating a steady stream of attempts.
  sleep(0.1);
}

// ── baseline-traffic VU code ────────────────────────────────────────────

/**
 * Hits two unaffected routes alternately so we can attribute any
 * latency degradation to a specific endpoint:
 *
 *   - `/health`               — lives outside `/api/*`; checks the DB,
 *                               cache, search, storage, queue.
 *   - `/api/v1/setup/state`   — public read endpoint, runs through the
 *                               full middleware chain incl.
 *                               adminPathGuard.
 */
export function baselineTraffic() {
  const which = (__ITER % 2 === 0) ? 'health' : 'setup_state';
  const url =
    which === 'health'
      ? `${BASE_URL}/health`
      : `${BASE_URL}/api/v1/setup/state`;

  const res = http.get(url, { tags: { name: which } });

  check(res, {
    'baseline route 2xx': (r) => r.status >= 200 && r.status < 300,
  });
}

// ── per-VU state ────────────────────────────────────────────────────────
//
// k6 spawns one JS VM per VU, so module-level variables are isolated
// across VUs. We use simple primitives instead of Maps so the counters
// don't grow unboundedly across iterations.

let _attemptsThisVu = 0;
let _firstBlockRecorded = false;

function incrementAttemptsForVu() {
  _attemptsThisVu += 1;
  return _attemptsThisVu;
}

function hasRecordedFirstBlockForVu() {
  return _firstBlockRecorded;
}

function markFirstBlockForVu() {
  _firstBlockRecorded = true;
}
