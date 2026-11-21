import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCacheProvider, type RuntimeContext } from '@lumibase/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import type { AppEnv } from '../env';

/**
 * `/api/v1/system/upgrade` (#898) sits next to the PUBLIC `/api/v1/system`
 * router (version). It must reach the authenticated `api` chain — whose
 * tenant middleware answers first here — rather than 404 or the public
 * router, and must not shadow `/system/version`. Who may call it once
 * authenticated is covered by `modules/upgrade/__tests__/upgrade.db.integration.test.ts`.
 */
afterEach(() => setRuntimeFactory(null));

describe('system upgrade mount', () => {
  it('upgrade routes go through the authenticated api chain; the version stays public', async () => {
    setRuntimeFactory(() => ({ cache: new MemoryCacheProvider() }) as unknown as RuntimeContext);
    const env = { LUMIBASE_RUNTIME: 'docker', LUMIBASE_VERSION: '2.2.0' } as AppEnv['Bindings'];
    for (const [method, path] of [
      ['GET', '/api/v1/system/upgrade/preflight'],
      ['GET', '/api/v1/system/upgrade'],
      ['POST', '/api/v1/system/upgrade'],
    ] as const) {
      const res = await app.request(path, { method }, env);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('TENANT_REQUIRED');
    }
    const version = await app.request('/api/v1/system/version', {}, env);
    expect(version.status).toBe(200);
    expect(((await version.json()) as { version: string }).version).toBe('2.2.0');
  });
});
