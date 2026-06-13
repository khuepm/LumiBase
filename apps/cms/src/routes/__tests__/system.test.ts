import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, Bindings } from '../../env';
import { resolveBuildMetadata, systemRouter } from '../system';

function buildApp(env: Partial<Bindings>) {
  const app = new Hono<AppEnv>();
  app.route('/api/v1/system', systemRouter);
  return app.request('/api/v1/system/version', undefined, env as Bindings);
}

describe('system version route', () => {
  it('returns build metadata from runtime bindings', async () => {
    const res = await buildApp({
      LUMIBASE_ENV: 'test',
      LUMIBASE_VERSION: '1.2.3',
      LUMIBASE_GIT_SHA: 'abc123def456',
      LUMIBASE_BUILD_TIME: '2026-06-06T00:00:00.000Z',
      LUMIBASE_RELEASE_CHANNEL: 'staging',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: '1.2.3',
      gitSha: 'abc123def456',
      buildTime: '2026-06-06T00:00:00.000Z',
      releaseChannel: 'staging',
    });
  });

  it('falls back to process env metadata when bindings are absent', () => {
    expect(
      resolveBuildMetadata(
        { LUMIBASE_ENV: 'test' },
        {
          LUMIBASE_VERSION: '4.5.6',
          LUMIBASE_GIT_SHA: 'def456abc123',
          LUMIBASE_BUILD_TIME: '2026-06-06T01:02:03.000Z',
          LUMIBASE_RELEASE_CHANNEL: 'production',
        },
      ),
    ).toEqual({
      version: '4.5.6',
      gitSha: 'def456abc123',
      buildTime: '2026-06-06T01:02:03.000Z',
      releaseChannel: 'production',
    });
  });

  it('normalizes missing or blank metadata values to unknown', () => {
    expect(
      resolveBuildMetadata(
        {
          LUMIBASE_ENV: 'test',
          LUMIBASE_VERSION: '',
          LUMIBASE_GIT_SHA: '   ',
        },
        {},
      ),
    ).toEqual({
      version: 'unknown',
      gitSha: 'unknown',
      buildTime: 'unknown',
      releaseChannel: 'unknown',
    });
  });
});
