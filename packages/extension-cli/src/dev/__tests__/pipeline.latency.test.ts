import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverExtensionAt } from '@lumibase/extensions';
import { createExtensionBuilder } from '../builder';
import { startDevHub, type DevHub } from '../hub';
import { createDevPipeline, type DevPipeline } from '../pipeline';
import { generateSessionToken } from '../session';
import { openSse, type SseHandle } from './sse-client';

/**
 * Acceptance (#754): "edit → reflected in Studio < 2 s".
 *
 * Drives the REAL pipeline — fs watcher → incremental esbuild → hub SSE →
 * bundle fetch → module import — on a fixture UI extension, with a mock
 * browser standing in for Studio (fetch-based EventSource + data-URL import,
 * React supplied through the same `globalThis.__lumibaseShared` contract the
 * Studio dev client sets up). The clock starts at the file write and stops
 * when the mock browser renders the edited component.
 */

const BUDGET_MS = 2000;
/** Assert with headroom: the pipeline must finish in half the budget. */
const ASSERT_MS = BUDGET_MS / 2;

type JsxNode = { type: unknown; props: Record<string, unknown> };

const TOKEN = generateSessionToken();
let dir = '';
let hub: DevHub;
let pipeline: DevPipeline;
let sse: SseHandle;
const rendered: Array<{ text: string; at: number }> = [];

function writeComponent(label: string): void {
  writeFileSync(
    join(dir, 'src', 'index.tsx'),
    [
      "import { useState } from 'react';",
      "import { label } from './label';",
      'export default function Badge() {',
      '  const [n] = useState(1);',
      '  return <span data-n={n}>{label}</span>;',
      '}',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'src', 'label.ts'), `export const label = ${JSON.stringify(label)};\n`);
}

/** Mock Studio: import the bundle like `import(url)` and render it once. */
async function mockBrowserRender(url: string): Promise<string> {
  const res = await fetch(url, { headers: { origin: 'http://localhost:2026' } });
  const code = await res.text();
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
    default: () => JsxNode;
  };
  const node = mod.default();
  const children = node.props.children;
  return (Array.isArray(children) ? children : [children]).join('').trim();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lumibase-ext-fixture-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'lumibase-extension.json'),
    JSON.stringify({ name: 'fixture-badge', version: '0.0.1', type: 'display', entry: './src/index.tsx' }),
  );
  writeComponent('v0');

  // Studio publishes its React for UI extensions; the mock does the same.
  const jsx = (type: unknown, props: Record<string, unknown>): JsxNode => ({ type, props });
  (globalThis as Record<string, unknown>).__lumibaseShared = {
    react: { useState: <T,>(v: T) => [v, () => undefined] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  };

  const ext = await discoverExtensionAt(dir);
  if (!ext) throw new Error('fixture manifest not found');
  hub = await startDevHub({ token: TOKEN, port: 0 });
  const builder = await createExtensionBuilder({ entryPath: ext.entryPath, type: ext.type, cwd: dir });
  pipeline = createDevPipeline({
    name: ext.name,
    type: ext.type,
    capabilities: ext.manifest.capabilities,
    siteId: null,
    builder,
    hub,
  });
  await pipeline.build(); // initial (cold) build — not part of the edit loop
  pipeline.watch(dir);

  sse = openSse(
    `${hub.url}/events?token=${TOKEN}`,
    { headers: { origin: 'http://localhost:2026' } },
    (event, data) => {
      if (event !== 'reload') return;
      const { name, version } = data as { name: string; version: number };
      void mockBrowserRender(`${hub.url}/bundle/${name}?v=${version}&token=${TOKEN}`).then((text) =>
        rendered.push({ text, at: performance.now() }),
      );
    },
  );
  await sse.ready;
});

afterAll(async () => {
  sse?.close();
  await pipeline?.close();
  await hub?.close();
  delete (globalThis as Record<string, unknown>).__lumibaseShared;
  rmSync(dir, { recursive: true, force: true });
});

async function editAndMeasure(label: string): Promise<number> {
  const started = performance.now();
  writeComponent(label);
  for (;;) {
    const hit = rendered.find((r) => r.text.includes(label));
    if (hit) return hit.at - started;
    if (performance.now() - started > BUDGET_MS * 3) throw new Error(`edit "${label}" never reached the browser`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('lumibase-ext dev — edit → Studio latency', () => {
  it(`reflects each edit in the (mock) browser in < ${ASSERT_MS}ms (budget ${BUDGET_MS}ms)`, async () => {
    const samples: number[] = [];
    for (const label of ['edit-one', 'edit-two', 'edit-three']) {
      samples.push(await editAndMeasure(label));
    }
    // eslint-disable-next-line no-console
    console.info(`[hot-reload latency] ${samples.map((s) => `${s.toFixed(0)}ms`).join(', ')}`);
    for (const ms of samples) expect(ms).toBeLessThan(ASSERT_MS);
  });

  it('keeps the previous version when an edit does not compile, then recovers', async () => {
    const errors: string[] = [];
    const watcher = openSse(`${hub.url}/events?token=${TOKEN}`, {}, (event, data) => {
      if (event === 'build-error') errors.push((data as { message: string }).message);
    });
    await watcher.ready;
    const before = rendered.length;

    writeFileSync(join(dir, 'src', 'label.ts'), 'export const label = ;\n');
    await expect.poll(() => errors.length, { timeout: BUDGET_MS }).toBeGreaterThan(0);
    expect(rendered.length).toBe(before); // nothing new was pushed to the browser

    expect(await editAndMeasure('recovered')).toBeLessThan(ASSERT_MS);
    watcher.close();
  });

  it('keeps reloading a file after an atomic (write-then-rename) save', async () => {
    // vim, JetBrains "safe write", formatters and `sed -i` replace the file
    // instead of writing it in place. Edits made after that must still reload.
    const label = join(dir, 'src', 'label.ts');
    // The temp file lives OUTSIDE the watched tree, as editors that save via
    // the OS temp dir do: on Linux, Node's recursive fs.watch stopped seeing
    // every later change after such a rename.
    const tmp = join(mkdtempSync(join(tmpdir(), 'lumibase-ext-save-')), 'label.ts');
    writeFileSync(tmp, `export const label = ${JSON.stringify('atomic-save')};\n`);
    const started = performance.now();
    renameSync(tmp, label);
    await expect.poll(() => rendered.some((r) => r.text.includes('atomic-save')), { timeout: BUDGET_MS }).toBe(true);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);

    // Edit ONLY the replaced file: other files kept reporting, which hid the bug.
    for (const next of ['after-atomic-1', 'after-atomic-2']) {
      const t0 = performance.now();
      writeFileSync(label, `export const label = ${JSON.stringify(next)};\n`);
      await expect.poll(() => rendered.some((r) => r.text.includes(next)), { timeout: BUDGET_MS }).toBe(true);
      expect(performance.now() - t0).toBeLessThan(ASSERT_MS);
    }
  });

  it('picks up a file in a directory created after the watch started', async () => {
    mkdirSync(join(dir, 'src', 'parts'));
    writeFileSync(join(dir, 'src', 'parts', 'suffix.ts'), "export const suffix = '';\n");
    writeFileSync(join(dir, 'src', 'label.ts'), "import { suffix } from './parts/suffix';\nexport const label = 'nested' + suffix;\n");
    await expect.poll(() => rendered.some((r) => r.text.includes('nested')), { timeout: BUDGET_MS }).toBe(true);

    const started = performance.now();
    writeFileSync(join(dir, 'src', 'parts', 'suffix.ts'), "export const suffix = '-deep-edit';\n");
    await expect
      .poll(() => rendered.some((r) => r.text.includes('nested-deep-edit')), { timeout: BUDGET_MS * 3 })
      .toBe(true);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
