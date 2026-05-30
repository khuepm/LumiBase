/**
 * Integration test for `adminPathGuard` 404 indistinguishability
 * (admin-setup-wizard task 4.7).
 *
 * **Validates: Requirements 5.1, 5.6**
 * **Validates: Property 7 — 404 Indistinguishability (design.md §13.3)**
 *
 * Background
 * ----------
 * Req 5.1 mandates that, once the instance is initialised, requests
 * to a `Default_Admin_Path` that is *not* the configured admin path
 * (e.g. `/admin`, `/studio`, `/wp-admin`) must return a 404 that is
 * indistinguishable from the 404 served for any other unknown path
 * (Req 5.6). "Indistinguishable" is a three-axis claim:
 *
 *   1. **Latency**: a probing bot must not be able to tell, by
 *      response time alone, whether the path it just hit is on the
 *      bait list or just a random URL on the host. Property 7 pins
 *      the bound at "p95 delta ≤ 5 ms" between the two batches.
 *   2. **Response body**: every 404 must be the *exact same bytes*.
 *      Different bytes (status codes embedded in JSON, error
 *      strings, length variations) would let an attacker classify
 *      responses by `content-length` alone.
 *   3. **Header set**: the guard pins responses to exactly two
 *      headers — `Content-Type` and `Content-Length` — so no
 *      `cache-control`, `vary`, `x-powered-by`, or other discriminator
 *      can betray which leaf served the response (design §7.2).
 *
 * Approach
 * --------
 * We build a stand-in Hono app that mirrors the production middleware
 * chain (`withLogger` → DB stub → `adminPathGuard`) wired against a
 * fake `system_state` row in the `'initialized'` state with admin
 * path `/lumi-7f3a9c`. The two scenarios under test:
 *
 *   - **default bait path**: `/admin` — explicitly listed in
 *     `Default_Admin_Paths` (Glossary), the path bots try first.
 *   - **random unknown path**: `/some-random-path` — not on the bait
 *     list, just a URL that does not exist on this host.
 *
 * Both scenarios traverse the *same* middleware code path through the
 * guard: `isStudioScopePath` returns true for both, neither matches
 * `pathMatchesAdminScope`, so both fall through to the
 * `selectOneNoop` + `buildIndistinguishable404` branch. The whole
 * point of the test is to confirm — empirically, with a real
 * end-to-end fetch — that nothing on the way in or on the way out
 * accidentally diverges the two response shapes.
 *
 * Measurement design
 * ------------------
 * Same playbook as `path-compare.timing.test.ts`:
 *   - **Warmup** before the timed loops to settle V8 tier-up.
 *   - **Interleave** sample order so any thermal/GC drift across the
 *     run affects both scenarios symmetrically rather than landing
 *     entirely in one.
 *   - **Use `performance.now()`** for sub-millisecond resolution.
 *   - **Compute p95** by sorting and indexing at the 0.95 quantile
 *     rather than computing a mean — Property 7 explicitly bounds
 *     p95, which catches tail-heavy leaks that means smooth out.
 *
 * Tolerance
 * ---------
 * The 5 ms p95-delta bound is loose on purpose. A `SELECT 1` no-op
 * against the fake DB resolves in microseconds, the JSON encode/copy
 * is also microseconds, so the natural per-request latency sits well
 * under 1 ms. 5 ms acts as a "gross leak" gate that catches an
 * accidental fast-path regression (e.g. forgetting `selectOneNoop`
 * for the bait branch, or a header-set divergence triggering a
 * different code path inside Hono) while staying robust against CI
 * GC pauses and noisy-neighbour scheduling jitter.
 *
 * Runtime budget
 * --------------
 * 2 × 500 timed requests + warmup ≈ 1.5k `app.request()` round-trips
 * through the in-process Hono. On a developer laptop this finishes
 * in a few hundred ms; the timeout below is set generously to absorb
 * CI noise.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../env';
import { withLogger } from '../middleware/logger';
import {
  __resetAdminPathGuardCacheForTests,
  adminPathGuard,
} from '../middleware/admin-path-guard';

vi.setConfig({ testTimeout: 60_000 });

// ── Tunables ────────────────────────────────────────────────────────────

/** Timed requests per scenario (per task: 500). */
const SAMPLES = 500;

/** Untimed warmup requests per scenario before measurement begins. */
const WARMUP = 100;

/** p95 latency delta bound (ms). Pinned by Req 5.1 / Property 7. */
const P95_DELTA_BOUND_MS = 5;

/** Path picked from `Default_Admin_Paths` (Glossary). */
const DEFAULT_BAIT_PATH = '/admin';

/** Random path that does not exist on the host. */
const RANDOM_UNKNOWN_PATH = '/some-random-path';

/** Configured admin path used by the fake `system_state` row. */
const CONFIGURED_ADMIN_PATH = '/lumi-7f3a9c';

// ── DB fake ─────────────────────────────────────────────────────────────

interface FakeDbState {
  state: 'uninitialized' | 'initializing' | 'initialized';
  adminPath: string | null;
}

/**
 * Minimal Drizzle-shaped fake. Returns the configured `system_state`
 * row from `select(...).from(...).where(...).limit(...)`, and a
 * resolved no-op for `execute(SELECT 1)`. We avoid spinning up a real
 * postgres-js connection so the test can run in any context (CI
 * sandbox, contributor laptop, Workers-only shell).
 */
function makeFakeDb(initial: FakeDbState): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () =>
      Promise.resolve([{ state: initial.state, adminPath: initial.adminPath }]),
  };
  return {
    select: () => fluent,
    execute: () => Promise.resolve(undefined),
  } as unknown as Database;
}

// ── App harness ─────────────────────────────────────────────────────────

/**
 * Build a Hono app whose global middleware order mirrors the
 * production `index.ts` (admin-setup-wizard task 4.3): `withLogger`
 * → (stubbed runtime/db) → `adminPathGuard` → routed handlers. The
 * stand-in `app.route('/api/v1/setup', ...)` is included so the
 * `/api/*` bypass path is realistic — though this test only exercises
 * Studio-scope paths, having the API mount present matches the real
 * chain and rules out a missing-mount artefact.
 */
function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', withLogger());
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.use('*', adminPathGuard());

  app.route(
    '/api/v1/setup',
    new Hono<AppEnv>().get('/state', (c) =>
      c.json({ state: 'initialized', requiresSetupToken: false }),
    ),
  );
  // Catch-all so Studio-scope paths that *do* match the admin path
  // (none in this test) wouldn't trigger an accidental Hono "no
  // route" 404 with a different envelope.
  app.all('*', (c) => c.json({ ok: true, tag: c.get('responseType') ?? null }));
  return app;
}

// ── Stats helpers ───────────────────────────────────────────────────────

/**
 * p-th quantile by linear interpolation on a sorted copy of `samples`.
 * For p=0.95 with N=500 the index lands at 474.05 → between samples
 * 474 and 475 (0-indexed), interpolated. Uses the standard
 * inclusive-percentile formula (`(n - 1) * p`).
 */
function quantile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  const w = pos - lo;
  return loVal * (1 - w) + hiVal * w;
}

// ── Snapshot helpers ────────────────────────────────────────────────────

/**
 * Pull the response body as a raw `Uint8Array` so byte-equality is
 * meaningful. `await res.text()` would stringify and lose any
 * encoding-level divergence (BOMs, zero-width chars), and `.json()`
 * would normalise key order.
 */
async function readBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Lowercase, sorted, unique header-name set. Only header *names*
 * matter for indistinguishability of the *set*; individual values
 * (e.g. `Content-Length`) are content-dependent and asserted
 * separately.
 */
function headerNameSet(res: Response): readonly string[] {
  const names = new Set<string>();
  res.headers.forEach((_value, name) => {
    names.add(name.toLowerCase());
  });
  return [...names].sort();
}

/**
 * Compare two `Uint8Array`s for byte equality. We don't reach for
 * `Buffer.equals` so the test works under both Node and Workers
 * test runners.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Test ────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetAdminPathGuardCacheForTests();
});

describe('adminPathGuard — 404 indistinguishability (Property 7)', () => {
  it('returns identical bytes, identical header set, and p95 latency delta ≤ 5ms across 500 reqs to a default bait path vs a random path', async () => {
    const app = buildApp(
      makeFakeDb({ state: 'initialized', adminPath: CONFIGURED_ADMIN_PATH }),
    );

    // ── Sanity: both scenarios genuinely produce the canonical 404
    //    envelope with status=404, no extra headers, etc. If this
    //    pre-flight diverges, the timing measurement that follows is
    //    measuring a different code path on each side and the bound
    //    becomes meaningless. Catch the divergence loudly first.
    const baitProbe = await app.request(DEFAULT_BAIT_PATH);
    const randomProbe = await app.request(RANDOM_UNKNOWN_PATH);
    expect(baitProbe.status).toBe(404);
    expect(randomProbe.status).toBe(404);

    const baitProbeBytes = await readBytes(baitProbe);
    const randomProbeBytes = await readBytes(randomProbe);
    expect(bytesEqual(baitProbeBytes, randomProbeBytes)).toBe(true);
    // The canonical envelope from the guard.
    expect(new TextDecoder().decode(baitProbeBytes)).toBe(
      JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }),
    );

    // Header-set parity (Req 5.6 / design §7.2: only Content-Type +
    // Content-Length).
    const baitHeaders = headerNameSet(baitProbe);
    const randomHeaders = headerNameSet(randomProbe);
    expect(baitHeaders).toEqual(randomHeaders);
    expect(baitHeaders).toEqual(['content-length', 'content-type']);
    expect(baitProbe.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(randomProbe.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(baitProbe.headers.get('content-length')).toBe(
      String(baitProbeBytes.byteLength),
    );
    expect(randomProbe.headers.get('content-length')).toBe(
      String(randomProbeBytes.byteLength),
    );

    // ── Warmup ──────────────────────────────────────────────────────
    // Touch both scenarios so the JIT specialises the request
    // pipeline for both inputs equally before any timed sample
    // lands.
    for (let i = 0; i < WARMUP; i++) {
      await app.request(DEFAULT_BAIT_PATH);
      await app.request(RANDOM_UNKNOWN_PATH);
    }

    // ── Timed loop ──────────────────────────────────────────────────
    // Pre-allocate so mid-run array resizing is not part of the
    // measurement.
    const baitLatencies: number[] = new Array(SAMPLES);
    const randomLatencies: number[] = new Array(SAMPLES);

    // Reference body to assert byte-equal against on every iteration.
    const referenceBytes = baitProbeBytes;

    for (let s = 0; s < SAMPLES; s++) {
      // Interleave order across iterations so any monotonic CPU /
      // event-loop drift over the run affects both scenarios
      // symmetrically.
      if ((s & 1) === 0) {
        const t0 = performance.now();
        const r = await app.request(DEFAULT_BAIT_PATH);
        baitLatencies[s] = performance.now() - t0;
        // Spot-check inside the loop too — if a bug only manifests
        // intermittently (e.g. a header that only shows up after
        // some interleaving), we want to fail the test on the very
        // request that diverges, not after aggregating 500 samples.
        const bytes = await readBytes(r);
        if (!bytesEqual(bytes, referenceBytes)) {
          expect.fail(
            `bait response bytes diverged at sample ${s}: ${new TextDecoder().decode(bytes)}`,
          );
        }
        const names = headerNameSet(r);
        if (
          names.length !== 2 ||
          names[0] !== 'content-length' ||
          names[1] !== 'content-type'
        ) {
          expect.fail(
            `bait response header set diverged at sample ${s}: ${names.join(', ')}`,
          );
        }

        const t1 = performance.now();
        const r2 = await app.request(RANDOM_UNKNOWN_PATH);
        randomLatencies[s] = performance.now() - t1;
        const bytes2 = await readBytes(r2);
        if (!bytesEqual(bytes2, referenceBytes)) {
          expect.fail(
            `random response bytes diverged at sample ${s}: ${new TextDecoder().decode(bytes2)}`,
          );
        }
        const names2 = headerNameSet(r2);
        if (
          names2.length !== 2 ||
          names2[0] !== 'content-length' ||
          names2[1] !== 'content-type'
        ) {
          expect.fail(
            `random response header set diverged at sample ${s}: ${names2.join(', ')}`,
          );
        }
      } else {
        const t0 = performance.now();
        const r = await app.request(RANDOM_UNKNOWN_PATH);
        randomLatencies[s] = performance.now() - t0;
        const bytes = await readBytes(r);
        if (!bytesEqual(bytes, referenceBytes)) {
          expect.fail(
            `random response bytes diverged at sample ${s}: ${new TextDecoder().decode(bytes)}`,
          );
        }

        const t1 = performance.now();
        const r2 = await app.request(DEFAULT_BAIT_PATH);
        baitLatencies[s] = performance.now() - t1;
        const bytes2 = await readBytes(r2);
        if (!bytesEqual(bytes2, referenceBytes)) {
          expect.fail(
            `bait response bytes diverged at sample ${s}: ${new TextDecoder().decode(bytes2)}`,
          );
        }
      }
    }

    const baitP95 = quantile(baitLatencies, 0.95);
    const randomP95 = quantile(randomLatencies, 0.95);
    const p95Delta = Math.abs(baitP95 - randomP95);

    // Surface the numbers in the test output for easier triage of
    // future flakes.
    // eslint-disable-next-line no-console
    console.info('[404-indistinguishable] bait   p95 (ms) =', baitP95);
    // eslint-disable-next-line no-console
    console.info('[404-indistinguishable] random p95 (ms) =', randomP95);
    // eslint-disable-next-line no-console
    console.info('[404-indistinguishable] |Δ p95| (ms)    =', p95Delta);

    expect(p95Delta).toBeLessThanOrEqual(P95_DELTA_BOUND_MS);
  });
});
