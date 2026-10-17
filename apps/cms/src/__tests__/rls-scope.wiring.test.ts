import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Request-path RLS scope tripwires (B130, `.kiro/specs/rls-request-scope/`
 * design §8). Source scans, in the style of `security-guards.wiring.test.ts`
 * and `worker-queue-consumers.wiring.test.ts`.
 *
 * B130: `withRls` ran the `app.site_id` setting as its own autocommit
 * statement, so its value was gone before the next query and nothing was
 * scoped — while every test stayed green. These scans keep the class closed:
 *
 * - T1: the scope setting is written only where it is correct by
 *   construction (the scoped client and `runSiteTransaction`).
 * - T2: every place that builds a db in `apps/cms/src` is classified; new
 *   ones must be added here with a reason (the list may only shrink).
 * - T3: workers, cron and queue consumers use the system connection on both
 *   runtimes.
 * - Router classes: every top-level mount in `index.ts` declares how its db
 *   is scoped.
 *
 * The behavioural proof (T4) is `rls-request-scope.db.integration.test.ts`.
 */

const CMS_SRC = resolve(__dirname, '..');
const REPO = resolve(CMS_SRC, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === 'test-utils') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Source without comments, so prose that names a token does not count. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const rel = (file: string) => relative(REPO, file).split('\\').join('/');

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(REPO, group))) {
      const src = join(REPO, group, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // package without src/
      }
    }
  }
  return roots;
}

describe('T1 — the app.site_id scope is set only where it reaches the query', () => {
  const ALLOWED = new Set(['packages/runtime/src/scoped-sql.ts', 'apps/cms/src/services/rls-transaction.ts']);

  it('no other source sets it (a standalone set_config scopes nothing, B130)', () => {
    const offenders: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of walk(root)) {
        if (/set_config\(\s*['"]app\.site_id['"]/.test(readFileSync(file, 'utf8')) && !ALLOWED.has(rel(file))) {
          offenders.push(rel(file));
        }
      }
    }
    expect(
      offenders,
      'set_config(app.site_id) outside the scoped client autocommits and scopes nothing (B130). ' +
        'Use scopedDbFor(c, siteId) on the request path or runSiteTransaction(db, siteId, fn).',
    ).toEqual([]);
  });

  it('the allowed files still contain it (stale allow-list check)', () => {
    for (const file of ALLOWED) {
      expect(readFileSync(join(REPO, file), 'utf8'), file).toMatch(/set_config\(\s*'app\.site_id'/);
    }
  });
});

type DbClass = 'request-factory' | 'system' | 'probe';
const TOKENS = ['drizzle(', 'createDb(', 'getConnection()', 'getSystemConnection()'] as const;
type Token = (typeof TOKENS)[number];

/**
 * Every non-test file under `apps/cms/src` that builds a db. This list may
 * only shrink; adding a file needs a reason and review (B130).
 */
const DB_CONSTRUCTION_ALLOWLIST: Record<string, { class: DbClass; tokens: Token[]; reason: string }> = {
  'apps/cms/src/middleware/db.ts': {
    class: 'request-factory',
    tokens: ['drizzle(', 'getConnection()', 'getSystemConnection()'],
    reason: 'The one request-side factory: withDb / scopedDbFor / withSystemDb / systemDbFor.',
  },
  'apps/cms/src/serve.ts': {
    class: 'system',
    tokens: ['drizzle(', 'getSystemConnection()'],
    reason: 'Node workers, cron and the setup-token startup run on the system connection.',
  },
  'apps/cms/src/cloudflare-system-db.ts': {
    class: 'system',
    tokens: ['createDb('],
    reason: 'Workers scheduled/queue handlers build their system db here.',
  },
  'apps/cms/src/config/db-rls-startup.ts': {
    class: 'probe',
    tokens: ['getConnection()', 'getSystemConnection()'],
    reason: 'Startup role check (pg_roles / pg_policies) on both connections; reads no tenant data.',
  },
  'apps/cms/src/routes/health.ts': {
    class: 'probe',
    tokens: ['getConnection()', 'getSystemConnection()'],
    reason: '`SELECT 1` connectivity probe of both connections; reads no tenant data.',
  },
};

describe('T2 — every db construction in apps/cms/src is classified', () => {
  const found = new Map<string, Set<Token>>();
  for (const file of walk(CMS_SRC)) {
    const src = code(file);
    const tokens = TOKENS.filter((t) => src.includes(t));
    if (tokens.length > 0) found.set(rel(file), new Set(tokens));
  }

  it('no unclassified file builds a db', () => {
    const unknown = [...found.keys()].filter((f) => !(f in DB_CONSTRUCTION_ALLOWLIST));
    expect(
      unknown,
      'New db construction outside middleware/db.ts. Use withDb/scopedDbFor/withSystemDb/systemDbFor, ' +
        'or classify the file in DB_CONSTRUCTION_ALLOWLIST with a reason (B130).',
    ).toEqual([]);
  });

  it('each classified file uses only its listed tokens', () => {
    for (const [file, tokens] of found) {
      const entry = DB_CONSTRUCTION_ALLOWLIST[file];
      if (!entry) continue;
      const extra = [...tokens].filter((t) => !entry.tokens.includes(t));
      expect(extra, `${file} uses unlisted db tokens`).toEqual([]);
    }
  });

  it('no stale entries (the list may only shrink)', () => {
    const stale = Object.keys(DB_CONSTRUCTION_ALLOWLIST).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });
});

describe('T3 — workers, cron and queue consumers use the system connection', () => {
  it('serve.ts never touches the app connection', () => {
    const src = code(join(CMS_SRC, 'serve.ts'));
    expect(src).not.toContain('getConnection(');
    expect(src).toMatch(/const rotatorDb = drizzle\(runtime\.database\.getSystemConnection\(\)/);
  });

  it('every `db:` handed to a worker in serve.ts is the system db', () => {
    const src = code(join(CMS_SRC, 'serve.ts'));
    const values = [...src.matchAll(/\bdb:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) {
      expect(v, `serve.ts db: ${v}`).toMatch(/^(rotatorDb|drizzle\(runtime\.database\.getSystemConnection\(\))/);
    }
  });

  it('no Cloudflare entry file builds its own db (system db goes through cloudflare-system-db.ts)', () => {
    // When #551 (Workers flow consumers) meets this branch, its
    // `cloudflare-queue-common.ts` must build its db with
    // `createCloudflareSystemDb(env)` instead of `createDb(connectionString)`;
    // this check turns red until it does.
    const offenders: string[] = [];
    for (const name of readdirSync(CMS_SRC)) {
      if (!/^cloudflare.*\.ts$/.test(name) || name === 'cloudflare-system-db.ts') continue;
      const src = code(join(CMS_SRC, name));
      if (src.includes('createDb(') || src.includes('.connectionString')) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('the Cloudflare scheduled and queue handlers use createCloudflareSystemDb', () => {
    for (const name of ['cloudflare.ts', 'cloudflare-agent-queue.ts']) {
      expect(code(join(CMS_SRC, name)), name).toContain('createCloudflareSystemDb(env)');
    }
  });
});

type RouterClass = 'no-db' | 'probe' | 'system' | 'request-scoped' | 'self-scoped' | 'mixed';

/**
 * How each top-level mount in `index.ts` gets its db. Unknown mounts fail.
 * `file` is the router source the class is checked against.
 */
const ROUTER_DB_CLASS: Record<string, { class: RouterClass; file?: string; note?: string }> = {
  '/api/v1/utils': { class: 'no-db', note: 'health/version/render-template; /revalidate reads c.get("db") with no withDb (B133)' },
  '/api/v1/system': { class: 'no-db' },
  '/metrics': { class: 'no-db' },
  '/test-auth': { class: 'no-db' },
  '/health': { class: 'probe', file: 'routes/health.ts' },
  '/api/v1/setup': { class: 'system', file: 'modules/setup/routes.ts' },
  '/api/v1/admin/security': { class: 'system', file: 'modules/recovery/routes.ts' },
  '/scim/v2': { class: 'system' },
  '/api/v1/deployments/webhook': { class: 'request-scoped' },
  '/api/v1': { class: 'request-scoped' },
  '/api/v1/shares': { class: 'self-scoped', file: 'routes/shares.ts' },
  '/api/v1/email': { class: 'self-scoped', file: 'routes/email-public.ts' },
  '/api/v1/deliver': { class: 'self-scoped', file: 'routes/deliver.ts' },
  '/api/v1/pageviews': { class: 'self-scoped', file: 'modules/pageviews/routes.ts' },
  '/api/v1/integrations/git': { class: 'mixed', file: 'modules/git-integration/routes.ts' },
};

describe('Router DB classes — every top-level mount declares how its db is scoped', () => {
  const index = code(join(CMS_SRC, 'index.ts'));
  const mounts = [...index.matchAll(/^app\.route\('([^']+)'/gm)].map((m) => m[1]!);
  const uses = [...index.matchAll(/^app\.use\('([^']+)',([^\n]*)/gm)].map((m) => ({ path: m[1]!, chain: m[2]! }));
  const useFor = (mount: string) =>
    uses.filter((u) => u.path === `${mount}/*` || u.path.startsWith(`${mount}/`)).map((u) => u.chain).join(' ');

  it('no unclassified or stale mount', () => {
    expect(mounts.filter((m) => !(m in ROUTER_DB_CLASS)), 'classify the new mount in ROUTER_DB_CLASS').toEqual([]);
    expect(Object.keys(ROUTER_DB_CLASS).filter((m) => !mounts.includes(m))).toEqual([]);
  });

  it('each mount matches its class', () => {
    const fileSrc = (f?: string) => (f ? code(join(CMS_SRC, f)) : '');
    for (const [mount, entry] of Object.entries(ROUTER_DB_CLASS)) {
      const chain = useFor(mount);
      const src = fileSrc(entry.file);
      switch (entry.class) {
        case 'system':
          expect(`${chain} ${src}`, mount).toContain('withSystemDb(');
          expect(`${chain} ${src}`, mount).not.toMatch(/\bwithDb\(/);
          break;
        case 'request-scoped':
          if (mount === '/api/v1') {
            expect(index).toMatch(/api\.use\('\*', withTenant\(\), withDb\(\)/);
          } else {
            expect(chain, mount).toMatch(/withTenant\(\),\s*withDb\(\)/);
          }
          break;
        case 'self-scoped':
          expect(chain, mount).toContain('withDb(');
          expect(src, mount).toContain('scopedDbFor(');
          // Shares reads the token row (`lumibase_shares`, not site-isolated)
          // on the request db and scopes everything after it. Both files also
          // hold an authenticated router (shares admin, pageviews stats) that
          // runs behind withTenant + withDb on the `api` chain.
          if (mount !== '/api/v1/shares' && mount !== '/api/v1/pageviews') {
            expect(src, `${mount} must not read the unscoped request db`).not.toMatch(/c\.get\('db'\)/);
          }
          break;
        case 'mixed':
          expect(src, mount).toContain('withSystemDb(');
          expect(code(join(CMS_SRC, 'modules/git-integration/webhook/handler.ts')), mount).toContain('scopedDbFor(');
          break;
        case 'probe':
          expect(src, mount).toContain('getConnection()');
          break;
        case 'no-db':
          expect(chain, mount).toBe('');
          break;
      }
    }
  });
});
