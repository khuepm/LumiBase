import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../env';
import { withWorkerRuntimeDefault } from '../worker-runtime-default';

/**
 * Staging returned 500 on every request, `/health` included, from #460 on: its
 * wrangler env never set `LUMIBASE_RUNTIME`, so `withRuntime` fell back to the
 * Docker adapters that the Worker bundle aliases away, and the stub threw.
 */
describe('Worker runtime default', () => {
  it('fills LUMIBASE_RUNTIME=cloudflare when the env does not set it', () => {
    const env = { LUMIBASE_ENV: 'staging' } as unknown as Bindings;
    expect(withWorkerRuntimeDefault(env).LUMIBASE_RUNTIME).toBe('cloudflare');
    // Other bindings pass through untouched.
    expect(withWorkerRuntimeDefault(env).LUMIBASE_ENV).toBe('staging');
  });

  it('leaves an explicit value alone so a real misconfiguration still fails loudly', () => {
    const env = { LUMIBASE_RUNTIME: 'docker' } as unknown as Bindings;
    expect(withWorkerRuntimeDefault(env)).toBe(env);
  });

  it('every wrangler env declares the Cloudflare runtime explicitly', () => {
    const toml = readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8');
    const envVarBlocks = [...toml.matchAll(/^\[env\.(\w+)\.vars\]$([\s\S]*?)(?=^\[)/gm)];
    expect(envVarBlocks.map((m) => m[1]).sort()).toEqual(['demo', 'dev', 'production', 'staging']);
    for (const [, name, body] of envVarBlocks) {
      expect(body, `[env.${name}.vars]`).toMatch(/^LUMIBASE_RUNTIME = "cloudflare"$/m);
    }
  });
});
