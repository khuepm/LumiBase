import { describe, expect, it } from 'vitest';
import { redactText, rootSqlState, sanitizeError } from '../sanitize';

/** Shape of drizzle-orm 0.45 `DrizzleQueryError` wrapping a postgres.js error. */
function drizzleError(query: string, params: unknown[], cause: Record<string, unknown>) {
  const err = new Error(`Failed query: ${query}\nparams: ${params.join(',')}`) as Error & Record<string, unknown>;
  err.name = 'DrizzleQueryError';
  err.query = query;
  err.params = params;
  err.cause = Object.assign(new Error(cause.message as string), cause);
  return err;
}

describe('sanitizeError', () => {
  it('keeps the SQL and the SQLSTATE from the cause, drops params', () => {
    const err = drizzleError(
      'select "id", "organization_id" from "lumibase_sites" where "id" = $1 limit $2',
      ['secret-site-id', 1],
      { name: 'PostgresError', message: 'column "organization_id" does not exist', code: '42703', routine: 'errorMissingColumn' },
    );
    const out = sanitizeError(err);
    expect(out.message).toBe('Failed query');
    expect(out.query).toContain('"organization_id"');
    expect(JSON.stringify(out)).not.toContain('secret-site-id');
    expect(out.cause).toMatchObject({ code: '42703', routine: 'errorMissingColumn' });
    expect(rootSqlState(out)).toBe('42703');
  });

  it('drops Postgres detail/where, which echo row values', () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "lumibase_sites_domain_unique"'), {
      code: '23505',
      detail: 'Key (domain)=(acme.example) already exists.',
      where: 'SQL function … row (acme.example)',
      table_name: 'lumibase_sites',
      constraint_name: 'lumibase_sites_domain_unique',
    });
    const out = sanitizeError(pg);
    expect(out).toMatchObject({ code: '23505', table: 'lumibase_sites', constraint: 'lumibase_sites_domain_unique' });
    expect(JSON.stringify(out)).not.toContain('acme.example');
  });

  it('redacts bearer tokens, JWTs, API keys and DSN passwords', () => {
    const text = redactText(
      'Bearer abc.def-ghi eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXBhcnQ ' +
        'lb_ABCDEFGHIJKLMNOP postgres://app:hunter2@db.internal/x',
    );
    expect(text).not.toMatch(/abc\.def-ghi|eyJzdWIi|ABCDEFGHIJKLMNOP|hunter2/);
    expect(text).toContain('postgres://app:[redacted]@db.internal/x');
  });

  it('bounds cause recursion and string length', () => {
    let err: Error & { cause?: unknown } = new Error('x'.repeat(5000));
    for (let i = 0; i < 10; i += 1) err = Object.assign(new Error(`level ${i}`), { cause: err });
    const out = sanitizeError(err);
    let depth = 0;
    for (let cur = out; cur.cause; cur = cur.cause) depth += 1;
    expect(depth).toBe(4);
  });

  it('handles non-Error throws', () => {
    expect(sanitizeError('boom')).toEqual({ message: 'boom' });
    expect(sanitizeError(undefined)).toEqual({ message: 'undefined' });
  });
});
