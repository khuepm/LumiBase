import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@lumibase/database';

/**
 * Connection guard for the G1 `*.db.integration.test.ts` suites (#453).
 *
 * ## Why this exists
 *
 * The first version of these suites used the shape every other DB suite in the
 * repo had:
 *
 * ```ts
 * beforeAll(async () => { if (!URL) return; try { ... canConnect = true } catch { return } });
 * it('...', async () => { if (!canConnect) return; ... });
 * ```
 *
 * An early `return` makes a test **pass**. Measured on this branch with
 * `DATABASE_URL` unset: `Test Files 2 passed (2) · Tests 13 passed (13)`,
 * exit 0 — thirteen green DB tests that executed no assertion at all. Reporting
 * those as database evidence is exactly the failure #427 exists to stop.
 *
 * Two situations that look alike must therefore end differently:
 *
 * | Situation | Outcome | Why |
 * |---|---|---|
 * | `DATABASE_URL` absent | **skip** | Nobody asked for DB tests. |
 * | `DATABASE_URL` set but unreachable | **fail** | Someone asked and did not get them. |
 *
 * `describe.skipIf(!hasDbIntegrationUrl)` reports a real `skipped` in the
 * summary; an unreachable database throws out of `beforeAll` and fails loudly.
 *
 * ## Relationship to #462
 *
 * #462 introduces `src/__tests__/helpers/db-harness.ts` with this same contract
 * plus a source-scan tripwire, and its review asks these suites to adopt it.
 * That helper is not on `main` yet, so importing it here would not compile on
 * this branch. This module deliberately mirrors its contract instead;
 * when #462 lands, delete this file and re-point the two imports — the call
 * sites do not change.
 */

/** Whitespace-only is "not configured", not a URL that fails to connect. */
function resolveUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.DATABASE_URL;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Evaluated eagerly: `describe.skipIf(...)` runs at collection time. */
export const dbIntegrationUrl: string | undefined = resolveUrl();

/** Whether a database was requested at all. Drives `describe.skipIf`. */
export const hasDbIntegrationUrl: boolean = dbIntegrationUrl !== undefined;

/**
 * Strips credentials from a connection string so a failure can name the host
 * without leaking the password. An unparseable string yields no detail rather
 * than a partial leak.
 */
export function redactConnectionString(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<unparseable connection string>';
  }
  if (url.password) url.password = '***';
  const SECRET_PARAMS = /^(password|passwd|pwd|token|secret|key|sslpassword|apikey|api_key)$/i;
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, '***');
  }
  return url.toString();
}

/**
 * Masks userinfo inside any URL embedded in a driver message. Drivers are not
 * obliged to keep the DSN out of `error.message`, and some wrap the whole
 * connection target.
 */
export function redactSecretsInMessage(message: string): string {
  return message.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    (_full, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
}

/**
 * Opens the integration database, or throws.
 *
 * Only call from inside a `describe.skipIf(!hasDbIntegrationUrl)` block: at
 * that point a missing URL is a programming error, and an unreachable server
 * must fail the suite rather than quietly skip it.
 */
export async function connectDbIntegration(): Promise<Database> {
  if (!dbIntegrationUrl) {
    throw new Error(
      'connectDbIntegration called without DATABASE_URL — the suite should be guarded ' +
        'with describe.skipIf(!hasDbIntegrationUrl).',
    );
  }

  const db = createDb(dbIntegrationUrl);
  try {
    await db.execute(sql`SELECT 1`);
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? `${cause.name}: ${redactSecretsInMessage(cause.message)}`
        : redactSecretsInMessage(String(cause));
    // No `cause:` option — an unredacted driver error would travel with it and
    // vitest prints the whole chain.
    throw new Error(
      `DATABASE_URL is set but ${redactConnectionString(dbIntegrationUrl)} did not answer. ` +
        `Start a database or unset DATABASE_URL to skip these suites. ${detail}`,
    );
  }
  return db;
}
