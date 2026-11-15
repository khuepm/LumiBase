#!/usr/bin/env tsx
/**
 * Request-path cost of the usage emitter seam (`withUsage()`).
 *
 *   pnpm -F @lumibase/cms exec tsx scripts/bench-usage-seam.ts
 *
 * In-process, no network and no database: what is measured is the middleware
 * itself, which is the only part on the request path. Three variants of one
 * small Hono app answering a JSON read:
 *
 *   baseline   — `withUsage()` not mounted
 *   default    — mounted, nothing registered (every stock install)
 *   registered — mounted, with an emitter that buffers in `emit` and does an
 *                async hand-off in `flush` (the shape of a queue-backed emitter)
 *
 * Variants are interleaved in rounds so drift (JIT, GC, thermal) hits all
 * three alike. Reported: p50 / p99 / mean per request, in microseconds, and the
 * difference to baseline. The drain (attribution, emit, flush) runs detached
 * and is excluded by construction — that is the property under test — but it
 * is awaited between rounds so it cannot pile up behind the measurement.
 */
import { Hono } from 'hono';
import type { UsageEmitter, UsageEvent } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../src/env';
import { withUsage } from '../src/middleware/usage';
import { registerPlatformSeams, resetPlatformSeamsForTests } from '../src/platform/registry';

const N = Number(process.env.BENCH_N ?? 20_000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 10);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5_000);

const runtime = {
  cache: {
    getEntry: async () => ({ state: 'hit', value: 'org_bench' }),
    get: async () => null,
    set: async () => undefined,
    setNegative: async () => undefined,
    delete: async () => undefined,
  },
} as unknown as RuntimeContext;

function build(mountUsage: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', runtime);
    c.set('requestId', 'req');
    await next();
  });
  if (mountUsage) app.use('*', withUsage());
  app.use('/api/v1/*', async (c, next) => {
    c.set('siteId', 'site_bench');
    c.set('db', {} as never);
    await next();
  });
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `item_${i}`, title: `Item ${i}`, status: 'published' }));
  app.get('/api/v1/items/posts', (c) => c.json({ data: rows, meta: { total: rows.length } }));
  return app;
}

let emitted = 0;
const pendingFlushes: Promise<void>[] = [];
class QueueLikeEmitter implements UsageEmitter<RuntimeContext> {
  private buffer: UsageEvent[] = [];
  emit(event: UsageEvent): void {
    this.buffer.push(event);
  }
  flush(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    const done = new Promise<void>((resolve) => setImmediate(() => { emitted += batch.length; resolve(); }));
    pendingFlushes.push(done);
    return done;
  }
}

async function measure(app: Hono<AppEnv>, n: number): Promise<number[]> {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const res = await app.request('/api/v1/items/posts');
    await res.arrayBuffer();
    out[i] = Number(process.hrtime.bigint() - t0) / 1_000; // µs
  }
  return out;
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
  return { p50: at(50), p99: at(99), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

async function main() {
  const variants = {
    baseline: { app: build(false), register: false, samples: [] as number[] },
    default: { app: build(true), register: false, samples: [] as number[] },
    registered: { app: build(true), register: true, samples: [] as number[] },
  };
  const arm = (register: boolean) => {
    resetPlatformSeamsForTests();
    if (register) registerPlatformSeams({ usage: new QueueLikeEmitter() });
  };

  for (const v of Object.values(variants)) {
    arm(v.register);
    await measure(v.app, WARMUP);
  }
  const perRound = Math.ceil(N / ROUNDS);
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of Object.values(variants)) {
      arm(v.register);
      v.samples.push(...await measure(v.app, perRound));
      await Promise.all(pendingFlushes.splice(0));
    }
  }

  const base = stats(variants.baseline.samples);
  console.log(`node ${process.version} — ${perRound * ROUNDS} requests per variant, ${ROUNDS} interleaved rounds`);
  console.log('variant     p50 µs   p99 µs   mean µs   Δp50 µs  Δmean µs');
  for (const [name, v] of Object.entries(variants)) {
    const s = stats(v.samples);
    console.log(
      `${name.padEnd(10)} ${s.p50.toFixed(1).padStart(7)}  ${s.p99.toFixed(1).padStart(7)}  ${s.mean.toFixed(1).padStart(8)}  ${(s.p50 - base.p50).toFixed(1).padStart(8)}  ${(s.mean - base.mean).toFixed(1).padStart(8)}`,
    );
  }
  console.log(`events handed to the emitter (registered variant, incl. warmup): ${emitted}`);
}

void main();
