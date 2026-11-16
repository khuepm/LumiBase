import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { STUB_MARKER } from './fixtures/stub-seams';

/**
 * Both runtimes can be wrapped by an entry that registers seams.
 *
 * Booting the real entries needs Postgres (and, for Workers, workerd), so this
 * proves composition the way the builds do: it bundles a wrapping entry for
 * each runtime with the flags the real builds use and checks what came out.
 * The fixtures are also type-checked with the app (`tsc` includes them).
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../../..');
const src = (rel: string) => resolve(appRoot, 'src', rel);
const read = (rel: string) => readFileSync(src(rel), 'utf8');

async function bundle(entry: string, options: Parameters<typeof build>[0]): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: 'silent',
    absWorkingDir: appRoot,
    ...options,
  });
  expect(result.errors).toEqual([]);
  return result.outputFiles![0]!.text;
}

describe('a wrapping entry composes with both runtimes', () => {
  it('Workers: bundles the handler, both Durable Objects and the registration', async () => {
    const out = await bundle(src('platform/__tests__/fixtures/composed-worker-entry.ts'), {
      // An approximation of wrangler's bundling, close enough to prove the
      // module graph composes: Node built-ins stay external (`nodejs_compat`),
      // as do the runtime's own modules, and the alias from wrangler.toml keeps
      // the Docker adapters out. The authoritative check is wrangler itself:
      // `wrangler deploy <this fixture> --dry-run`.
      platform: 'node',
      format: 'esm',
      conditions: ['workerd', 'worker'],
      external: ['cloudflare:*'],
      alias: { '@lumibase/runtime/docker': src('runtime-docker-unavailable.ts') },
    });

    expect(out).toContain(STUB_MARKER);
    expect(out).toMatch(/export\s*\{[^}]*\bSiteRoom\b[^}]*\}/);
    expect(out).toMatch(/export\s*\{[^}]*\bPageviewCounter\b[^}]*\}/);
    expect(out).toMatch(/export\s*\{[^}]*\bas default\b[^}]*\}/);
    // The Docker adapters must stay out of a wrapped Worker exactly as they
    // stay out of the stock one (scripts/check-worker-bundle.mjs).
    expect(out).not.toContain('Could not determine sql-loader directory path');
    expect(out).not.toContain('node_modules/bullmq');
    expect(out).not.toContain('node_modules/ioredis');
  }, 120_000);

  it('Node: bundles the start function and the registration, as build:node does', async () => {
    const out = await bundle(src('platform/__tests__/fixtures/composed-node-entry.ts'), {
      platform: 'node',
      format: 'cjs',
      external: ['pg-native', 'cloudflare:workers', 'node-cron'],
    });

    expect(out).toContain(STUB_MARKER);
    expect(out).toContain('startNodeServer');
  }, 120_000);
});

describe('the Node start function does not run on import', () => {
  it('serve.ts starts only while autostart is enabled', () => {
    const serve = read('serve.ts');
    expect(serve).toMatch(/if \(nodeAutostartEnabled\(\)\) \{\s*main\(\)\.catch/);
    // No second, unguarded start left behind.
    expect(serve.match(/\bmain\(\)/g)).toHaveLength(2); // the declaration and the guarded call
    expect(serve).toContain('export { main as startNodeServer }');
  });

  it('node.ts switches autostart off before it loads serve.ts, and imports it lazily', () => {
    const node = read('node.ts');
    expect(node).not.toMatch(/^import .* from '\.\/serve'/m);
    const off = node.indexOf('disableNodeAutostart();');
    const load = node.indexOf("await import('./serve')");
    expect(off).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(off);
  });

  it('importing the composable entry starts nothing', async () => {
    const autostart = await import('../../node-autostart');
    const entry = await import('../../node');
    expect(typeof entry.startNodeServer).toBe('function');
    // Importing alone neither loaded serve.ts nor flipped the switch.
    expect(autostart.nodeAutostartEnabled()).toBe(true);
  });
});
