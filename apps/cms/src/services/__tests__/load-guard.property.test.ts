import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  BackpressureController,
  LoadGuardService,
  WriteCoalescer,
  WriteRateLimiter,
  isWithinMaintenanceWindow,
} from '../load-guard-service';

/**
 * Feature: content-os, Property 9 and the load-guard invariants.
 *
 * - Property 9 (write coalescing): a run writing N times across collections
 *   flushes exactly one invalidation per distinct collection, and a second
 *   flush is empty.
 * - Write rate budget: a sliding 60s window never allows more than the
 *   limit, regardless of the request pattern.
 * - Backpressure: pausing is immediate on overload; resuming never happens
 *   before a full hold-down of continuous calm; human work is never paused.
 *
 * **Validates: Requirements 9.1, 9.3, 9.4, 9.5**
 */

const collectionArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

describe('Feature: content-os, Property 9: write coalescing', () => {
  it('flushes exactly the distinct collections written, then nothing', () => {
    fc.assert(
      fc.property(fc.array(collectionArb, { maxLength: 60 }), (writes) => {
        const coalescer = new WriteCoalescer();
        for (const collection of writes) {
          coalescer.record(collection);
        }
        const flushed = coalescer.flush();
        // Exactly one invalidation per distinct collection (N → 1).
        expect(new Set(flushed)).toEqual(new Set(writes));
        expect(flushed.length).toBe(new Set(writes).size);
        // The window is cleared — no double invalidation.
        expect(coalescer.flush()).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('record() reports first-write-per-collection exactly once', () => {
    fc.assert(
      fc.property(fc.array(collectionArb, { minLength: 1, maxLength: 40 }), (writes) => {
        const coalescer = new WriteCoalescer();
        const firsts = writes.filter((collection) => coalescer.record(collection)).length;
        expect(firsts).toBe(new Set(writes).size);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Feature: content-os, Req 9.3: sliding-window write budget', () => {
  it('never allows more than the limit within any 60s window', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 100 }),
        fc.integer({ min: 1, max: 10 }),
        (gaps, limit) => {
          const limiter = new WriteRateLimiter();
          let now = 1_000_000;
          const allowedTimestamps: number[] = [];
          for (const gap of gaps) {
            now += gap;
            if (limiter.tryConsume('site:intent', limit, now).allowed) {
              allowedTimestamps.push(now);
            }
          }
          // Sliding-window invariant: any 60s span holds at most `limit`.
          for (let i = 0; i < allowedTimestamps.length; i++) {
            const windowStart = allowedTimestamps[i]!;
            const inWindow = allowedTimestamps.filter(
              (t) => t >= windowStart && t < windowStart + 60_000,
            ).length;
            expect(inWindow).toBeLessThanOrEqual(limit);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('denials include a finite retryAfterMs and quota returns after the window', () => {
    const limiter = new WriteRateLimiter();
    const t0 = 1_000_000;
    expect(limiter.tryConsume('k', 1, t0).allowed).toBe(true);
    const denied = limiter.tryConsume('k', 1, t0 + 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(limiter.tryConsume('k', 1, t0 + 60_001).allowed).toBe(true);
  });
});

describe('Feature: content-os, Req 9.4/9.5: backpressure hold-down', () => {
  it('never resumes before a full hold-down of continuous calm', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            overloaded: fc.boolean(),
            gapMs: fc.integer({ min: 1, max: 30_000 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.integer({ min: 1_000, max: 120_000 }),
        (samples, holdDownMs) => {
          const controller = new BackpressureController({ holdDownMs });
          let now = 1_000_000;
          let lastOverloadAt = -Infinity;
          for (const sample of samples) {
            now += sample.gapMs;
            if (sample.overloaded) lastOverloadAt = now;
            controller.signal({ overloaded: sample.overloaded }, now);
            if (controller.isPaused()) {
              // Still paused — fine; check the resume invariant instead.
            } else if (lastOverloadAt !== -Infinity) {
              // Resumed: calm must have lasted at least holdDownMs.
              expect(now - lastOverloadAt).toBeGreaterThanOrEqual(holdDownMs);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('pauses immediately on overload and counts one activation per episode', () => {
    const controller = new BackpressureController({ holdDownMs: 10_000 });
    const t0 = 1_000_000;
    controller.signal({ overloaded: true }, t0);
    expect(controller.isPaused()).toBe(true);
    expect(controller.activationId).toBe(1);
    // Repeated overload within the same episode does not re-count.
    controller.signal({ overloaded: true }, t0 + 1_000);
    expect(controller.activationId).toBe(1);
    // Calm shorter than hold-down keeps it paused.
    controller.signal({ overloaded: false }, t0 + 2_000);
    controller.signal({ overloaded: false }, t0 + 5_000);
    expect(controller.isPaused()).toBe(true);
    // Full hold-down of calm resumes.
    controller.signal({ overloaded: false }, t0 + 12_001);
    expect(controller.isPaused()).toBe(false);
    // A new overload is a new activation.
    controller.signal({ overloaded: true }, t0 + 20_000);
    expect(controller.activationId).toBe(2);
  });

  it('pauses reconciler-origin work only; human work is never auto-paused', () => {
    const guard = new LoadGuardService({ holdDownMs: 10_000 });
    guard.signal({ overloaded: true });
    expect(guard.shouldPause('reconciler')).toBe(true);
    expect(guard.shouldPause('user')).toBe(false);
    expect(guard.shouldPause(undefined)).toBe(false);
    // Incident dedupe: once per (site, activation).
    expect(guard.markIncidentOnce('site_1')).toBe(true);
    expect(guard.markIncidentOnce('site_1')).toBe(false);
    expect(guard.markIncidentOnce('site_2')).toBe(true);
  });
});

describe('Feature: content-os, Req 9.2: maintenance window', () => {
  // 2026-06-15 is a Monday. 10:30 UTC.
  const mondayMorning = new Date('2026-06-15T10:30:00Z');

  it('null/empty window always allows', () => {
    expect(isWithinMaintenanceWindow(null, mondayMorning)).toBe(true);
    expect(isWithinMaintenanceWindow({ tz: 'UTC', windows: [] }, mondayMorning)).toBe(true);
  });

  it('matches inside and rejects outside a same-day window', () => {
    const window = { tz: 'UTC', windows: [{ dow: 1, start: '09:00', end: '12:00' }] };
    expect(isWithinMaintenanceWindow(window, mondayMorning)).toBe(true);
    expect(isWithinMaintenanceWindow(window, new Date('2026-06-15T13:00:00Z'))).toBe(false);
    // Same time, wrong day (Tuesday).
    expect(isWithinMaintenanceWindow(window, new Date('2026-06-16T10:30:00Z'))).toBe(false);
  });

  it('handles overnight windows spanning midnight', () => {
    const window = { tz: 'UTC', windows: [{ dow: 1, start: '22:00', end: '02:00' }] };
    expect(isWithinMaintenanceWindow(window, new Date('2026-06-15T23:00:00Z'))).toBe(true);
    // Tuesday 01:00 still belongs to Monday's overnight window.
    expect(isWithinMaintenanceWindow(window, new Date('2026-06-16T01:00:00Z'))).toBe(true);
    expect(isWithinMaintenanceWindow(window, new Date('2026-06-16T03:00:00Z'))).toBe(false);
  });

  it('respects the declared timezone', () => {
    // 10:30 UTC on Monday = 17:30 in Asia/Ho_Chi_Minh (UTC+7).
    const window = { tz: 'Asia/Ho_Chi_Minh', windows: [{ dow: 1, start: '17:00', end: '18:00' }] };
    expect(isWithinMaintenanceWindow(window, mondayMorning)).toBe(true);
    expect(isWithinMaintenanceWindow({ ...window, windows: [{ dow: 1, start: '10:00', end: '11:00' }] }, mondayMorning)).toBe(false);
  });

  it('fails open on an invalid timezone', () => {
    const window = { tz: 'Not/A_Zone', windows: [{ dow: 1, start: '09:00', end: '12:00' }] };
    expect(isWithinMaintenanceWindow(window, mondayMorning)).toBe(true);
  });
});
