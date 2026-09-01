import type { CacheEvent } from '@lumibase/runtime';
import {
  cacheNegativeHitsTotal,
  cacheNegativeWritesTotal,
  cacheOperationsTotal,
} from '../routes/metrics';

const HEALTH_WINDOW_MS = 60_000;
const DEGRADED_ERROR_RATE = 0.5;

interface WindowSample {
  readonly atMs: number;
  readonly isError: boolean;
}

const samples: WindowSample[] = [];
let connectivityProbeFailed = false;

function pruneSamples(nowMs: number): void {
  const cutoff = nowMs - HEALTH_WINDOW_MS;
  while (samples.length > 0 && samples[0]!.atMs < cutoff) {
    samples.shift();
  }
}

export function resetCacheObservabilityForTests(): void {
  samples.length = 0;
  connectivityProbeFailed = false;
}

export function recordCacheOperationEvent(event: CacheEvent): void {
  cacheOperationsTotal.inc({
    op: event.op,
    result: event.result,
    backend: event.backend,
  });

  if (event.op === 'getEntry' && event.result === 'negative') {
    cacheNegativeHitsTotal.inc();
  }
  if (event.op === 'setNegative' && event.result === 'ok') {
    cacheNegativeWritesTotal.inc();
  }

  const isError = event.result === 'error' || event.result === 'unavailable';
  samples.push({ atMs: Date.now(), isError });
  pruneSamples(Date.now());
}

export function markCacheConnectivityProbeFailed(): void {
  connectivityProbeFailed = true;
}

export function markCacheConnectivityProbeSucceeded(): void {
  connectivityProbeFailed = false;
}

export type CacheOperationalStatus = 'ok' | 'degraded' | 'down';

/**
 * Operational cache health from the last 60s of `onEvent` samples.
 * Connectivity probe failure maps to `down`.
 */
export function getCacheOperationalStatus(nowMs: number = Date.now()): CacheOperationalStatus {
  if (connectivityProbeFailed) {
    return 'down';
  }

  pruneSamples(nowMs);
  if (samples.length === 0) {
    return 'ok';
  }

  const errors = samples.filter((s) => s.isError).length;
  const errorRate = errors / samples.length;
  return errorRate > DEGRADED_ERROR_RATE ? 'degraded' : 'ok';
}

export function getCacheErrorRate(nowMs: number = Date.now()): number {
  pruneSamples(nowMs);
  if (samples.length === 0) return 0;
  return samples.filter((s) => s.isError).length / samples.length;
}
