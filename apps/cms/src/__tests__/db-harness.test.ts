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
});
