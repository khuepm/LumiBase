import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import { loginBaselines, type Database } from '@lumibase/database';

import {
  COUNTRIES_CAP,
  DEVICE_FINGERPRINT_LRU_CAP,
  HOUR_HISTOGRAM_LENGTH,
  bumpHistogramBucket,
  mergeCountry,
  mergeDevice,
  updateBaseline,
} from '../baseline-store';
import type { DeviceFingerprintEntry, LoginAttemptDraft } from '../types';

/**
 * A single lowercase hex digit — fast-check 4 dropped `fc.hexaString`, so hex
 * strings are now built from an explicit unit arbitrary.
 */
const hexDigit = fc.constantFrom(...'0123456789abcdef'.split(''));

/**
 * Unit tests for the baseline writer (admin-setup-wizard task 7.5;
 * Req 9.6, 10.5, 11.5, 11.6; design §3.5, §8.1, §8.2, §8.3).
 *
 * Two layers of testing:
 *
 *   1. **Pure merge helpers** — `mergeCountry`, `bumpHistogramBucket`,
 *      and `mergeDevice` capture the cap / dedup / LRU invariants
 *      the writer maintains on the row. Testing them in isolation
 *      keeps the assertions readable and lets fast-check explore the
 *      input space without spinning up a fake DB on every shrink.
 *
 *   2. **`updateBaseline` against a fake Drizzle** — the
 *      orchestration layer runs the SELECT/UPDATE pair through a
 *      stub that records the SQL fluent calls. The fake exposes
 *      enough surface (`insert`, `select`, `update`) to satisfy the
 *      writer's call pattern, captures the merged values handed to
 *      `.set(...)`, and lets us assert that the SELECT used
 *      `.for('update')` (the row-lock contract from design §8).
 *
 * The fake stays minimal — anything more complete would amount to
 * re-implementing Drizzle. The integration with a live transaction
 * is exercised at the LoginGuard level (task 8.1's tests).
 */

// ── Fake DB ────────────────────────────────────────────────────────────

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
  onConflictCalled: boolean;
}

interface SelectCall {
  table: unknown;
  forUpdateCalled: boolean;
  whereDescriptor: string;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
  whereDescriptor: string;
}

function describeWhere(predicate: unknown): string {
  // Best-effort string fingerprint of the where clause for assertion.
  // We don't need exact SQL — just enough to confirm we filtered by
  // userId. Walk the SQL chunk graph defensively (params live on
  // nested objects).
  if (!predicate || typeof predicate !== 'object') return String(predicate);
  const seen = new WeakSet<object>();
  const buf: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      buf.push(node);
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      buf.push(String(node));
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(predicate);
  return buf.join(' ');
}

interface FakeDbState {
  inserts: InsertCall[];
  selects: SelectCall[];
  updates: UpdateCall[];
  /** Rows the SELECT returns. Default empty → SELECT yields []. */
  selectResult: Array<Record<string, unknown>>;
}

function makeFakeDb(initial?: Record<string, unknown>): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    inserts: [],
    selects: [],
    updates: [],
    selectResult: initial ? [initial] : [],
  };

  const db = {
    insert(table: unknown) {
      const call: InsertCall = { table, values: {}, onConflictCalled: false };
      const chain = {
        values(values: Record<string, unknown>) {
          call.values = values;
          return this;
        },
        onConflictDoNothing() {
          call.onConflictCalled = true;
          state.inserts.push(call);
          // Drizzle returns a thenable from the fluent; emulate the
          // promise interface so `await db.insert(...).values(...)
          // .onConflictDoNothing()` resolves.
          return Promise.resolve();
        },
        // If the caller forgets onConflict, still record on then().
        then(resolve: (v: unknown) => unknown) {
          state.inserts.push(call);
          return Promise.resolve().then(resolve);
        },
      };
      return chain;
    },
    select(_columns?: unknown) {
      const call: SelectCall = {
        table: undefined,
        forUpdateCalled: false,
        whereDescriptor: '',
      };
      const chain = {
        from(table: unknown) {
          call.table = table;
          return this;
        },
        where(predicate: unknown) {
          call.whereDescriptor = describeWhere(predicate);
          return this;
        },
        limit(_n: number) {
          return this;
        },
        for(mode: string) {
          if (mode === 'update') call.forUpdateCalled = true;
          return this;
        },
        then(
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          state.selects.push(call);
          return Promise.resolve(state.selectResult).then(resolve, reject);
        },
      };
      return chain;
    },
    update(table: unknown) {
      const call: UpdateCall = { table, set: {}, whereDescriptor: '' };
      const chain = {
        set(values: Record<string, unknown>) {
          call.set = values;
          return this;
        },
        where(predicate: unknown) {
          call.whereDescriptor = describeWhere(predicate);
          state.updates.push(call);
          return Promise.resolve();
        },
      };
      return chain;
    },
  } as unknown as Database;

  return { db, state };
}

// ── helpers ────────────────────────────────────────────────────────────

function entry(fp: string, lastSeenAt = '2025-01-01T00:00:00.000Z'): DeviceFingerprintEntry {
  return { fp, lastSeenAt };
}

function utcAt(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
}

// ── mergeCountry — Req 9.6 ─────────────────────────────────────────────

describe('mergeCountry — Req 9.6 (cap 50, dedup, FIFO eviction)', () => {
  it('returns the list unchanged for empty / null country', () => {
    expect(mergeCountry(['US'], null)).toEqual(['US']);
    expect(mergeCountry(['US'], undefined)).toEqual(['US']);
    expect(mergeCountry(['US'], '')).toEqual(['US']);
    expect(mergeCountry(['US'], '   ')).toEqual(['US']);
  });

  it('appends a new country to the end', () => {
    expect(mergeCountry(['US'], 'VN')).toEqual(['US', 'VN']);
  });

  it('deduplicates a country already in the list (no reorder)', () => {
    expect(mergeCountry(['US', 'VN', 'JP'], 'VN')).toEqual(['US', 'VN', 'JP']);
  });

  it('uppercases input so case differences fold onto the same code', () => {
    expect(mergeCountry(['US'], 'vn')).toEqual(['US', 'VN']);
    expect(mergeCountry(['US', 'VN'], 'vn')).toEqual(['US', 'VN']);
  });

  it('caps at COUNTRIES_CAP, dropping the oldest entry at the front', () => {
    const seed = Array.from({ length: COUNTRIES_CAP }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26)),
    );
    expect(seed).toHaveLength(COUNTRIES_CAP);
    const result = mergeCountry(seed, 'ZZ');
    expect(result).toHaveLength(COUNTRIES_CAP);
    expect(result[0]).toBe(seed[1]); // the oldest was dropped
    expect(result[result.length - 1]).toBe('ZZ');
  });

  it('does not grow past the cap on duplicate input at full capacity', () => {
    const seed = Array.from({ length: COUNTRIES_CAP }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26)),
    );
    const result = mergeCountry(seed, seed[0]!); // dup
    expect(result).toEqual(seed);
    expect(result).toHaveLength(COUNTRIES_CAP);
  });

  // Property test: list size never exceeds COUNTRIES_CAP, all entries
  // are unique uppercased ISO-like strings.
  it('property: result length ≤ COUNTRIES_CAP and entries unique', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('US', 'VN', 'JP', 'GB', 'DE', 'FR', 'CN', 'IN'), {
          minLength: 0,
          maxLength: 100,
        }),
        fc.option(fc.constantFrom('US', 'VN', 'JP', 'GB', 'DE', 'FR', 'CN', 'IN', null)),
        (sequence, attempt) => {
          let acc: string[] = [];
          for (const c of sequence) {
            acc = mergeCountry(acc, c);
          }
          acc = mergeCountry(acc, attempt as string | null);
          expect(acc.length).toBeLessThanOrEqual(COUNTRIES_CAP);
          expect(new Set(acc).size).toBe(acc.length);
        },
      ),
    );
  });
});

// ── bumpHistogramBucket — Req 10.5 ─────────────────────────────────────

describe('bumpHistogramBucket — Req 10.5 (UTC hour increment)', () => {
  it('increments the bucket at now.getUTCHours()', () => {
    const seed = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
    seed[3] = 5;
    const next = bumpHistogramBucket(seed, utcAt(2025, 0, 1, 3));
    expect(next).toHaveLength(HOUR_HISTOGRAM_LENGTH);
    expect(next[3]).toBe(6);
    // No other bucket changed.
    for (let i = 0; i < HOUR_HISTOGRAM_LENGTH; i++) {
      if (i !== 3) expect(next[i]).toBe(0);
    }
  });

  it('preserves length 24 even when input is shorter', () => {
    const seed = [1, 2, 3]; // length 3
    const next = bumpHistogramBucket(seed, utcAt(2025, 0, 1, 5));
    expect(next).toHaveLength(HOUR_HISTOGRAM_LENGTH);
    expect(next[0]).toBe(1);
    expect(next[5]).toBe(1);
  });

  it('preserves length 24 even when input is longer', () => {
    const seed = new Array<number>(30).fill(7);
    const next = bumpHistogramBucket(seed, utcAt(2025, 0, 1, 0));
    expect(next).toHaveLength(HOUR_HISTOGRAM_LENGTH);
    expect(next[0]).toBe(8);
  });

  it('zeros invalid (non-finite, negative) entries on the way through', () => {
    const seed = [1, NaN, -3, 4];
    const next = bumpHistogramBucket(seed, utcAt(2025, 0, 1, 1));
    expect(next[0]).toBe(1);
    expect(next[1]).toBe(1); // started at 0 + 1
    expect(next[2]).toBe(0);
    expect(next[3]).toBe(4);
  });
});

// ── mergeDevice — Req 11.5, 11.6 ───────────────────────────────────────

describe('mergeDevice — Req 11.5, 11.6 (LRU cap 20, MRU at front)', () => {
  const NOW = new Date('2025-06-15T10:00:00.000Z');

  it('returns the list unchanged for empty / null fingerprint', () => {
    const seed = [entry('aaaa')];
    expect(mergeDevice(seed, null, NOW)).toEqual(seed);
    expect(mergeDevice(seed, undefined, NOW)).toEqual(seed);
    expect(mergeDevice(seed, '', NOW)).toEqual(seed);
    expect(mergeDevice(seed, '   ', NOW)).toEqual(seed);
  });

  it('prepends a brand-new fingerprint at the front', () => {
    const seed = [entry('aaaa', '2025-01-01T00:00:00.000Z')];
    const next = mergeDevice(seed, 'bbbb', NOW);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ fp: 'bbbb', lastSeenAt: NOW.toISOString() });
    expect(next[1]).toEqual(seed[0]);
  });

  it('moves an existing fingerprint to the front and refreshes lastSeenAt', () => {
    const seed = [
      entry('aaaa', '2025-01-01T00:00:00.000Z'),
      entry('bbbb', '2025-02-01T00:00:00.000Z'),
      entry('cccc', '2025-03-01T00:00:00.000Z'),
    ];
    const next = mergeDevice(seed, 'bbbb', NOW);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual({ fp: 'bbbb', lastSeenAt: NOW.toISOString() });
    // Other entries preserved in original order.
    expect(next[1]!.fp).toBe('aaaa');
    expect(next[2]!.fp).toBe('cccc');
  });

  it('caps at DEVICE_FINGERPRINT_LRU_CAP, dropping the oldest at the back', () => {
    const seed: DeviceFingerprintEntry[] = [];
    for (let i = 0; i < DEVICE_FINGERPRINT_LRU_CAP; i++) {
      // Older entries first — index 0 is MRU, index 19 is LRU.
      seed.push(entry(`f${i.toString(16).padStart(15, '0')}`,
        new Date(2025, 0, 1, 0, i).toISOString()));
    }
    const next = mergeDevice(seed, 'newfingerprint01', NOW);
    expect(next).toHaveLength(DEVICE_FINGERPRINT_LRU_CAP);
    expect(next[0]!.fp).toBe('newfingerprint01');
    // The previous LRU (last in the seed) was dropped.
    expect(next.find((e) => e.fp === seed[seed.length - 1]!.fp)).toBeUndefined();
    // Fingerprint at index 0 of the seed is still around (was MRU).
    expect(next.find((e) => e.fp === seed[0]!.fp)).toBeDefined();
  });

  it('does not grow past the cap on a move-to-front of an existing entry', () => {
    const seed: DeviceFingerprintEntry[] = [];
    for (let i = 0; i < DEVICE_FINGERPRINT_LRU_CAP; i++) {
      seed.push(entry(`f${i.toString(16).padStart(15, '0')}`,
        new Date(2025, 0, 1, 0, i).toISOString()));
    }
    // Move the LRU entry to the front; length must stay at cap.
    const lruFp = seed[seed.length - 1]!.fp;
    const next = mergeDevice(seed, lruFp, NOW);
    expect(next).toHaveLength(DEVICE_FINGERPRINT_LRU_CAP);
    expect(next[0]!.fp).toBe(lruFp);
    expect(next[0]!.lastSeenAt).toBe(NOW.toISOString());
  });

  // Property: result length ≤ cap; the input fingerprint (if non-empty)
  // sits at index 0 with the supplied lastSeenAt.
  it('property: cap holds and new fingerprint lands at MRU position', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: hexDigit, minLength: 16, maxLength: 16 }), {
          minLength: 0,
          maxLength: 30,
        }),
        fc.string({ unit: hexDigit, minLength: 16, maxLength: 16 }),
        (seedFps, newFp) => {
          const seed: DeviceFingerprintEntry[] = seedFps.map((fp, i) =>
            entry(fp, new Date(2024, 0, 1, 0, i).toISOString()),
          );
          const next = mergeDevice(seed, newFp, NOW);
          expect(next.length).toBeLessThanOrEqual(DEVICE_FINGERPRINT_LRU_CAP);
          // The new fp sits at index 0 unless it was an empty string
          // (excluded by the generator — minLength 16).
          expect(next[0]!.fp).toBe(newFp);
          expect(next[0]!.lastSeenAt).toBe(NOW.toISOString());
          // No duplicate fingerprints.
          const fps = next.map((e) => e.fp);
          expect(new Set(fps).size).toBe(fps.length);
        },
      ),
    );
  });
});

// ── updateBaseline — orchestration against a fake DB ───────────────────

describe('updateBaseline — orchestration', () => {
  const NOW = utcAt(2025, 5, 15, 14); // hour 14 UTC

  it('upserts the row, takes a row lock, then writes the merged values', async () => {
    const { db, state } = makeFakeDb({
      countries: ['US', 'VN'],
      hourHistogram: (() => {
        const h = new Array<number>(24).fill(0);
        h[14] = 3;
        h[2] = 1;
        return h;
      })(),
      deviceFingerprints: [entry('aaaa', '2025-01-01T00:00:00.000Z')],
      successfulLogins: 5,
    });

    const attempt: LoginAttemptDraft = {
      countryCode: 'JP',
      deviceFingerprint: 'bbbb',
    };

    await updateBaseline(db, 'usr_1', attempt, NOW);

    // ── 1. Upsert was issued first.
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(loginBaselines);
    expect(state.inserts[0]!.values).toEqual({ userId: 'usr_1' });
    expect(state.inserts[0]!.onConflictCalled).toBe(true);

    // ── 2. SELECT used FOR UPDATE.
    expect(state.selects).toHaveLength(1);
    expect(state.selects[0]!.forUpdateCalled).toBe(true);
    expect(state.selects[0]!.table).toBe(loginBaselines);

    // ── 3. UPDATE with merged values.
    expect(state.updates).toHaveLength(1);
    const set = state.updates[0]!.set;
    expect(set['successfulLogins']).toBe(6);
    expect(set['countries']).toEqual(['US', 'VN', 'JP']);
    const histogram = set['hourHistogram'] as number[];
    expect(histogram).toHaveLength(24);
    expect(histogram[14]).toBe(4);
    expect(histogram[2]).toBe(1);
    const devices = set['deviceFingerprints'] as DeviceFingerprintEntry[];
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({ fp: 'bbbb', lastSeenAt: NOW.toISOString() });
    expect(devices[1]!.fp).toBe('aaaa');
    expect(set['updatedAt']).toBe(NOW);
  });

  it('skips country and device updates when the attempt fields are empty', async () => {
    const { db, state } = makeFakeDb({
      countries: ['US'],
      hourHistogram: new Array<number>(24).fill(0),
      deviceFingerprints: [entry('aaaa')],
      successfulLogins: 7,
    });

    const attempt: LoginAttemptDraft = {
      countryCode: null, // GeoIP unavailable
      deviceFingerprint: '', // UA missing
    };

    await updateBaseline(db, 'usr_1', attempt, NOW);

    expect(state.updates).toHaveLength(1);
    const set = state.updates[0]!.set;
    // Country list unchanged.
    expect(set['countries']).toEqual(['US']);
    // Device LRU unchanged.
    const devices = set['deviceFingerprints'] as DeviceFingerprintEntry[];
    expect(devices).toHaveLength(1);
    expect(devices[0]!.fp).toBe('aaaa');
    // Histogram and counter still updated.
    expect(set['successfulLogins']).toBe(8);
    expect((set['hourHistogram'] as number[])[14]).toBe(1);
  });

  it('initialises a freshly inserted row with sensible defaults', async () => {
    // Simulate "no row found yet" — but the upsert in step 1
    // creates one. Our fake's selectResult is empty, which models
    // the rare race where another transaction deleted the row
    // between insert and select. updateBaseline should bail
    // gracefully without throwing.
    const { db, state } = makeFakeDb();

    const attempt: LoginAttemptDraft = {
      countryCode: 'US',
      deviceFingerprint: 'newfp0000000001',
    };

    await updateBaseline(db, 'usr_new', attempt, NOW);

    // Insert ran, select ran, update did *not* (no row to update).
    expect(state.inserts).toHaveLength(1);
    expect(state.selects).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
  });

  it('treats a missing existing row from defaults as fresh baseline (single login)', async () => {
    // Most realistic first-ever-login: the upsert created the row
    // with the schema defaults; the SELECT then returns those
    // defaults.
    const { db, state } = makeFakeDb({
      countries: [],
      hourHistogram: new Array<number>(24).fill(0),
      deviceFingerprints: [],
      successfulLogins: 0,
    });

    const attempt: LoginAttemptDraft = {
      countryCode: 'VN',
      deviceFingerprint: 'fp00000000000001',
    };

    await updateBaseline(db, 'usr_new', attempt, NOW);

    expect(state.updates).toHaveLength(1);
    const set = state.updates[0]!.set;
    expect(set['successfulLogins']).toBe(1);
    expect(set['countries']).toEqual(['VN']);
    expect((set['hourHistogram'] as number[])[14]).toBe(1);
    const devices = set['deviceFingerprints'] as DeviceFingerprintEntry[];
    expect(devices).toEqual([
      { fp: 'fp00000000000001', lastSeenAt: NOW.toISOString() },
    ]);
  });

  it('parses jsonb columns delivered as JSON strings (driver compat)', async () => {
    const { db, state } = makeFakeDb({
      countries: JSON.stringify(['US']),
      hourHistogram: JSON.stringify(new Array<number>(24).fill(0)),
      deviceFingerprints: JSON.stringify([
        { fp: 'aaaa', lastSeenAt: '2025-01-01T00:00:00.000Z' },
      ]),
      successfulLogins: 4,
    });

    await updateBaseline(
      db,
      'usr_x',
      { countryCode: 'JP', deviceFingerprint: 'bbbb' },
      NOW,
    );

    const set = state.updates[0]!.set;
    expect(set['countries']).toEqual(['US', 'JP']);
    expect(set['successfulLogins']).toBe(5);
    const devices = set['deviceFingerprints'] as DeviceFingerprintEntry[];
    expect(devices.map((d) => d.fp)).toEqual(['bbbb', 'aaaa']);
  });

  it('uses the supplied now for the histogram bucket', async () => {
    const { db, state } = makeFakeDb({
      countries: [],
      hourHistogram: new Array<number>(24).fill(0),
      deviceFingerprints: [],
      successfulLogins: 0,
    });

    // 23:00 UTC → bucket 23.
    const lateUtc = utcAt(2025, 5, 15, 23);
    await updateBaseline(db, 'usr_1', { countryCode: 'US' }, lateUtc);

    const set = state.updates[0]!.set;
    const histogram = set['hourHistogram'] as number[];
    expect(histogram[23]).toBe(1);
    expect(histogram[14]).toBe(0);
    expect(set['updatedAt']).toBe(lateUtc);
  });

  it('filters the SELECT and UPDATE by userId', async () => {
    const { db, state } = makeFakeDb({
      countries: [],
      hourHistogram: new Array<number>(24).fill(0),
      deviceFingerprints: [],
      successfulLogins: 0,
    });

    await updateBaseline(db, 'usr_filter', {}, NOW);

    // Both predicates should mention the user id; we don't depend on
    // exact SQL shape, just confirm the chunks reference the column.
    expect(state.selects[0]!.whereDescriptor).toContain('usr_filter');
    expect(state.updates[0]!.whereDescriptor).toContain('usr_filter');
    // Sanity: the underlying eq builder is the one we'd use directly.
    expect(typeof eq).toBe('function');
  });
});
