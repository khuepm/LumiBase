import { describe, expect, it } from 'vitest';
import {
  buildPressureUnavailableResponse,
  isPressureLimiterExcluded,
  resolvePressureLimiterConfig,
  type PressureSample,
} from '../pressure-limiter';

describe('pressure limiter', () => {
  it('uses production-safe defaults with delay checks and health/metrics exclusions', () => {
    const config = resolvePressureLimiterConfig({});

    expect(config).toMatchObject({
      enabled: true,
      sampleIntervalMs: 250,
      maxEventLoopDelayMs: 1000,
      maxEventLoopUtilization: false,
      retryAfterSeconds: 5,
      excludedPaths: ['/health', '/metrics'],
    });
  });

  it('parses explicit false threshold toggles', () => {
    const config = resolvePressureLimiterConfig({
      LUMIBASE_PRESSURE_LIMITER_ENABLED: 'false',
      LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY: 'false',
      LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION: '0.99',
      LUMIBASE_PRESSURE_LIMITER_EXCLUDED_PATHS: '/healthz,/metrics',
    });

    expect(config.enabled).toBe(false);
    expect(config.maxEventLoopDelayMs).toBe(false);
    expect(config.maxEventLoopUtilization).toBe(0.99);
    expect(config.excludedPaths).toEqual(['/healthz', '/metrics']);
  });

  it('matches excluded paths and their children', () => {
    expect(isPressureLimiterExcluded('/health', ['/health'])).toBe(true);
    expect(isPressureLimiterExcluded('/health/deep', ['/health'])).toBe(true);
    expect(isPressureLimiterExcluded('/api/v1/items', ['/health'])).toBe(false);
  });

  it('builds a retryable 503 error envelope', async () => {
    const config = resolvePressureLimiterConfig({
      LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER: '7',
    });
    const sample: PressureSample = {
      overloaded: true,
      reason: 'event_loop_delay',
      eventLoopDelayMs: 1234.56,
      eventLoopUtilization: 0.42,
    };

    const response = buildPressureUnavailableResponse(
      config,
      sample,
      'req_123',
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('x-request-id')).toBe('req_123');
    expect(response.headers.get('x-lumi-overload')).toBe('event_loop_delay');
    expect(body).toEqual({
      errors: [
        {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Lumibase API is temporarily unavailable because this instance is under pressure. Retry later.',
          details: {
            reason: 'event_loop_delay',
            eventLoopDelayMs: 1235,
            eventLoopUtilization: 0.42,
          },
        },
      ],
    });
  });
});
