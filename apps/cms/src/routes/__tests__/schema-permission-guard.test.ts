import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the schema-admin authorization bypass class of bug.
 *
 * ## Background
 *
 * The schema-admin routers (`collections.ts`, `relations.ts`) enforce RBAC
 * **per handler**: every handler opens with
 * `const denied = await requireSchemaPermission(c, 'schema:<action>'); if (denied) return denied;`.
 * There is no router-level `.use()` guard, so authorization holds only as long
 * as each handler remembers to call it. A newly added handler that forgets the
 * call silently serves unauthenticated schema mutations — the same fail-open
 * shape that motivated PR #161 (missing tenant/admin enforcement) and PR #185
 * (missing ItemService permissionCtx).
 *
 * This test scans the source of both routers and fails CI if any route handler
 * body does not call `requireSchemaPermission`, so the next author cannot add a
 * schema route that skips the permission check without a reviewer noticing.
 *
 * If a genuinely public schema handler is ever needed, add its method+path to
 * PUBLIC_SCHEMA_HANDLERS with a justification — a deliberate, reviewable act.
 */

const ROUTERS = [
  { file: 'collections.ts', varName: 'collectionsRouter' },
  { file: 'relations.ts', varName: 'relationsRouter' },
] as const;

/** Handlers intentionally exempt from `requireSchemaPermission` (method + path). */
const PUBLIC_SCHEMA_HANDLERS = new Set<string>([
  // (none today — every schema-admin route requires an explicit schema:* action)
]);

interface Handler {
  key: string; // "METHOD path" for diagnostics
  body: string; // source from the handler opening to the next handler (or EOF)
}

/**
 * Split a router source file into per-handler slices. Each `router.<method>(`
 * call starts a handler; its body runs until the next handler call or EOF.
 * We only need a coarse slice — enough to check whether the guard call appears
 * before the handler's own logic.
 */
function extractHandlers(source: string, varName: string): Handler[] {
  const opener = new RegExp(
    `${varName}\\.(get|post|patch|put|delete)\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g',
  );
  const matches = [...source.matchAll(opener)];
  return matches.map((m, i) => {
    const start = m.index ?? 0;
    const next = matches[i + 1];
    const end = next ? (next.index ?? source.length) : source.length;
    const method = m[1] ?? '';
    const path = m[2] ?? '';
    return {
      key: `${method.toUpperCase()} ${path}`,
      body: source.slice(start, end),
    };
  });
}

describe('schema-admin permission guard (source scan)', () => {
  for (const { file, varName } of ROUTERS) {
    it(`every ${file} handler calls requireSchemaPermission`, () => {
      const path = resolve(__dirname, '..', file);
      const source = readFileSync(path, 'utf8');
      const handlers = extractHandlers(source, varName);

      // Sanity: the scan must actually find handlers, else the guard is a no-op.
      expect(handlers.length, `no route handlers found in ${file} — regex drift?`).toBeGreaterThan(0);

      const unguarded = handlers
        .filter((h) => !PUBLIC_SCHEMA_HANDLERS.has(h.key))
        .filter((h) => !/requireSchemaPermission\s*\(/.test(h.body))
        .map((h) => h.key);

      expect(
        unguarded,
        `These ${file} handlers do not call requireSchemaPermission and would ` +
          `serve schema operations without an RBAC check. Add ` +
          `\`const denied = await requireSchemaPermission(c, 'schema:<action>'); ` +
          `if (denied) return denied;\` at the top of each, or (if genuinely public) ` +
          `add the handler to PUBLIC_SCHEMA_HANDLERS with a justification.`,
      ).toEqual([]);
    });
  }
});
