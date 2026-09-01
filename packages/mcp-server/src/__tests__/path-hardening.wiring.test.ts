import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

/**
 * Class-level tripwire for the MCP path-parameter traversal bug.
 *
 * ## Background
 *
 * Tool arguments are interpolated into REST paths (`/roles/${id}/policies`).
 * When a segment was accepted as a bare `z.string().min(1)`, a value containing
 * `..` or `/` re-pointed the request at a sibling endpoint — path traversal /
 * confused deputy. This shipped, was patched per-file, and then had to be
 * patched *again* for the settings key, where `encodeURIComponent` alone looked
 * sufficient but is not: it leaves `.` and `..` untouched.
 *
 * Closing the class needs BOTH halves, so both are asserted here:
 *   1. encoding — every dynamic path segment goes through `encodePathSegment`
 *      or `encodeMediaKey` (neutralizes `/`, `\`, spaces).
 *   2. validation — the segment's schema rejects `..` (encoding cannot, since
 *      `encodeURIComponent('..') === '..'`).
 *
 * The existing per-tool assertions in `tools.test.ts` only cover the handful of
 * tools that were touched by each fix. These two scans cover every tool that
 * exists now or is added later.
 */

// ── 1. Encoding: source scan over every tool module ─────────────────────────

/** Encoders that make a dynamic value safe to splice into a path segment. */
const APPROVED_PATH_ENCODERS = ['encodePathSegment', 'encodeMediaKey'];

/**
 * Opening of a path-segment interpolation: a `/` immediately followed by `${`.
 * Query-string values (`?a=${…}`) and pre-built suffixes (`${qs}`) are not
 * preceded by `/`, so they are out of scope by construction.
 */
const PATH_SEGMENT_INTERPOLATION = /\/\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)?/g;

function toolModulePaths(): string[] {
  const dir = resolve(__dirname, '../tools');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

describe('path-segment encoding (source scan)', () => {
  const offenders: string[] = [];

  for (const file of toolModulePaths()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const match of line.matchAll(PATH_SEGMENT_INTERPOLATION)) {
        const callee = match[1] ?? '';
        if (APPROVED_PATH_ENCODERS.includes(callee)) continue;
        offenders.push(`tools/${file.split('/').pop()}:${i + 1} → \${${callee}…}`);
      }
    });
  }

  it('every dynamic path segment is wrapped in an approved encoder', () => {
    expect(
      offenders,
      `These interpolations splice a value straight into a request path. Wrap ` +
        `each in \`encodePathSegment(...)\` (single opaque segment) or ` +
        `\`encodeMediaKey(...)\` (multi-segment storage key). Plain ` +
        `\`encodeURIComponent\` is NOT sufficient for a path segment: it leaves ` +
        `\`.\` and \`..\` intact.`,
    ).toEqual([]);
  });
});

// ── 2. Validation: behavioural scan over every registered tool ───────────────

const TRAVERSAL = '..';

/**
 * Sentinel used to discover whether an argument reaches the path at all.
 *
 * `..` cannot do this job. When a call site splices the value into a *larger*
 * segment — `/exports/report-${id}.json` — the `..` is swallowed by the
 * surrounding text (`report-...json`) and never appears as a segment of its
 * own. The field then looks path-free, is skipped, and never reaches the
 * assertion below — the exact shape the source scan above also misses, since
 * that interpolation is not preceded by `/`.
 *
 * Deliberately alphanumeric: `encodePathSegment` leaves it byte-identical, so
 * the probe detects the argument whether or not the call site encodes it.
 */
const REACH_PROBE = 'zqpathprobe';

/**
 * Path portion of a recorded URL. Query values are encoded by `buildQs` via
 * `URLSearchParams`, so an argument that only lands after `?` is out of scope.
 */
function pathPortion(url: string): string {
  return url.split('?')[0]!;
}

interface CapturedTool {
  config: { inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function harness() {
  const tools = new Map<string, CapturedTool>();
  const paths: string[] = [];
  const record = (path: string) => {
    paths.push(path);
    return Promise.resolve({ ok: true });
  };
  const client = {
    get: vi.fn(record),
    post: vi.fn(record),
    patch: vi.fn(record),
    put: vi.fn(record),
    delete: vi.fn(record),
    getText: vi.fn(record),
    getRootText: vi.fn(record),
    postRaw: vi.fn(record),
  };
  const server = {
    registerTool(name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) {
      tools.set(name, { config, handler });
    },
  };
  registerAllTools(server as never, client as unknown as LumiBaseClient);
  return { tools, paths };
}

/** Placeholder values that let a handler reach its client call without throwing. */
function baselineArgs(fields: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'confirm') args[field] = true;
    else if (['data', 'patch', 'input', 'body', 'query', 'config'].includes(field)) args[field] = {};
    else if (field === 'fields') args[field] = [];
    else args[field] = 'x';
  }
  return args;
}

/** True if the sentinel reached the path, however the call site spliced it. */
function reachesPath(path: string): boolean {
  return pathPortion(path).includes(REACH_PROBE);
}

describe('path-parameter validation (registry scan)', () => {
  const offenders: string[] = [];
  const guarded: string[] = [];

  const { tools } = harness();

  for (const [name, tool] of tools) {
    const schema = tool.config.inputSchema;
    if (!schema) continue;

    for (const field of Object.keys(schema)) {
      // Does this field reach the URL path at all? Probe with the sentinel, not
      // with `..`, so an argument spliced into a larger segment is still seen.
      const { tools: probeTools, paths } = harness();
      const probe = probeTools.get(name)!;
      const args = baselineArgs(Object.keys(schema));
      args[field] = REACH_PROBE;
      // `run()` swallows handler errors, so a bad probe simply records no path.
      void probe.handler(args);

      if (!paths.some(reachesPath)) continue;

      const label = `${name}.${field}`;
      guarded.push(label);
      if (schema[field]!.safeParse(TRAVERSAL).success) offenders.push(label);
    }
  }

  it('rejects `..` on every argument that reaches a path segment', () => {
    expect(
      offenders,
      `These tool arguments are interpolated into a request path but their ` +
        `schema accepts "..". Encoding cannot save them — ` +
        `encodeURIComponent("..") === "..". Declare them with ` +
        `\`idPathSegmentSchema\`, \`collectionNameSchema\`, \`fieldNameSchema\`, ` +
        `or \`mediaKeySchema\` from \`tools/path.ts\`.`,
    ).toEqual([]);
  });

  it('actually inspected the known path parameters (guard is not vacuous)', () => {
    // Falls over if a refactor stops the probe from reaching client calls,
    // which would let the assertion above pass while checking nothing.
    expect(guarded.length).toBeGreaterThan(40);
  });
});
