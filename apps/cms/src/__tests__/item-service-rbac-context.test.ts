import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRequestPermissionContext } from '../services/item-service-factory';

/**
 * Regression guard for the AI/MCP item-RBAC bypass class of bug.
 *
 * ## Background
 *
 * `ItemService` enforces row/field RBAC only when it is constructed with a
 * `permissionCtx`; without one it fails *open* (every permission check
 * short-circuits to "allowed"). That is deliberate for system/background
 * flows, but it means any request-scoped call site that forgets `permissionCtx`
 * silently bypasses authorization. This exact bug shipped once (the AI
 * `updateItem` skill) and was found again in the MCP endpoint.
 *
 * The fix funnels construction through two explicit helpers in
 * `item-service-factory.ts`:
 *   - `itemServiceForRequest(c)` — always attaches a `permissionCtx`.
 *   - `itemServiceForSystem(deps, reason)` — forces a named justification.
 *
 * The source-scan test below is the enforcement mechanism: it fails CI if a
 * new `new ItemService(...)` appears anywhere outside the factory (or the
 * small, reviewed system allowlist), so the next author cannot re-introduce a
 * fail-open request path without a reviewer noticing.
 */

// ── 1. Source-scan guard ────────────────────────────────────────────────────

/**
 * Files permitted to call `new ItemService(...)` directly, each with the
 * reason it is safe. Adding a file here is a deliberate, reviewable act —
 * that is the point. Paths are POSIX-relative to `apps/cms/src`.
 */
const ALLOWED_DIRECT_CONSTRUCTION: Record<string, string> = {
  // The factory itself is the one place that constructs the service.
  'services/item-service-factory.ts': 'canonical construction site',
  // ItemService internally spins up a nested service for relation expansion.
  'services/item-service.ts': 'internal self-construction (relation expansion)',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    // Tests may construct ItemService freely with whatever context they need.
    if (/(?:\.test\.|\.spec\.)/.test(entry) || full.includes(`${sep}__tests__${sep}`)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

describe('ItemService RBAC construction guard (source scan)', () => {
  const srcRoot = resolve(__dirname, '..');
  const offenders: string[] = [];

  for (const file of listSourceFiles(srcRoot)) {
    const rel = relative(srcRoot, file).split(sep).join('/');
    if (rel in ALLOWED_DIRECT_CONSTRUCTION) continue;
    const source = readFileSync(file, 'utf8');
    if (/\bnew\s+ItemService\s*\(/.test(source)) {
      offenders.push(rel);
    }
  }

  it('no production file constructs ItemService outside the factory', () => {
    expect(
      offenders,
      `These files call \`new ItemService(...)\` directly. Build request-scoped ` +
        `services via \`itemServiceForRequest(c)\` (enforces RBAC) or system flows ` +
        `via \`itemServiceForSystem(deps, reason)\` (explicit fail-open). If a new ` +
        `direct construction is genuinely required, add it to ` +
        `ALLOWED_DIRECT_CONSTRUCTION with a justification.`,
    ).toEqual([]);
  });
});

// ── 2. Request permission context preserves the principal ────────────────────

describe('buildRequestPermissionContext', () => {
  it('preserves the authenticated principal for ItemService RBAC checks', () => {
    const ctx = buildRequestPermissionContext({
      auth: {
        userId: 'user-1',
        email: 'editor@example.com',
        roles: ['items:update'],
        apiKey: { id: 'key-1' },
        raw: { organizationId: 'org-1' },
      },
      siteId: 'site-1',
      headers: { 'user-agent': 'vitest', authorization: 'Bearer redacted' },
      ip: '203.0.113.10',
    });

    expect(ctx).toMatchObject({
      userId: 'user-1',
      siteId: 'site-1',
      roleId: null,
      ip: '203.0.113.10',
      headers: { 'user-agent': 'vitest', authorization: 'Bearer redacted' },
      apiKey: { id: 'key-1' },
      user: {
        id: 'user-1',
        email: 'editor@example.com',
        roles: ['items:update'],
        organizationId: 'org-1',
      },
    });
  });

  it('uses null-safe defaults without dropping the site-scoped permission context', () => {
    const ctx = buildRequestPermissionContext({
      auth: { roles: [], raw: {} },
      siteId: 'site-2',
      headers: {},
      ip: null,
    });

    expect(ctx).toEqual({
      userId: null,
      siteId: 'site-2',
      roleId: null,
      user: { id: null, email: null, roles: [] },
      ip: null,
      headers: {},
      apiKey: null,
    });
  });

  it('produces a null user when there is no principal (anonymous/public path)', () => {
    const ctx = buildRequestPermissionContext({
      auth: undefined,
      siteId: 'site-3',
      headers: {},
      ip: null,
    });

    expect(ctx.user).toBeNull();
    expect(ctx.siteId).toBe('site-3');
  });
});
