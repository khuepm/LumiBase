/**
 * `lumibase doctor --security` rules.
 *
 * Every rule is grounded in a variable the CMS actually reads, and the
 * severity follows what the CMS does with it:
 *
 *   - `critical` — the CMS refuses to start (`validateProductionConfig`,
 *     `assertDbRlsStartup`), or the setting hands an attacker a credential
 *     (a known JWT secret mints admin tokens; `*` CORS with credentials).
 *   - `warning`  — works, but weaker than the production checklist.
 *   - `info`     — guidance; nothing is wrong.
 *
 * Production rules apply when `NODE_ENV` or `LUMIBASE_ENV` is `production`
 * (the CMS's own `isProductionEnv`) or `--production` is passed. Findings
 * never carry a secret's value — only the key name and where it came from.
 *
 * Sources of truth, so a rule can be re-checked when the CMS moves:
 *   apps/cms/src/config/production.ts         required vars, dev values, AES key, sslmode, CORS `*`
 *   apps/cms/src/config/cors.ts               allowlist semantics (loopback reflected outside prod)
 *   apps/cms/src/services/auth/refresh-token.ts  REFRESH_COOKIE_SAMESITE/SECURE/DOMAIN
 *   apps/cms/src/modules/setup/setup-token.ts LUMIBASE_REQUIRE_SETUP_TOKEN (true|1|yes)
 *   apps/cms/src/config/db-rls.ts             LUMIBASE_DB_RLS (off|enforce, else fail closed)
 *   apps/cms/src/middleware/rate-limit.ts     LUMIBASE_API_RATE_LIMIT, LUMIBASE_RATE_LIMIT_FAIL_CLOSED
 *   apps/cms/src/middleware/auth.ts           LUMIBASE_DEV_AUTH (`dev:` tokens)
 *   apps/cms/src/modules/setup/service.ts     admin password ≥ 12 chars
 */

import type { EnvValue, ProjectEnv } from './env-sources.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  /** Stable rule id, e.g. `jwt-secret-weak`. */
  id: string;
  severity: Severity;
  /** One-line statement of the rule being applied. */
  rule: string;
  /** What was found, with key names and sources — never values. */
  message: string;
  /** How to fix it. */
  fix: string;
  keys: string[];
}

export type SecurityMode = 'development' | 'production';

export interface SecurityReport {
  ok: boolean;
  mode: SecurityMode;
  runtime: ProjectEnv['runtime'];
  sources: string[];
  summary: Record<Severity, number>;
  findings: Finding[];
}

/** Minimum JWT_SECRET length: 32 chars ≈ 256 bits for HS256 when random. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Values that are public knowledge: the CMS's own `DEV_SECRET_VALUES`, plus
 * placeholders that earlier templates and examples shipped. Compared
 * case-insensitively.
 */
export const KNOWN_WEAK_VALUES: ReadonlySet<string> = new Set(
  [
    // apps/cms/src/config/production.ts DEV_SECRET_VALUES
    'dev_secret_key',
    'lumibase_dev_key',
    'minioadmin',
    '736563726574',
    'lumibase-cdc-default-encryption-key-do-not-use-in-prod',
    // shipped by older create-lumibase templates / docs
    'change-me-in-production',
    'change-me',
    'changeme',
    'change-me-n0w!',
    'secret',
    'password',
    'admin',
    'test',
    'replace-me',
  ].map((v) => v.toLowerCase()),
);

export function isKnownWeak(value: string): boolean {
  return KNOWN_WEAK_VALUES.has(value.trim().toLowerCase());
}

/** Same rule as `isValidAesGcmKey` in apps/cms/src/config/production.ts. */
export function isValidAesKey(value: string): boolean {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false;
  const raw = Buffer.from(normalized, 'base64');
  return [16, 24, 32].includes(raw.byteLength) && raw.toString('base64') === normalized;
}

/** The setup wizard's floor is 12 characters; the starter asks for all four classes. */
export function isStrongAdminPassword(value: string): boolean {
  return (
    value.length >= 12 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function isTrue(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

export interface SecurityCheckOptions {
  /** Force the production checklist regardless of NODE_ENV / LUMIBASE_ENV. */
  production?: boolean;
}

export function resolveMode(env: ProjectEnv, options: SecurityCheckOptions = {}): SecurityMode {
  if (options.production) return 'production';
  const nodeEnv = env.values.get('NODE_ENV')?.value;
  const lumiEnv = env.values.get('LUMIBASE_ENV')?.value;
  return nodeEnv === 'production' || lumiEnv === 'production' ? 'production' : 'development';
}

export function runSecurityChecks(env: ProjectEnv, options: SecurityCheckOptions = {}): SecurityReport {
  const mode = resolveMode(env, options);
  const prod = mode === 'production';
  const findings: Finding[] = [];
  const get = (key: string): EnvValue | undefined => env.values.get(key);
  const val = (key: string): string | undefined => {
    const v = get(key)?.value;
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const where = (key: string): string => {
    const v = get(key);
    return v ? `${key} (${v.source})` : key;
  };
  const add = (f: Finding) => findings.push(f);
  const prodOr = (whenProd: Severity, otherwise: Severity): Severity => (prod ? whenProd : otherwise);

  if (env.files.length === 0) {
    add({
      id: 'no-config-found',
      severity: 'warning',
      rule: 'The check needs the configuration the CMS runs with.',
      message: 'No .env, .dev.vars, wrangler.toml or compose file found here; only the process environment was read.',
      fix: 'Run from the project root, or pass --env-file <path>.',
      keys: [],
    });
  }

  // ── JWT_SECRET ─────────────────────────────────────────────────────────
  const jwt = val('JWT_SECRET');
  if (!jwt) {
    add({
      id: 'jwt-secret-missing',
      severity: 'critical',
      rule: 'JWT_SECRET must be set; the CMS cannot sign or verify a session without it.',
      message: 'JWT_SECRET is not set.',
      fix: 'Generate one: `openssl rand -base64 48`, and set it in .env (or `wrangler secret put JWT_SECRET`).',
      keys: ['JWT_SECRET'],
    });
  } else if (isKnownWeak(jwt)) {
    add({
      id: 'jwt-secret-weak',
      severity: 'critical',
      rule: 'JWT_SECRET must not be a published default: anyone who knows it can mint admin tokens.',
      message: `${where('JWT_SECRET')} is a known default/placeholder value.`,
      fix: 'Replace it with `openssl rand -base64 48`. Existing sessions are invalidated, which is the point.',
      keys: ['JWT_SECRET'],
    });
  } else if (jwt.length < MIN_JWT_SECRET_LENGTH) {
    add({
      id: 'jwt-secret-short',
      severity: prodOr('critical', 'warning'),
      rule: `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters of random data.`,
      message: `${where('JWT_SECRET')} is ${jwt.length} characters long.`,
      fix: 'Replace it with `openssl rand -base64 48`.',
      keys: ['JWT_SECRET'],
    });
  }

  // ── ENCRYPTION_KEY (+ versioned ENCRYPTION_KEY_<id>) ──────────────────
  const enc = val('ENCRYPTION_KEY');
  const versioned = [...env.values.keys()].filter(
    (k) => k.startsWith('ENCRYPTION_KEY_') && !k.endsWith('_FILE') && val(k) !== undefined,
  );
  if (!enc && versioned.length === 0) {
    add({
      id: 'encryption-key-missing',
      severity: prodOr('critical', 'warning'),
      rule: 'ENCRYPTION_KEY is required in production; MFA, CDC, Git and Firebase credentials are encrypted with it.',
      message: 'ENCRYPTION_KEY is not set.',
      fix: 'Generate a 256-bit key: `openssl rand -base64 32`.',
      keys: ['ENCRYPTION_KEY'],
    });
  }
  for (const key of [...(enc ? ['ENCRYPTION_KEY'] : []), ...versioned]) {
    const v = val(key)!;
    if (isKnownWeak(v)) {
      add({
        id: 'encryption-key-weak',
        severity: 'critical',
        rule: 'Encryption keys must not be a published default.',
        message: `${where(key)} is a known default value.`,
        fix: 'Generate a new key with `openssl rand -base64 32` and rotate (ENCRYPTION_KEY_<id> + ENCRYPTION_ACTIVE_KEY_ID).',
        keys: [key],
      });
    } else if (!isValidAesKey(v)) {
      add({
        id: 'encryption-key-format',
        severity: 'critical',
        rule: 'Encryption keys must be base64 of a 128, 192 or 256-bit AES key (the CMS refuses to start otherwise in production).',
        message: `${where(key)} is not a base64-encoded 16/24/32-byte key.`,
        fix: 'Generate one with `openssl rand -base64 32`.',
        keys: [key],
      });
    }
  }

  // ── Dev auth bypass ────────────────────────────────────────────────────
  if (val('LUMIBASE_DEV_AUTH') === 'true') {
    add({
      id: 'dev-auth-enabled',
      severity: prodOr('critical', 'warning'),
      rule: 'LUMIBASE_DEV_AUTH accepts forged `dev:` bearer tokens and must never reach a shared instance.',
      message: `${where('LUMIBASE_DEV_AUTH')} is true.`,
      fix: 'Remove LUMIBASE_DEV_AUTH (or set it to false).',
      keys: ['LUMIBASE_DEV_AUTH'],
    });
  }

  // ── Other well-known dev credentials ──────────────────────────────────
  for (const key of ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'MEILISEARCH_API_KEY']) {
    const v = val(key);
    if (v && isKnownWeak(v)) {
      add({
        id: 'dev-credential',
        severity: prodOr('critical', 'warning'),
        rule: 'Service credentials must not be the development defaults (the CMS refuses them in production).',
        message: `${where(key)} is a development default.`,
        fix: `Create a dedicated credential for ${key}.`,
        keys: [key],
      });
    }
  }

  // ── CORS ───────────────────────────────────────────────────────────────
  const corsRaw = val('CORS_ALLOWED_ORIGINS');
  const origins = (corsRaw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.includes('*')) {
    add({
      id: 'cors-wildcard',
      severity: 'critical',
      rule: 'CORS_ALLOWED_ORIGINS must list exact origins; responses are credentialed, so `*` is refused in production.',
      message: `${where('CORS_ALLOWED_ORIGINS')} contains *.`,
      fix: 'List the exact origins, e.g. CORS_ALLOWED_ORIGINS=https://www.example.com,https://studio.example.com',
      keys: ['CORS_ALLOWED_ORIGINS'],
    });
  }
  if (origins.length === 0) {
    add({
      id: 'cors-unset',
      severity: prodOr('critical', 'info'),
      rule: 'CORS_ALLOWED_ORIGINS is required in production; without it only loopback origins are allowed outside production.',
      message: 'CORS_ALLOWED_ORIGINS is not set.',
      fix: 'Set CORS_ALLOWED_ORIGINS to the origins of your website and Studio.',
      keys: ['CORS_ALLOWED_ORIGINS'],
    });
  } else if (prod) {
    const weak = origins.filter((o) => o !== '*' && (o.startsWith('http://') || isLoopbackOrigin(o)));
    if (weak.length > 0) {
      add({
        id: 'cors-insecure-origin',
        severity: 'warning',
        rule: 'Production origins should be https and not loopback.',
        message: `${where('CORS_ALLOWED_ORIGINS')} includes ${weak.join(', ')}.`,
        fix: 'Replace development origins with your real https origins.',
        keys: ['CORS_ALLOWED_ORIGINS'],
      });
    }
  }

  // ── Refresh cookie flags ───────────────────────────────────────────────
  const sameSiteRaw = val('REFRESH_COOKIE_SAMESITE')?.toLowerCase();
  const sameSiteNone = sameSiteRaw === 'none';
  if (sameSiteRaw && !['lax', 'strict', 'none'].includes(sameSiteRaw)) {
    add({
      id: 'cookie-samesite-invalid',
      severity: 'warning',
      rule: 'REFRESH_COOKIE_SAMESITE accepts Lax, Strict or None.',
      message: `${where('REFRESH_COOKIE_SAMESITE')} is not recognised; the CMS falls back to Lax.`,
      fix: 'Use Lax (default), Strict, or None for a cross-site Studio.',
      keys: ['REFRESH_COOKIE_SAMESITE'],
    });
  } else if (sameSiteNone) {
    add({
      id: 'cookie-samesite-none',
      severity: prodOr('warning', 'info'),
      rule: 'SameSite=None makes the refresh cookie cross-site; only the X-Lumibase-Refresh header then stops CSRF.',
      message: `${where('REFRESH_COOKIE_SAMESITE')} is None.`,
      fix: 'Serve Studio and the API from the same site and keep the default (Lax), unless cross-site is required.',
      keys: ['REFRESH_COOKIE_SAMESITE'],
    });
  }
  if (val('REFRESH_COOKIE_SECURE')?.toLowerCase() === 'false' && !sameSiteNone) {
    add({
      id: 'cookie-insecure',
      severity: prodOr('critical', 'info'),
      rule: 'The refresh cookie must be Secure outside local http development.',
      message: `${where('REFRESH_COOKIE_SECURE')} is false — the refresh token can travel over plain http.`,
      fix: 'Remove REFRESH_COOKIE_SECURE (the default is Secure) and serve over https.',
      keys: ['REFRESH_COOKIE_SECURE'],
    });
  }

  // ── First-run setup gate (Node/Docker only) ────────────────────────────
  if (env.runtime === 'docker' && !isTrue(val('LUMIBASE_REQUIRE_SETUP_TOKEN'))) {
    add({
      id: 'setup-token-off',
      severity: prodOr('warning', 'info'),
      rule: 'An instance reachable before its first admin exists should require the one-time setup token.',
      message: 'LUMIBASE_REQUIRE_SETUP_TOKEN is off: whoever reaches /setup first claims the admin account.',
      fix: 'Set LUMIBASE_REQUIRE_SETUP_TOKEN=true; the CMS prints SETUP_TOKEN=… once at startup.',
      keys: ['LUMIBASE_REQUIRE_SETUP_TOKEN'],
    });
  }

  // ── Row-level security ─────────────────────────────────────────────────
  const rlsRaw = val('LUMIBASE_DB_RLS')?.toLowerCase();
  if (rlsRaw && rlsRaw !== 'off' && rlsRaw !== 'enforce') {
    add({
      id: 'rls-invalid',
      severity: 'critical',
      rule: 'LUMIBASE_DB_RLS must be "off" or "enforce"; anything else fails closed (startup error).',
      message: `${where('LUMIBASE_DB_RLS')} is not a recognised value.`,
      fix: 'Set LUMIBASE_DB_RLS=enforce (recommended) or off.',
      keys: ['LUMIBASE_DB_RLS'],
    });
  } else if (rlsRaw === 'enforce') {
    if (env.runtime === 'docker' && !val('DATABASE_SYSTEM_URL')) {
      add({
        id: 'rls-no-system-url',
        severity: 'critical',
        rule: 'LUMIBASE_DB_RLS=enforce needs DATABASE_SYSTEM_URL (a BYPASSRLS role) or the CMS refuses to start.',
        message: 'LUMIBASE_DB_RLS=enforce without DATABASE_SYSTEM_URL.',
        fix: 'Point DATABASE_SYSTEM_URL at a role with BYPASSRLS and DATABASE_URL at a role without it.',
        keys: ['LUMIBASE_DB_RLS', 'DATABASE_SYSTEM_URL'],
      });
    }
  } else if (env.runtime === 'docker') {
    add({
      id: 'rls-off',
      severity: prodOr('warning', 'info'),
      rule: 'Production should enforce Postgres row-level security as a second tenant-isolation layer.',
      message: 'LUMIBASE_DB_RLS is off: tenant isolation relies on application-level site_id scoping alone.',
      fix: 'Run DATABASE_URL as a non-BYPASSRLS role, set DATABASE_SYSTEM_URL to a BYPASSRLS role, then LUMIBASE_DB_RLS=enforce.',
      keys: ['LUMIBASE_DB_RLS'],
    });
  }

  // ── Rate limiting ──────────────────────────────────────────────────────
  const rateRaw = val('LUMIBASE_API_RATE_LIMIT');
  if (rateRaw !== undefined) {
    const n = Number.parseInt(rateRaw, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== rateRaw) {
      add({
        id: 'rate-limit-invalid',
        severity: 'warning',
        rule: 'LUMIBASE_API_RATE_LIMIT is requests per minute per principal (a non-negative integer).',
        message: `${where('LUMIBASE_API_RATE_LIMIT')} is not an integer; the CMS falls back to 600.`,
        fix: 'Set an integer, e.g. LUMIBASE_API_RATE_LIMIT=600.',
        keys: ['LUMIBASE_API_RATE_LIMIT'],
      });
    } else if (n === 0) {
      add({
        id: 'rate-limit-disabled',
        severity: 'warning',
        rule: 'The general API rate limit should stay on.',
        message: `${where('LUMIBASE_API_RATE_LIMIT')} is 0 — API rate limiting is off.`,
        fix: 'Remove it (default 600 req/min) or set a positive limit.',
        keys: ['LUMIBASE_API_RATE_LIMIT'],
      });
    }
  }
  if (prod && val('LUMIBASE_RATE_LIMIT_FAIL_CLOSED') !== 'true') {
    add({
      id: 'rate-limit-fail-open',
      severity: 'info',
      rule: 'With LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true the API answers 503 instead of skipping limits when the limiter store is down.',
      message: 'Rate limiting fails open if Redis / the limiter is unavailable.',
      fix: 'Set LUMIBASE_RATE_LIMIT_FAIL_CLOSED=true if availability of the limiter is monitored.',
      keys: ['LUMIBASE_RATE_LIMIT_FAIL_CLOSED'],
    });
  }
  if (env.runtime === 'docker' && !val('REDIS_URL')) {
    add({
      id: 'redis-unset',
      severity: prodOr('critical', 'info'),
      rule: 'REDIS_URL is required in production: rate limits and login lockouts must be shared across processes.',
      message: 'REDIS_URL is not set; limits are per process.',
      fix: 'Set REDIS_URL (Redis with a password and TLS outside a private network).',
      keys: ['REDIS_URL'],
    });
  }

  // ── Database TLS (production refuses to start without it) ─────────────
  const dbUrl = val('DATABASE_URL');
  if (prod && env.runtime === 'docker') {
    if (!dbUrl) {
      add({
        id: 'database-url-missing',
        severity: 'critical',
        rule: 'DATABASE_URL is required in production.',
        message: 'DATABASE_URL is not set.',
        fix: 'Set DATABASE_URL (with sslmode=require or stricter).',
        keys: ['DATABASE_URL'],
      });
    } else if (val('DATABASE_SSL_MODE')?.toLowerCase() !== 'disable') {
      let sslmode = '';
      try {
        sslmode = new URL(dbUrl).searchParams.get('sslmode')?.toLowerCase() ?? '';
      } catch {
        sslmode = '';
      }
      if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
        add({
          id: 'database-tls',
          severity: 'critical',
          rule: 'DATABASE_URL must use sslmode=require, verify-ca or verify-full in production.',
          message: `${where('DATABASE_URL')} has no sslmode=require|verify-ca|verify-full.`,
          fix: 'Append ?sslmode=verify-full (or require). Set DATABASE_SSL_MODE=disable only on a private network without DB TLS.',
          keys: ['DATABASE_URL'],
        });
      }
    }
  }

  // ── First-admin bootstrap credentials ──────────────────────────────────
  for (const key of ['LUMIBASE_ADMIN_PASSWORD', 'ADMIN_PASSWORD']) {
    const v = val(key);
    if (!v) continue;
    if (isKnownWeak(v)) {
      add({
        id: 'admin-password-default',
        severity: 'critical',
        rule: 'The first administrator must not use a published default password.',
        message: `${where(key)} is a known default password.`,
        fix: 'Generate one, e.g. `openssl rand -base64 18`, and change it in Studio if the admin already exists.',
        keys: [key],
      });
    } else if (!isStrongAdminPassword(v)) {
      add({
        id: 'admin-password-weak',
        severity: 'warning',
        rule: 'Admin passwords need 12+ characters with upper, lower, digit and symbol.',
        message: `${where(key)} does not meet the password policy.`,
        fix: 'Use a longer generated password.',
        keys: [key],
      });
    }
  }

  // ── Secrets exposed to the browser bundle ─────────────────────────────
  for (const key of env.values.keys()) {
    if (!/^(NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(key)) continue;
    if (/SECRET|PASSWORD|PRIVATE|ADMIN_TOKEN|SETUP_TOKEN|ENCRYPTION|JWT/.test(key) && val(key)) {
      add({
        id: 'secret-in-public-env',
        severity: 'critical',
        rule: 'Browser-prefixed variables are inlined into the client bundle and must not carry a credential.',
        message: `${where(key)} looks like a credential and is shipped to every visitor.`,
        fix: 'Drop the public prefix and read it server-side only.',
        keys: [key],
      });
    }
  }

  // ── Secrets written into committed config ─────────────────────────────
  for (const [key, entry] of env.values) {
    if (!entry.committedLiteral || !entry.value) continue;
    if (!/(SECRET|PASSWORD|ENCRYPTION_KEY|_TOKEN|API_KEY|PRIVATE_KEY)/.test(key)) continue;
    if (/^POSTGRES_|^NEXT_PUBLIC_/.test(key)) continue;
    add({
      id: 'secret-committed',
      severity: prodOr('critical', 'warning'),
      rule: 'Secrets belong in a gitignored .env / secret store, not in committed config.',
      message: `${key} is written literally in ${entry.source}.`,
      fix:
        entry.kind === 'wrangler'
          ? `Remove it from [vars] and run \`wrangler secret put ${key}\` (local dev: .dev.vars).`
          : `Use \`${key}: \${${key}:?set ${key} in .env}\` and keep the value in .env.`,
      keys: [key],
    });
  }

  if (!prod) {
    add({
      id: 'development-mode',
      severity: 'info',
      rule: 'Production rules apply when NODE_ENV or LUMIBASE_ENV is production.',
      message: 'Checked against development rules.',
      fix: 'Run `lumibase doctor --security --production` to check the production checklist.',
      keys: ['NODE_ENV', 'LUMIBASE_ENV'],
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const summary: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) summary[f.severity] += 1;

  return {
    ok: summary.critical === 0,
    mode,
    runtime: env.runtime,
    sources: env.files,
    summary,
    findings,
  };
}
