/**
 * Shared harness for the `*.db.integration.test.ts` suites.
 *
 * ## Why this exists
 *
 * Every DB integration suite used to open with the same shape:
 *
 * ```ts
 * beforeAll(async () => {
 *   if (!TEST_DATABASE_URL) { console.warn('Skipping: DATABASE_URL not set.'); return; }
 *   try { db = createDb(TEST_DATABASE_URL); await db.execute(sql`SELECT 1`); canConnect = true; }
 *   catch { console.warn('Skipping: database not reachable.'); }
 * });
 *
 * it('...', async () => {
 *   if (!canConnect) return;   // <- an early return is a PASS, not a skip
 *   ...
 * });
 * ```
 *
 * An early `return` makes the test **pass**, so a run against a dead database
 * was indistinguishable from a real one — same `passed` counts, same exit 0, no
 * `skipped` line anywhere. Measured on 20 suites pointed at a closed port:
 * `Test Files 20 passed (20) · Tests 76 passed (76) · exit=0`.
 *
 * That is not hypothetical: it produced three consecutive "3/3 pass" runs while
 * the session's Postgres was down during #401/#425, and every conclusion drawn
 * from those runs had to be redone. See issue #427.
 *
 * ## The distinction this harness draws
 *
 * The two situations differ in *intent*, so they must differ in outcome:
 *
 * | Situation | Outcome | Why |
 * |---|---|---|
 * | `DATABASE_URL` absent | **skip** | The runner did not ask for DB tests. |
 * | `DATABASE_URL` present but unreachable | **fail** | The runner asked for DB tests and did not get them. |
 *
 * Skipping is expressed with `describe.skipIf(!hasDbIntegrationUrl)` so vitest
 * reports it as `skipped` in the summary rather than as passing assertions.
 * Unreachability throws out of `beforeAll`, which fails the suite loudly.
 *
 * ## Usage
 *
 * ```ts
 * import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
 *
 * describe.skipIf(!hasDbIntegrationUrl)('MyService — DB integration', () => {
 *   let db: Database;
 *
 *   beforeAll(async () => {
 *     db = await connectDbIntegration('my-service');
 *   });
 *
 *   afterAll(async () => {
 *     if (!db) return;   // beforeAll may have thrown
 *     ...cleanup
 *   });
 *
 *   it('does the thing', async () => {
 *     // no connection guard: reaching here means the database answered
 *   });
 * });
 * ```
 *
 * A source-scan tripwire (`db-integration-guard.wiring.test.ts`) keeps the old
 * shape from coming back.
 */

import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@lumibase/database';

/**
 * Resolve the integration database URL from an environment bag.
 *
 * Pure and explicit so the precedence is testable without mutating
 * `process.env`. Whitespace-only is treated as absent: `DATABASE_URL=""` in a
 * shell profile or a CI matrix means "not configured", and reading it as a real
 * URL would turn a skip into a confusing connection failure.
 */
export function resolveDbIntegrationUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.DATABASE_URL;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The URL these suites should use, resolved once at module load.
 *
 * Evaluated eagerly because `describe.skipIf(...)` runs at collection time.
 */
export const dbIntegrationUrl: string | undefined = resolveDbIntegrationUrl();

/** Whether a database was requested at all. Drives `describe.skipIf`. */
export const hasDbIntegrationUrl: boolean = dbIntegrationUrl !== undefined;

/**
 * Strip credentials out of a connection string so it can appear in a failure
 * message.
 *
 * A diagnostic has to name the host and database — that is the whole point of
 * printing it — but it must never carry the password. Host and database name
 * are kept; userinfo password and secret-looking query parameters are masked.
 * An unparseable string yields no detail at all rather than a partial leak.
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
 * Redact anything that looks like a connection string inside an arbitrary
 * message.
 *
 * Driver errors are not required to keep the DSN out of `error.message`, and
 * some wrap the whole connection target. Masking the userinfo segment of any
 * embedded URL is cheaper than auditing every driver's error shapes.
 */
export function redactSecretsInMessage(message: string): string {
  return message.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    (_full, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const codePart = typeof code === 'string' && code.length > 0 ? ` [${code}]` : '';
    return `${cause.name}${codePart}: ${redactSecretsInMessage(cause.message)}`;
  }
  return redactSecretsInMessage(String(cause));
}

/**
 * Thrown when `DATABASE_URL` is configured but the database does not answer.
 *
 * A distinct type so the tripwire and the harness's own tests can assert on the
 * failure mode rather than on message text.
 */
export class DbIntegrationUnreachableError extends Error {
  constructor(
    readonly label: string,
    readonly target: string,
    cause: unknown,
  ) {
    super(
      `DB integration suite "${label}" could not reach the database.\n` +
        `  DATABASE_URL is set, so these tests were requested and did NOT run.\n` +
        `  target: ${target}\n` +
        `  cause:  ${describeCause(cause)}\n` +
        `  Start a database and re-run, or unset DATABASE_URL to skip DB suites.`,
      { cause },
    );
    this.name = 'DbIntegrationUnreachableError';
  }
}

/**
 * Connect for a DB integration suite, or throw.
 *
 * Never returns a half-usable handle: callers can treat a returned `Database`
 * as proof the server answered `SELECT 1`.
 *
 * @param label short suite name used in diagnostics, e.g. `'crypto'`
 */
export async function connectDbIntegration(label: string): Promise<Database> {
  if (dbIntegrationUrl === undefined) {
    // Unreachable through the documented usage: `describe.skipIf` gates the
    // suite before any hook runs. Reaching here means a suite forgot the gate,
    // and failing is the correct response — silently passing is the bug this
    // module exists to remove.
    throw new Error(
      `DB integration suite "${label}" ran without DATABASE_URL.\n` +
        '  Gate the suite with describe.skipIf(!hasDbIntegrationUrl) so it reports as skipped.',
    );
  }

  const target = redactConnectionString(dbIntegrationUrl);
  const db = createDb(dbIntegrationUrl);

  try {
    await db.execute(sql`SELECT 1`);
  } catch (cause) {
    throw new DbIntegrationUnreachableError(label, target, cause);
  }

  return db;
}
