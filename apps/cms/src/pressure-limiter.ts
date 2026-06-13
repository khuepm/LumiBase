import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_MAX_EVENT_LOOP_DELAY_MS = 1_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export interface PressureLimiterConfig {
  enabled: boolean;
  sampleIntervalMs: number;
  maxEventLoopDelayMs: number | false;
  maxEventLoopUtilization: number | false;
  retryAfterSeconds: number;
  excludedPaths: readonly string[];
}

export interface PressureSample {
  overloaded: boolean;
  reason: 'event_loop_delay' | 'event_loop_utilization' | null;
  eventLoopDelayMs: number;
  eventLoopUtilization: number;
}

export interface PressureLimiter {
  handle(request: Request): Response | null;
  stop(): void;
  getSample(): PressureSample;
}

type EnvLike = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveNumber(
  value: string | undefined,
  fallback: number | false,
): number | false {
  if (value === undefined || value === '') return fallback;
  if (value.trim().toLowerCase() === 'false') return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseExcludedPaths(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '')
    return ['/health', '/metrics'];
  return value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

export function resolvePressureLimiterConfig(
  env: EnvLike,
): PressureLimiterConfig {
  return {
    enabled: parseBoolean(env.LUMIBASE_PRESSURE_LIMITER_ENABLED, true),
    sampleIntervalMs: parsePositiveInteger(
      env.LUMIBASE_PRESSURE_LIMITER_SAMPLE_INTERVAL,
      DEFAULT_SAMPLE_INTERVAL_MS,
    ),
    maxEventLoopDelayMs: parseOptionalPositiveNumber(
      env.LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY,
      DEFAULT_MAX_EVENT_LOOP_DELAY_MS,
    ),
    maxEventLoopUtilization: parseOptionalPositiveNumber(
      env.LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION,
      false,
    ),
    retryAfterSeconds: parsePositiveInteger(
      env.LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER,
      DEFAULT_RETRY_AFTER_SECONDS,
    ),
    excludedPaths: parseExcludedPaths(
      env.LUMIBASE_PRESSURE_LIMITER_EXCLUDED_PATHS,
    ),
  };
}

export function isPressureLimiterExcluded(
  pathname: string,
  excludedPaths: readonly string[],
): boolean {
  return excludedPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function buildPressureUnavailableResponse(
  config: PressureLimiterConfig,
  sample: PressureSample,
  requestId?: string | null,
): Response {
  const payload = {
    errors: [
      {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Lumibase API is temporarily unavailable because this instance is under pressure. Retry later.',
        details: {
          reason: sample.reason,
          eventLoopDelayMs: Math.round(sample.eventLoopDelayMs),
          eventLoopUtilization: Number(sample.eventLoopUtilization.toFixed(4)),
        },
      },
    ],
  };

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': String(config.retryAfterSeconds),
    'x-lumi-overload': sample.reason ?? 'unknown',
  });

  if (requestId) headers.set('x-request-id', requestId);

  return new Response(JSON.stringify(payload), {
    status: 503,
    headers,
  });
}

export function createPressureLimiter(env: EnvLike): PressureLimiter {
  const config = resolvePressureLimiterConfig(env);
  let sample: PressureSample = {
    overloaded: false,
    reason: null,
    eventLoopDelayMs: 0,
    eventLoopUtilization: 0,
  };

  if (
    !config.enabled ||
    (config.maxEventLoopDelayMs === false &&
      config.maxEventLoopUtilization === false)
  ) {
    return {
      handle: () => null,
      stop: () => undefined,
      getSample: () => sample,
    };
  }

  const delayHistogram = monitorEventLoopDelay({
    resolution: config.sampleIntervalMs,
  });
  delayHistogram.enable();
  let lastEventLoopUtilization = performance.eventLoopUtilization();

  const interval = setInterval(() => {
    const eventLoopDelayMs = delayHistogram.max / 1_000_000;
    const utilization = performance.eventLoopUtilization(
      lastEventLoopUtilization,
    );
    lastEventLoopUtilization = performance.eventLoopUtilization();
    delayHistogram.reset();

    const delayOverLimit =
      config.maxEventLoopDelayMs !== false &&
      eventLoopDelayMs > config.maxEventLoopDelayMs;
    const utilizationOverLimit =
      config.maxEventLoopUtilization !== false &&
      utilization.utilization > config.maxEventLoopUtilization;

    sample = {
      overloaded: delayOverLimit || utilizationOverLimit,
      reason: delayOverLimit
        ? 'event_loop_delay'
        : utilizationOverLimit
          ? 'event_loop_utilization'
          : null,
      eventLoopDelayMs,
      eventLoopUtilization: utilization.utilization,
    };
  }, config.sampleIntervalMs);
  interval.unref();

  return {
    handle(request: Request): Response | null {
      const pathname = new URL(request.url).pathname;
      if (
        !sample.overloaded ||
        isPressureLimiterExcluded(pathname, config.excludedPaths)
      ) {
        return null;
      }

      return buildPressureUnavailableResponse(
        config,
        sample,
        request.headers.get('x-request-id'),
      );
    },
    stop(): void {
      clearInterval(interval);
      delayHistogram.disable();
    },
    getSample: () => sample,
  };
}
