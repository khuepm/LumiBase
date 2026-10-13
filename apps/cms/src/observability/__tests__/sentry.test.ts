import { describe, expect, it } from 'vitest';
import type { Bindings } from '../../env';
import { resolveSentryOptions } from '../sentry';

describe('resolveSentryOptions', () => {
  it('keeps sensitive data collection disabled when upgrading the SDK', () => {
    const options = resolveSentryOptions({} as Bindings);
    expect(options).not.toHaveProperty('enableLogs');
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    });
    const filter = { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] };
    expect(options.dataCollection.httpHeaders).toEqual({ request: filter, response: filter });
    expect(options.dataCollection.urlQueryParams).toEqual(filter);
  });

  it('resolves per-environment identity and clamps sampling', () => {
    expect(resolveSentryOptions({
      SENTRY_DSN: 'https://public@example.com/1',
      SENTRY_TRACES_SAMPLE_RATE: '2',
      LUMIBASE_ENV: 'production',
      LUMIBASE_VERSION: '1.0.0-rc.4',
    } as Bindings)).toMatchObject({
      dsn: 'https://public@example.com/1',
      tracesSampleRate: 1,
      environment: 'production',
      release: '1.0.0-rc.4',
    });
    expect(resolveSentryOptions({ SENTRY_TRACES_SAMPLE_RATE: '-1' } as Bindings).tracesSampleRate).toBe(0);
    expect(resolveSentryOptions({ SENTRY_TRACES_SAMPLE_RATE: 'invalid' } as Bindings).tracesSampleRate).toBe(1);
    expect(resolveSentryOptions({ LUMIBASE_VERSION: 'unknown' } as Bindings).release).toBeUndefined();
  });
});
