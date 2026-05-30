import { describe, it, expect } from 'vitest';

import {
  DEVICE_BASELINE_MIN_SUCCESSFUL_LOGINS,
  FINGERPRINT_HEX_LENGTH,
  MAX_UA_LENGTH,
  createDeviceSubscore,
  fingerprint,
  normalizeUA,
} from '../device';
import type {
  DeviceBaselineSnapshot,
  DeviceFingerprintEntry,
  LoginAttemptDraft,
} from '../types';

/**
 * Unit tests for the device subscore (admin-setup-wizard task 7.4;
 * Req 11.1–11.6; design §8.3).
 *
 * The detector is exercised through {@link createDeviceSubscore} with
 * a stub `loadBaseline` so the tests never touch a real DB. Each
 * `describe` block targets one acceptance criterion from Req 11 so
 * the trace is easy to follow:
 *
 *   - 11.1 — fingerprint pipeline (normalize + sha256 + truncate).
 *   - 11.2 — fingerprint not in baseline ⇒ subscore = 1.
 *   - 11.3 — fingerprint in baseline ⇒ subscore = 0.
 *   - 11.4 — `successfulLogins < 3` ⇒ baseline warmup.
 *   - 11.5 — LRU cap is the writer's job; the reader must tolerate
 *            any list size — covered by feeding a 20-entry baseline.
 *   - 11.6 — baseline updates are out of scope here (handled by the
 *            baseline-store writer in task 7.5).
 *
 * The Database handle is irrelevant because `loadBaseline` is
 * stubbed; we cast `null` for clarity in the test body.
 */

const NULL_DB = null as unknown as Parameters<typeof createDeviceSubscore>[0];

const FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36';

function makeBaselineLoader(
  baselines: Record<string, DeviceBaselineSnapshot | null>,
): (userId: string) => Promise<DeviceBaselineSnapshot | null> {
  return async (userId) => baselines[userId] ?? null;
}

function entry(fp: string, isoLastSeen = '2025-01-01T00:00:00Z'): DeviceFingerprintEntry {
  return { fp, lastSeenAt: isoLastSeen };
}

// ── normalizeUA — pure pipeline (Req 11.1) ──────────────────────────────

describe('normalizeUA (Req 11.1; design §8.3)', () => {
  it('lowercases and trims whitespace runs', () => {
    expect(normalizeUA('  Mozilla/5.0   Linux  ')).toBe('mozilla/# linux');
  });

  it('replaces dotted version-digit groups with `#`', () => {
    expect(normalizeUA('Chrome/120.0.6099.71 Safari/537.36')).toBe(
      'chrome/# safari/#',
    );
  });

  it('keeps single-integer build IDs intact (no false-positive strip)', () => {
    // `Win64` and `x64` should pass through; only DOTTED groups collapse.
    expect(normalizeUA('Mozilla/5 (Windows NT 10; Win64; x64)')).toBe(
      'mozilla/5 (windows nt 10; win64; x64)',
    );
  });

  it('produces the same fingerprint across patch-level Chrome bumps', () => {
    const a = normalizeUA(
      'Mozilla/5.0 (Macintosh) Chrome/120.0.6099.71 Safari/537.36',
    );
    const b = normalizeUA(
      'Mozilla/5.0 (Macintosh) Chrome/120.0.6099.234 Safari/537.36',
    );
    expect(a).toBe(b);
  });

  it('caps the input at 1024 characters (defence against UA flood)', () => {
    const huge = 'a'.repeat(MAX_UA_LENGTH + 500);
    const result = normalizeUA(huge);
    expect(result.length).toBeLessThanOrEqual(MAX_UA_LENGTH);
    expect(result).toBe('a'.repeat(MAX_UA_LENGTH));
  });

  it('returns empty string for missing/empty/whitespace UA', () => {
    expect(normalizeUA(undefined)).toBe('');
    expect(normalizeUA(null)).toBe('');
    expect(normalizeUA('')).toBe('');
    expect(normalizeUA('   \t\n')).toBe('');
  });

  it('returns empty string for non-string input (defensive)', () => {
    expect(normalizeUA(123 as unknown as string)).toBe('');
    expect(normalizeUA({} as unknown as string)).toBe('');
  });
});

// ── fingerprint — SHA-256 truncation (Req 11.1) ─────────────────────────

describe('fingerprint (Req 11.1; design §8.3)', () => {
  it('returns 16 lowercase hex characters', async () => {
    const fp = await fingerprint(FIREFOX_UA, 'en-US,en;q=0.9');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toHaveLength(FINGERPRINT_HEX_LENGTH);
  });

  it('is deterministic for the same UA + Accept-Language pair', async () => {
    const a = await fingerprint(FIREFOX_UA, 'en-US,en;q=0.9');
    const b = await fingerprint(FIREFOX_UA, 'en-US,en;q=0.9');
    expect(a).toBe(b);
  });

  it('differs when only the UA changes', async () => {
    const a = await fingerprint(FIREFOX_UA, 'en-US,en;q=0.9');
    const b = await fingerprint(CHROME_UA, 'en-US,en;q=0.9');
    expect(a).not.toBe(b);
  });

  it('differs when only the Accept-Language changes', async () => {
    const a = await fingerprint(FIREFOX_UA, 'en-US,en;q=0.9');
    const b = await fingerprint(FIREFOX_UA, 'vi-VN,vi;q=0.9');
    expect(a).not.toBe(b);
  });

  it('treats Accept-Language case-insensitively (design §8.3 lowercasing)', async () => {
    const a = await fingerprint(FIREFOX_UA, 'EN-US,EN;q=0.9');
    const b = await fingerprint(FIREFOX_UA, 'en-us,en;q=0.9');
    expect(a).toBe(b);
  });

  it('is stable across Chrome patch-level bumps (version-digit strip)', async () => {
    const a = await fingerprint(
      'Mozilla/5.0 (Macintosh) Chrome/120.0.6099.71 Safari/537.36',
      'en',
    );
    const b = await fingerprint(
      'Mozilla/5.0 (Macintosh) Chrome/120.0.6099.234 Safari/537.36',
      'en',
    );
    expect(a).toBe(b);
  });

  it('returns empty string when UA is missing/empty', async () => {
    expect(await fingerprint(undefined, 'en')).toBe('');
    expect(await fingerprint(null, 'en')).toBe('');
    expect(await fingerprint('', 'en')).toBe('');
    expect(await fingerprint('   ', 'en')).toBe('');
  });

  it('tolerates missing Accept-Language', async () => {
    const fp = await fingerprint(FIREFOX_UA, undefined);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── deviceSubscore — missing UA (design §8.3) ───────────────────────────

describe('deviceSubscore — missing/empty UA (design §8.3)', () => {
  it('tags status unavailable, no warmup, value=0 for empty UA', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      // Even with rich baseline, empty UA short-circuits before the read.
      loadBaseline: makeBaselineLoader({
        u1: {
          deviceFingerprints: [entry('aaaaaaaaaaaaaaaa')],
          successfulLogins: 50,
        },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '', 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.deviceLookupStatus).toBe('unavailable');
    expect(attempt.deviceFingerprint).toBeNull();
  });

  it('tags status unavailable for null UA', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', null, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.deviceLookupStatus).toBe('unavailable');
    expect(attempt.deviceFingerprint).toBeNull();
  });

  it('tags status unavailable for whitespace-only UA', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '   \t\n  ', 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.deviceLookupStatus).toBe('unavailable');
  });
});

// ── deviceSubscore — warmup (Req 11.4) ──────────────────────────────────

describe('deviceSubscore — baseline warmup (Req 11.4)', () => {
  it('returns warmup=true when successfulLogins < 3, even on first device', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { deviceFingerprints: [], successfulLogins: 2 },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', FIREFOX_UA, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    expect(attempt.deviceLookupStatus).toBe('ok');
    expect(attempt.deviceFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns warmup=true when there is no baseline row yet', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('first-time', FIREFOX_UA, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    // Fingerprint still recorded so the writer can seed the LRU.
    expect(attempt.deviceFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it(`exits warmup at successfulLogins=${DEVICE_BASELINE_MIN_SUCCESSFUL_LOGINS}`, async () => {
    // Baseline has the same fingerprint we'd compute → known device.
    const fp = await fingerprint(FIREFOX_UA, 'en');
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { deviceFingerprints: [entry(fp)], successfulLogins: 3 },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', FIREFOX_UA, 'en', attempt);
    expect(result.baselineWarmup).toBe(false);
  });
});

// ── deviceSubscore — match check (Req 11.2 / 11.3) ──────────────────────

describe('deviceSubscore — match check (Req 11.2, 11.3)', () => {
  it('subscore=1 when the fingerprint is not in the baseline LRU', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          deviceFingerprints: [entry('1111111111111111')],
          successfulLogins: 10,
        },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', FIREFOX_UA, 'en', attempt);
    expect(result).toEqual({ value: 1, baselineWarmup: false });
    expect(attempt.deviceLookupStatus).toBe('ok');
    expect(attempt.deviceFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(attempt.deviceFingerprint).not.toBe('1111111111111111');
  });

  it('subscore=0 when the fingerprint is in the baseline LRU', async () => {
    const fp = await fingerprint(FIREFOX_UA, 'en');
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          deviceFingerprints: [entry('1111111111111111'), entry(fp)],
          successfulLogins: 10,
        },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', FIREFOX_UA, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.deviceFingerprint).toBe(fp);
  });

  it('tolerates a 20-entry LRU baseline (Req 11.5 read side)', async () => {
    const fp = await fingerprint(CHROME_UA, 'en');
    const lru: DeviceFingerprintEntry[] = [];
    for (let i = 0; i < 20; i++) {
      lru.push(entry(`f${i.toString(16).padStart(15, '0')}`));
    }
    lru[10] = entry(fp);
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { deviceFingerprints: lru, successfulLogins: 50 },
      }),
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', CHROME_UA, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
  });
});

// ── Defensive: baseline loader rejection ───────────────────────────────

describe('deviceSubscore — baseline loader rejection', () => {
  it('falls back to warmup when the baseline loader throws', async () => {
    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: async () => {
        throw new Error('db pool exhausted');
      },
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', FIREFOX_UA, 'en', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    // Fingerprint was still recorded before the baseline read.
    expect(attempt.deviceLookupStatus).toBe('ok');
    expect(attempt.deviceFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── Collision sanity (Req 11.1) ────────────────────────────────────────

describe('deviceSubscore — fingerprint distinctness', () => {
  it('different UAs produce different fingerprints under the same baseline', async () => {
    const fpFirefox = await fingerprint(FIREFOX_UA, 'en');
    const fpChrome = await fingerprint(CHROME_UA, 'en');
    expect(fpFirefox).not.toBe(fpChrome);

    const subscore = createDeviceSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: {
          deviceFingerprints: [entry(fpFirefox)],
          successfulLogins: 10,
        },
      }),
    });

    const a: LoginAttemptDraft = {};
    expect(await subscore('u1', FIREFOX_UA, 'en', a)).toEqual({
      value: 0,
      baselineWarmup: false,
    });

    const b: LoginAttemptDraft = {};
    expect(await subscore('u1', CHROME_UA, 'en', b)).toEqual({
      value: 1,
      baselineWarmup: false,
    });
  });
});
