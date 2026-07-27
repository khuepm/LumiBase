import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AISecureHarness } from '../services/ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Regression guard for the "harness built without the runtime KeyProvider"
 * class of bug — the deployment-skill sibling of the ItemService RBAC-context
 * class locked by `item-service-rbac-context.test.ts`.
 *
 * ## Background
 *
 * `AISecureHarness` builds its skill registry from whatever services the
 * caller passes. The deployment skills (`triggerDeployment`,
 * `listDeploymentTargets`, `listDeployments`, `getDeploymentStatus`) need
 * `db + siteId + keys`; with no `keys` their handler throws
 * `DEPLOYMENTS_NOT_CONFIGURED` at call time. Nothing at construction time
 * complains, so a call site that forgets `keys` looks correct and silently
 * disables a whole skill family — the same "forgot, not wrong" shape §2c/§6 of
 * the Definition of Done warn about.
 *
 * It shipped that way: every construction site (`routes/ai.ts`,
 * `routes/mcp.ts`, `services/agent-run-worker.ts`) omitted `keys`, so
 * deployment skills failed on the sync path, and `AgentRunWorkerDeps` did not
 * even carry a `KeyProvider` to pass on the queued path.
 *
 * The source scan below is the enforcement mechanism: any construction that
 * wires real services must also pass `keys`, so the next author cannot
 * re-introduce a silently degraded harness. The behavioural companion for the
 * queued path is
 * `apps/cms/src/services/__tests__/agent-run-worker-keys.test.ts`.
 */

// ── 1. Source-scan guard ────────────────────────────────────────────────────

/**
 * Service options whose presence means "this harness executes skills for real"
 * (mirrors the `hasService` check in the `AISecureHarness` constructor). A
 * construction with none of these is a registry-only harness — it can inspect
 * and validate skills but never runs a handler, so it needs no KeyProvider.
 */
const SERVICE_OPTIONS = [
  'schemaService',
  'itemService',
  'accessService',
  'intentService',
  'configService',
  'extensionsService',
];

/**
 * Construction sites allowed to wire services without `keys`, each with the
 * reason it is safe. Adding a file here is a deliberate, reviewable act —
 * that is the point. Paths are POSIX-relative to `apps/cms/src`.
 */
const ALLOWED_WITHOUT_KEYS: Record<string, string> = {};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    // Tests construct harnesses with whatever partial config they need.
    if (/(?:\.test\.|\.spec\.)/.test(entry) || full.includes(`${sep}__tests__${sep}`)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

/** Extracts each `new AISecureHarness(<args>)` argument text via brace balance. */
function harnessConstructions(source: string): string[] {
  const found: string[] = [];
  const needle = 'new AISecureHarness(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) return found;
    let depth = 0;
    let end = start + needle.length - 1;
    for (let i = end; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    found.push(source.slice(start + needle.length, end));
    from = end + 1;
  }
}

describe('AISecureHarness KeyProvider construction guard (source scan)', () => {
  const srcRoot = resolve(__dirname, '..');
  const offenders: string[] = [];
  let serviceWiringSites = 0;

  for (const file of listSourceFiles(srcRoot)) {
    const rel = relative(srcRoot, file).split(sep).join('/');
    for (const args of harnessConstructions(readFileSync(file, 'utf8'))) {
      const wiresServices = SERVICE_OPTIONS.some((opt) =>
        new RegExp(`\\b${opt}\\s*[,:}]`).test(args),
      );
      if (!wiresServices) continue;
      serviceWiringSites += 1;
      if (rel in ALLOWED_WITHOUT_KEYS) continue;
      if (!/\bkeys\s*[,:]/.test(args)) {
        offenders.push(rel);
      }
    }
  }

  it('every service-wiring construction passes a KeyProvider', () => {
    expect(
      offenders,
      `These files build an AISecureHarness with real services but no \`keys\`. ` +
        `The deployment skills (triggerDeployment / listDeploymentTargets / ` +
        `listDeployments / getDeploymentStatus) then fail at call time with ` +
        `DEPLOYMENTS_NOT_CONFIGURED. Pass the runtime KeyProvider — ` +
        `\`keys: c.get('runtime').keys\` on the request path, \`keys: deps.keys\` ` +
        `in a queue worker. If a construction genuinely must not decrypt ` +
        `provider secrets, add it to ALLOWED_WITHOUT_KEYS with a justification.`,
    ).toEqual([]);
  });

  it('the scan actually found the known construction sites (non-vacuous)', () => {
    // routes/ai.ts (chat + approval decision), routes/mcp.ts, agent-run-worker.
    expect(serviceWiringSites).toBeGreaterThanOrEqual(4);
  });
});

// ── 2. The registry really degrades without a KeyProvider ───────────────────

describe('deployment skills depend on the KeyProvider', () => {
  const DEPLOYMENT_SKILLS = [
    'listDeploymentTargets',
    'listDeployments',
    'getDeploymentStatus',
    'triggerDeployment',
  ];

  /** Enough of a harness to build the registry; no handler touches the db here. */
  function harness(keys?: object) {
    return new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      // Any service switches the constructor into "wire real skills" mode.
      schemaService: {} as never,
      ...(keys ? { keys: keys as never } : {}),
    });
  }

  it.each(DEPLOYMENT_SKILLS)('%s fails without a KeyProvider', async (skill) => {
    const result = await harness().runSkill(skill, {});
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain('DEPLOYMENTS_NOT_CONFIGURED');
  });

  it.each(DEPLOYMENT_SKILLS)('%s gets past the guard with a KeyProvider', async (skill) => {
    const result = await harness({
      getActiveKey: async () => ({ keyId: 'v0', key: '' }),
      getKey: async () => '',
      listKeys: async () => [],
    }).runSkill(skill, {});
    // The stub db makes these fail *later* (inside DeploymentService); what
    // matters is that the missing-provider guard no longer short-circuits.
    expect(result.success === false && result.error).not.toContain('DEPLOYMENTS_NOT_CONFIGURED');
  });
});
