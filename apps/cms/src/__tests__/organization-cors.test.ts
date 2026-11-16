import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCacheProvider, type RuntimeContext } from '@lumibase/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import type { AppEnv } from '../env';
afterEach(() => setRuntimeFactory(null));
describe('organization mutations from Studio and bundled shell', () => {
  it.each(['tauri://localhost', 'https://studio.example.test'])(
    'allows confirmation headers from configured origin %s',
    async (origin) => {
      setRuntimeFactory(
        () =>
          ({ cache: new MemoryCacheProvider() }) as unknown as RuntimeContext,
      );
      const response = await app.request(
        '/api/v1/orgs/organization_a/sites/site_a',
        {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'DELETE',
            'Access-Control-Request-Headers':
              'authorization,content-type,x-confirm-delete,x-lumi-client',
          },
        },
        {
          LUMIBASE_RUNTIME: 'docker',
          CORS_ALLOWED_ORIGINS: origin,
        } as AppEnv['Bindings'],
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(
        response.headers.get('Access-Control-Allow-Methods')?.split(','),
      ).toContain('DELETE');
      const allowed = response.headers
        .get('Access-Control-Allow-Headers')!
        .toLowerCase()
        .split(',');
      expect(allowed).toContain('x-confirm-delete');
      expect(allowed).toContain('authorization');
    },
  );
});
