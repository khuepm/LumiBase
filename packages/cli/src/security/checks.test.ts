import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorCommand } from '../commands/doctor.js';
import { parseArgs } from '../utils/args.js';
import { isValidAesKey, runSecurityChecks, type SecurityReport } from './checks.js';
import {
  interpolate,
  loadProjectEnv,
  parseComposeEnvironment,
  parseDotenv,
  parseWranglerVars,
  type EnvValue,
  type ProjectEnv,
} from './env-sources.js';

const STRONG_JWT = 'x'.repeat(10) + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const STRONG_AES = Buffer.alloc(32, 7).toString('base64');

function envOf(values: Record<string, string>, runtime: ProjectEnv['runtime'] = 'docker'): ProjectEnv {
  const map = new Map<string, EnvValue>();
  for (const [k, v] of Object.entries(values)) {
    map.set(k, { value: v, source: '.env', kind: 'dotenv', committedLiteral: false });
  }
  return { values: map, files: ['.env'], runtime };
}

const ids = (r: SecurityReport, severity?: string) =>
  r.findings.filter((f) => !severity || f.severity === severity).map((f) => f.id);

/** A configuration that satisfies the whole production checklist. */
const PROD_OK = {
  NODE_ENV: 'production',
  JWT_SECRET: STRONG_JWT,
  ENCRYPTION_KEY: STRONG_AES,
  CORS_ALLOWED_ORIGINS: 'https://www.example.com',
  DATABASE_URL: 'postgresql://app@db.internal:5432/lumibase?sslmode=verify-full',
  DATABASE_SYSTEM_URL: 'postgresql://sys@db.internal:5432/lumibase?sslmode=verify-full',
  REDIS_URL: 'rediss://cache.internal:6380',
  LUMIBASE_REQUIRE_SETUP_TOKEN: 'true',
  LUMIBASE_DB_RLS: 'enforce',
  LUMIBASE_RATE_LIMIT_FAIL_CLOSED: 'true',
};

describe('env source parsers', () => {
  it('reads dotenv with quotes, export and inline comments', () => {
    const m = parseDotenv('export A=1\nB="two # kept"\nC=three # dropped\n# D=4\nE=\n');
    expect([...m]).toEqual([
      ['A', '1'],
      ['B', 'two # kept'],
      ['C', 'three'],
      ['E', ''],
    ]);
  });

  it('reads only [vars] from wrangler.toml', () => {
    const m = parseWranglerVars('name = "x"\n[vars]\nJWT_SECRET = "s"\nA = "b"\n[[d1_databases]]\nbinding = "DB"\n');
    expect([...m]).toEqual([
      ['JWT_SECRET', 's'],
      ['A', 'b'],
    ]);
  });

  it('reads compose environment in map and list form', () => {
    const yaml = [
      'services:',
      '  cms:',
      '    image: x',
      '    environment:',
      '      # comment',
      '      JWT_SECRET: ${JWT_SECRET:?missing}',
      '      PORT: "1989"',
      '    ports:',
      '      - "127.0.0.1:1989:1989"',
      '  other:',
      '    environment:',
      '      - REDIS_URL=redis://redis:6379',
    ].join('\n');
    const m = parseComposeEnvironment(yaml);
    expect([...m.keys()]).toEqual(['JWT_SECRET', 'PORT', 'REDIS_URL']);
    expect(m.get('PORT')?.raw).toBe('1989');
  });

  it('interpolates like compose', () => {
    const look = (k: string) => ({ A: 'a', E: '' } as Record<string, string>)[k];
    expect(interpolate('${A}', look)).toEqual({ value: 'a', literal: false });
    expect(interpolate('${B:-d}', look).value).toBe('d');
    expect(interpolate('${E:-d}', look).value).toBe('d');
    expect(interpolate('${E-d}', look).value).toBe('');
    expect(interpolate('${B:?boom}', look).value).toBeUndefined();
    expect(interpolate('literal', look)).toEqual({ value: 'literal', literal: true });
    expect(interpolate('x$$y', look).value).toBe('x$y');
  });
});

describe('security rules', () => {
  it('passes the full production checklist with zero findings above info', () => {
    const r = runSecurityChecks(envOf(PROD_OK));
    expect(r.mode).toBe('production');
    expect(ids(r, 'critical')).toEqual([]);
    expect(ids(r, 'warning')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['dev_secret_key'],
    ['change-me-in-production'],
    ['CHANGE-ME'],
  ])('flags the known JWT secret %s as critical in every mode', (secret) => {
    expect(ids(runSecurityChecks(envOf({ JWT_SECRET: secret })), 'critical')).toContain('jwt-secret-weak');
    expect(ids(runSecurityChecks(envOf({ ...PROD_OK, JWT_SECRET: secret })), 'critical')).toContain(
      'jwt-secret-weak',
    );
  });

  it('flags a missing JWT secret as critical and a short one by mode', () => {
    expect(ids(runSecurityChecks(envOf({})), 'critical')).toContain('jwt-secret-missing');
    expect(ids(runSecurityChecks(envOf({ JWT_SECRET: 'short-but-unique' })), 'warning')).toContain(
      'jwt-secret-short',
    );
    expect(
      ids(runSecurityChecks(envOf({ ...PROD_OK, JWT_SECRET: 'short-but-unique' })), 'critical'),
    ).toContain('jwt-secret-short');
  });

  it('validates ENCRYPTION_KEY exactly as the CMS does', () => {
    expect(isValidAesKey(STRONG_AES)).toBe(true);
    expect(isValidAesKey(Buffer.alloc(20).toString('base64'))).toBe(false);
    expect(isValidAesKey('not base64!')).toBe(false);
    const r = runSecurityChecks(envOf({ ...PROD_OK, ENCRYPTION_KEY: 'dev_secret_key', ENCRYPTION_KEY_v2: 'abc' }));
    expect(ids(r, 'critical')).toEqual(expect.arrayContaining(['encryption-key-weak', 'encryption-key-format']));
    const missing = { ...PROD_OK } as Record<string, string>;
    delete missing['ENCRYPTION_KEY'];
    expect(ids(runSecurityChecks(envOf(missing)), 'critical')).toContain('encryption-key-missing');
    expect(ids(runSecurityChecks(envOf({ JWT_SECRET: STRONG_JWT })), 'warning')).toContain('encryption-key-missing');
  });

  it('rejects wildcard CORS always and requires an allowlist in production', () => {
    expect(ids(runSecurityChecks(envOf({ CORS_ALLOWED_ORIGINS: 'https://a.com, *' })), 'critical')).toContain(
      'cors-wildcard',
    );
    const noCors = { ...PROD_OK } as Record<string, string>;
    delete noCors['CORS_ALLOWED_ORIGINS'];
    expect(ids(runSecurityChecks(envOf(noCors)), 'critical')).toContain('cors-unset');
    expect(ids(runSecurityChecks(envOf({})), 'info')).toContain('cors-unset');
    expect(
      ids(runSecurityChecks(envOf({ ...PROD_OK, CORS_ALLOWED_ORIGINS: 'http://localhost:3000' })), 'warning'),
    ).toContain('cors-insecure-origin');
  });

  it('checks refresh-cookie flags', () => {
    expect(ids(runSecurityChecks(envOf({ ...PROD_OK, REFRESH_COOKIE_SECURE: 'false' })), 'critical')).toContain(
      'cookie-insecure',
    );
    expect(ids(runSecurityChecks(envOf({ REFRESH_COOKIE_SECURE: 'false' })), 'info')).toContain('cookie-insecure');
    // SameSite=None forces Secure in the CMS, so SECURE=false is moot there.
    const none = runSecurityChecks(envOf({ ...PROD_OK, REFRESH_COOKIE_SAMESITE: 'None', REFRESH_COOKIE_SECURE: 'false' }));
    expect(ids(none)).not.toContain('cookie-insecure');
    expect(ids(none, 'warning')).toContain('cookie-samesite-none');
    expect(ids(runSecurityChecks(envOf({ REFRESH_COOKIE_SAMESITE: 'loose' })), 'warning')).toContain(
      'cookie-samesite-invalid',
    );
  });

  it('checks dev auth, setup gate, RLS, rate limit, redis and DB TLS', () => {
    const r = runSecurityChecks(
      envOf({
        ...PROD_OK,
        LUMIBASE_DEV_AUTH: 'true',
        LUMIBASE_REQUIRE_SETUP_TOKEN: 'false',
        LUMIBASE_DB_RLS: 'on',
        LUMIBASE_API_RATE_LIMIT: '0',
        REDIS_URL: '',
        DATABASE_URL: 'postgresql://u@h/db',
      }),
    );
    expect(ids(r, 'critical')).toEqual(
      expect.arrayContaining(['dev-auth-enabled', 'rls-invalid', 'redis-unset', 'database-tls']),
    );
    expect(ids(r, 'warning')).toEqual(expect.arrayContaining(['setup-token-off', 'rate-limit-disabled']));

    const noSystem = { ...PROD_OK } as Record<string, string>;
    delete noSystem['DATABASE_SYSTEM_URL'];
    expect(ids(runSecurityChecks(envOf(noSystem)), 'critical')).toContain('rls-no-system-url');
    expect(ids(runSecurityChecks(envOf({ ...PROD_OK, LUMIBASE_DB_RLS: 'off' })), 'warning')).toContain('rls-off');
    expect(
      ids(runSecurityChecks(envOf({ ...PROD_OK, DATABASE_URL: 'postgresql://u@h/db', DATABASE_SSL_MODE: 'disable' }))),
    ).not.toContain('database-tls');
  });

  it('skips Node-only rules on the Cloudflare runtime', () => {
    const r = runSecurityChecks(
      envOf({ NODE_ENV: 'production', JWT_SECRET: STRONG_JWT, ENCRYPTION_KEY: STRONG_AES, CORS_ALLOWED_ORIGINS: 'https://a.com' }, 'cloudflare'),
    );
    expect(ids(r)).not.toEqual(expect.arrayContaining(['setup-token-off']));
    expect(ids(r)).not.toContain('redis-unset');
    expect(ids(r)).not.toContain('database-tls');
    expect(r.ok).toBe(true);
  });

  it('flags default and weak admin passwords', () => {
    expect(ids(runSecurityChecks(envOf({ LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!' })), 'critical')).toContain(
      'admin-password-default',
    );
    expect(ids(runSecurityChecks(envOf({ ADMIN_PASSWORD: 'change-me' })), 'critical')).toContain(
      'admin-password-default',
    );
    expect(ids(runSecurityChecks(envOf({ LUMIBASE_ADMIN_PASSWORD: 'longbutlowercase' })), 'warning')).toContain(
      'admin-password-weak',
    );
  });

  it('flags credentials in browser-public variables', () => {
    expect(
      ids(runSecurityChecks(envOf({ NEXT_PUBLIC_LUMIBASE_ADMIN_TOKEN: 'lbk_x' })), 'critical'),
    ).toContain('secret-in-public-env');
    expect(ids(runSecurityChecks(envOf({ NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_x' })))).not.toContain(
      'secret-in-public-env',
    );
  });

  it('never puts a secret value into the report', () => {
    const secret = 'dev_secret_key';
    const r = runSecurityChecks(envOf({ JWT_SECRET: secret, LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!' }));
    const json = JSON.stringify(r);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('Change-Me-N0w!');
  });
});

describe('loadProjectEnv + doctor --security', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('resolves compose interpolation from .env and flags committed secrets', () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, '.env'), `JWT_SECRET=${STRONG_JWT}\n`);
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      [
        'services:',
        '  cms:',
        '    environment:',
        '      JWT_SECRET: ${JWT_SECRET:?x}',
        '      ENCRYPTION_KEY: dev_secret_key',
        '      CORS_ALLOWED_ORIGINS: ${PUBLIC_ORIGIN:-http://localhost:3000}',
      ].join('\n'),
    );
    const env = loadProjectEnv(dir, { processEnv: {} });
    expect(env.values.get('JWT_SECRET')).toMatchObject({ value: STRONG_JWT, kind: 'compose', committedLiteral: false });
    expect(env.values.get('CORS_ALLOWED_ORIGINS')?.value).toBe('http://localhost:3000');
    const r = runSecurityChecks(env);
    expect(ids(r, 'critical')).toContain('encryption-key-weak');
    expect(ids(r, 'warning')).toContain('secret-committed');
  });

  it('treats a `:?` secret missing from .env as unset', () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  cms:\n    environment:\n      JWT_SECRET: ${JWT_SECRET:?x}\n');
    expect(ids(runSecurityChecks(loadProjectEnv(dir, { processEnv: {} })), 'critical')).toContain('jwt-secret-missing');
  });

  it('flags secrets in wrangler.toml [vars] and detects the Cloudflare runtime', () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, 'wrangler.toml'), `[vars]\nJWT_SECRET = "${STRONG_JWT}"\n`);
    const env = loadProjectEnv(dir, { processEnv: {} });
    expect(env.runtime).toBe('cloudflare');
    const r = runSecurityChecks(env, { production: true });
    expect(ids(r, 'critical')).toContain('secret-committed');
  });

  it('lets the process environment override dotenv, ignoring unrelated variables', () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, '.env'), 'JWT_SECRET=dev_secret_key\n');
    const env = loadProjectEnv(dir, { processEnv: { JWT_SECRET: STRONG_JWT, HOME: '/root' } });
    expect(env.values.get('JWT_SECRET')?.kind).toBe('process');
    expect(env.values.has('HOME')).toBe(false);
  });

  it('exits 1 on criticals, 0 otherwise, and prints JSON with --json', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, '.env'), 'JWT_SECRET=change-me-in-production\n');
    const out: string[] = [];
    const code = await doctorCommand(parseArgs(['doctor', '--security', '--json']), {
      cwd: dir,
      env: {},
      write: (l) => out.push(l),
    });
    expect(code).toBe(1);
    const report = JSON.parse(out.join('\n')) as SecurityReport;
    expect(report.ok).toBe(false);
    expect(report.summary.critical).toBeGreaterThan(0);
    expect(report.findings[0]).toMatchObject({ severity: 'critical' });
    for (const f of report.findings) {
      expect(f.rule).toBeTruthy();
      expect(f.fix).toBeTruthy();
    }

    writeFileSync(join(dir, '.env'), `JWT_SECRET=${STRONG_JWT}\nENCRYPTION_KEY=${STRONG_AES}\n`);
    const text: string[] = [];
    expect(
      await doctorCommand(parseArgs(['doctor', '--security']), { cwd: dir, env: {}, write: (l) => text.push(l) }),
    ).toBe(0);
    expect(text.join('\n')).toMatch(/0 critical/);
  });

  it('reads an explicit --env-file and fails on a missing one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lb-doctor-'));
    writeFileSync(join(dir, 'prod.env'), `JWT_SECRET=${STRONG_JWT}\nNODE_ENV=production\n`);
    const out: string[] = [];
    await doctorCommand(parseArgs(['doctor', '--security', '--json', '--env-file', 'prod.env']), {
      cwd: dir,
      env: {},
      write: (l) => out.push(l),
    });
    const report = JSON.parse(out.join('\n')) as SecurityReport;
    expect(report.mode).toBe('production');
    expect(report.sources).toEqual(['prod.env']);
    await expect(
      doctorCommand(parseArgs(['doctor', '--security', '--env-file', 'nope.env']), { cwd: dir, env: {} }),
    ).rejects.toThrow(/nope\.env/);
  });
});
