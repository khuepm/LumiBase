import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  redactConnectionString,
  redactSecretsInMessage,
  resolveDbIntegrationUrl,
} from './helpers/db-harness';

/**
 * Behaviour of the DB integration harness itself (#427).
 *
 * The companion `db-integration-guard.wiring.test.ts` proves every suite *uses*
 * the harness; this file proves the harness does the right thing when used. The
 * two connection cases are exercised for real — a closed port and an absent
 * variable — rather than mocked, because "it looked like it worked" is the
 * failure this whole change exists to remove.
 *
 * `dbIntegrationUrl` is captured at module load (`describe.skipIf` needs a value
 * at collection time), so the connection cases re-import the module under a
 * stubbed environment instead of mutating a live binding.
 */

const UNREACHABLE = 'postgresql://lumibase:s3cr3t@127.0.0.1:9999/nonexistent';
/** Same unreachable target, credential in the query string instead of userinfo. */
const UNREACHABLE_QUERY = 'postgresql://127.0.0.1:9999/nonexistent?password=s3cr3t&sslmode=require';

/**
 * Load a fresh copy of the harness under a chosen `DATABASE_URL`.
 *
 * Assertions about the error type must use the returned module's
 * `DbIntegrationUnreachableError`, not a statically imported one:
 * `vi.resetModules()` produces a new module instance, so the two class objects
 * are different identities and `instanceof` across them is false.
 */
async function loadHarnessWith(databaseUrl: string | undefined) {
  vi.resetModules();
  if (databaseUrl === undefined) vi.stubEnv('DATABASE_URL', '');
  else vi.stubEnv('DATABASE_URL', databaseUrl);
  // `stubEnv('DATABASE_URL', '')` leaves an empty string, which
  // `resolveDbIntegrationUrl` treats as absent — the same thing an unset
  // variable means to these suites.
  return import('./helpers/db-harness');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('resolveDbIntegrationUrl', () => {
  it('reads DATABASE_URL when it holds a value', () => {
    expect(resolveDbIntegrationUrl({ DATABASE_URL: 'postgresql://h/db' })).toBe('postgresql://h/db');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveDbIntegrationUrl({ DATABASE_URL: '  postgresql://h/db\n' })).toBe(
      'postgresql://h/db',
    );
  });

  it('treats absent, empty and whitespace-only as "no database requested"', () => {
    // A blank value in a shell profile or CI matrix means "not configured".
    // Reading it as a URL would turn an intended skip into a confusing
    // connection failure.
    expect(resolveDbIntegrationUrl({})).toBeUndefined();
    expect(resolveDbIntegrationUrl({ DATABASE_URL: '' })).toBeUndefined();
    expect(resolveDbIntegrationUrl({ DATABASE_URL: '   ' })).toBeUndefined();
  });
});

describe('redactConnectionString', () => {
  it('masks the password but keeps host and database name', () => {
    // The host and database are the point of the diagnostic; the password is
    // what must never reach a log or a CI transcript.
    const out = redactConnectionString('postgresql://lumibase:s3cr3t@db.internal:5432/lumibase');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('db.internal:5432');
    expect(out).toContain('lumibase');
  });

  it('masks secret-looking query parameters', () => {
    const out = redactConnectionString('postgresql://h/db?sslmode=require&password=hunter2');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('sslmode=require');
  });

  it('reveals nothing at all when the string does not parse', () => {
    // Partial output from an unparseable string risks leaking the half that
    // holds the credential.
    expect(redactConnectionString('not a url')).toBe('<unparseable connection string>');
  });

  it('leaves a credential-free URL intact', () => {
    expect(redactConnectionString('postgresql://db.internal:5432/lumibase')).toContain(
      'db.internal:5432/lumibase',
    );
  });
});

describe('redactSecretsInMessage', () => {
  it('masks credentials embedded in driver error text', () => {
    // Drivers are not obliged to keep the DSN out of `error.message`.
    const out = redactSecretsInMessage(
      'connect ECONNREFUSED for postgresql://lumibase:s3cr3t@127.0.0.1:9999/db',
    );
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('lumibase:***@');
  });

  it('masks a credential carried in the DSN query string', () => {
    // A DSN can put the password in the query string, with no userinfo segment
    // for the first pattern to catch. Reviewed case: this string came back
    // completely unchanged.
    const out = redactSecretsInMessage('driver failed postgresql://h/db?password=s3cr3t');
    expect(out).not.toContain('s3cr3t');
    expect(out).toBe('driver failed postgresql://h/db?password=***');
  });

  it('masks every secret-looking parameter but keeps connection options', () => {
    const out = redactSecretsInMessage(
      'postgresql://h/db?sslmode=require&password=s3cr3t&token=tok123&application_name=cms',
    );
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('tok123');
    // Diagnosable, non-secret options must survive — that is the point of
    // printing the target at all.
    expect(out).toContain('sslmode=require');
    expect(out).toContain('application_name=cms');
  });

  it('passes through text with no credentials', () => {
    expect(redactSecretsInMessage('connect ECONNREFUSED 127.0.0.1:9999')).toBe(
      'connect ECONNREFUSED 127.0.0.1:9999',
    );
  });
});

describe('connectDbIntegration', () => {
  it('fails — not skips — when DATABASE_URL is set but the database does not answer', async () => {
    const harness = await loadHarnessWith(UNREACHABLE);
    expect(harness.hasDbIntegrationUrl).toBe(true);

    // The whole point: asking for DB tests and not getting them is an error.
    await expect(harness.connectDbIntegration('harness-self-test')).rejects.toThrow(
      harness.DbIntegrationUnreachableError,
    );
  });

  it('names the suite and target in the failure, without the password', async () => {
    const harness = await loadHarnessWith(UNREACHABLE);
    const error = await harness.connectDbIntegration('harness-self-test').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('harness-self-test');
    expect(message).toContain('127.0.0.1:9999');
    // A diagnostic that leaks the password is worse than no diagnostic.
    expect(message).not.toContain('s3cr3t');
    // Say what the runner should do about it.
    expect(message).toContain('unset DATABASE_URL');
  });

  it('reports no database requested when DATABASE_URL is absent', async () => {
    const harness = await loadHarnessWith(undefined);
    expect(harness.hasDbIntegrationUrl).toBe(false);

    // Suites never reach this — `describe.skipIf` gates them first — so this is
    // the diagnostic for a suite that forgot the gate. It still must not pass
    // quietly.
    await expect(harness.connectDbIntegration('harness-self-test')).rejects.toThrow(/skipIf/);
  });

  it('keeps the password out of the fully rendered error chain, not just .message', async () => {
    // Asserting on `.message` alone passed while the raw driver error still
    // travelled along as `{ cause }` — and every reporter that renders a chain
    // (util.inspect, vitest, log shippers) printed that nested error verbatim.
    const harness = await loadHarnessWith(UNREACHABLE);
    const error = await harness.connectDbIntegration('chain').catch((e: unknown) => e);

    const rendered = inspect(error, { depth: 10 });
    expect(rendered).not.toContain('s3cr3t');
    // Still diagnosable: host and port survive redaction.
    expect(rendered).toContain('127.0.0.1:9999');
    // The mechanism, asserted directly so re-attaching a cause fails here.
    expect((error as Error).cause).toBeUndefined();
  });

  it('keeps a query-string password out of the rendered chain too', async () => {
    const harness = await loadHarnessWith(UNREACHABLE_QUERY);
    const error = await harness.connectDbIntegration('chain-query').catch((e: unknown) => e);

    const rendered = inspect(error, { depth: 10 });
    expect(rendered).not.toContain('s3cr3t');
    expect(rendered).toContain('127.0.0.1:9999');
  });

  it('leaks nothing through JSON or String rendering either', async () => {
    // Two more ways a reporter can render an error. Neither must expose it.
    const harness = await loadHarnessWith(UNREACHABLE);
    const error = await harness.connectDbIntegration('chain-json').catch((e: unknown) => e);

    expect(String(error)).not.toContain('s3cr3t');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
      's3cr3t',
    );
  });
});
