/**
 * Behavioural tests for the starter's scripts — they RUN, against a fake CMS.
 *
 * The sibling suite asserts over the template's source text, which is enough to
 * stop a line being deleted but blind to what the script actually does with a
 * response. Review round 3 made that concrete: `cms:verify` accepted an HTTP 200
 * carrying an HTML error page as "the draft list is empty" and exited 0 — a
 * false security pass that no source assertion could have caught.
 *
 * So these spawn the real scripts with a stub server standing in for the CMS,
 * and assert on exit codes and output. Each test starts its own server on port
 * 0 so they can run in parallel and never collide.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const scriptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../templates/nextjs/scripts',
);

type Handler = (req: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}) => {
  status: number;
  body: string;
  type?: string;
};

const servers: Server[] = [];
const workdirs: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
    ...workdirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  ]);
});

/** Start a stub CMS and return its base URL. */
async function stubCms(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const out = handler({
      method: req.method ?? 'GET',
      url: req.url ?? '',
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    res.writeHead(out.status, { 'content-type': out.type ?? 'application/json' });
    res.end(out.body);
  });
  servers.push(server);

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Run a starter script and capture its outcome.
 *
 * Every run gets a throwaway working directory, and that is not tidiness. A
 * successful bootstrap ends by calling `updateEnvFile()`, which writes `.env`
 * **relative to cwd** — so a subprocess inheriting the runner's directory wrote
 * fixture credentials straight into `packages/create-lumibase/.env`. A test
 * that modifies the repository it is testing is a bug in the test, whether or
 * not the file happens to be gitignored.
 */
async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'lumibase-starter-test-'));
  workdirs.push(cwd);

  try {
    const { stdout, stderr } = await run('node', [join(scriptsDir, script)], {
      cwd,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout + stderr, cwd };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? ''), cwd };
  }
}

const PUBLISHED_ITEM = { id: 'pub1', status: 'published', data: { slug: 'a', title: 'A' } };

/** This package's own `.env`, which no test may write to. */
const PACKAGE_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

/**
 * The current contents of that file, or `null` when it is absent.
 *
 * Both are legitimate states — a contributor may well have one — so the test
 * compares this before and after rather than demanding the file not exist.
 */
async function readEnvSnapshot(): Promise<string | null> {
  try {
    return await readFile(PACKAGE_ENV, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Each test spawns a real Node process, which costs roughly a second before the
 * script under test runs at all. Several of those in parallel on a loaded
 * machine overrun vitest's 5s default and fail as timeouts that read like logic
 * errors — they are not. The work itself is milliseconds; this budget is for
 * process startup.
 */
const TIMEOUT = 30_000;

describe('cms:verify — a malformed 200 is not a passing check', { timeout: TIMEOUT }, () => {
  it('fails when the draft query answers 200 with an HTML error page', async () => {
    // The exact shape review round 3 reproduced: everything else behaves, but a
    // proxy returns an HTML error for one query. `body?.data ?? []` read that as
    // "no drafts visible" and the script exited 0.
    const url = await stubCms(({ method, url }) => {
      if (url.includes('status=draft')) {
        return { status: 200, type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' };
      }
      if (method === 'POST') return { status: 403, body: JSON.stringify({ errors: [{ code: 'FORBIDDEN' }] }) };
      if (/\/items\/posts\/[^?]+$/.test(url)) return { status: 404, body: JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }) };
      return { status: 200, body: JSON.stringify({ data: [PUBLISHED_ITEM] }) };
    });

    const result = await runScript('verify.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_test',
      LUMIBASE_ADMIN_TOKEN: '',
    });

    expect(result.code, `verify.mjs exited 0 on a malformed response:\n${result.out}`).not.toBe(0);
    expect(result.out).toMatch(/asking for status=draft/);
    expect(result.out).toMatch(/non-JSON body|data: \[/);
  });

  it('fails when a successful response drops the data envelope', async () => {
    const url = await stubCms(({ method, url }) => {
      if (url.includes('status=draft')) return { status: 200, body: JSON.stringify({ items: [] }) };
      if (method === 'POST') return { status: 403, body: JSON.stringify({ errors: [{ code: 'FORBIDDEN' }] }) };
      return { status: 200, body: JSON.stringify({ data: [PUBLISHED_ITEM] }) };
    });

    const result = await runScript('verify.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_test',
      LUMIBASE_ADMIN_TOKEN: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/envelope/);
  });

  it('fails when a denial check gets a 500 instead of a refusal', async () => {
    const url = await stubCms(({ method, url }) => {
      if (method === 'POST') return { status: 500, body: JSON.stringify({ errors: [{ code: 'INTERNAL' }] }) };
      if (url.includes('status=draft')) return { status: 200, body: JSON.stringify({ data: [] }) };
      return { status: 200, body: JSON.stringify({ data: [PUBLISHED_ITEM] }) };
    });

    const result = await runScript('verify.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_test',
      LUMIBASE_ADMIN_TOKEN: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/got 500/);
  });

  it('passes when every guard answers the way a healthy CMS does', async () => {
    // The control: without this, the tests above could pass simply because the
    // script always fails.
    const url = await stubCms(({ method, url }) => {
      if (method === 'POST') return { status: 403, body: JSON.stringify({ errors: [{ code: 'FORBIDDEN' }] }) };
      if (url.includes('status=draft')) return { status: 200, body: JSON.stringify({ data: [] }) };
      return { status: 200, body: JSON.stringify({ data: [PUBLISHED_ITEM] }) };
    });

    const result = await runScript('verify.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_test',
      LUMIBASE_ADMIN_TOKEN: '',
    });

    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/All checks passed/);
  });
});

describe('cms:bootstrap — a token in .env is not proof it still works', { timeout: TIMEOUT }, () => {
  /** A stub CMS that is fully provisioned except for the key's token state. */
  function bootstrapStub(opts: {
    /** The token the fixture treats as still valid. */
    liveToken: string;
    onRotate: () => void;
  }): Handler {
    return ({ method, url }) => {
      const json = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
      const deny = () => ({
        status: 401,
        body: JSON.stringify({ errors: [{ code: 'UNAUTHENTICATED' }] }),
      });

      if (url.startsWith('/api/v1/setup/state')) {
        return { status: 200, body: JSON.stringify({ state: 'initialized' }) };
      }
      if (url.startsWith('/api/v1/auth/login')) return json({ token: 'admin-token' });
      if (url.startsWith('/api/v1/collections/posts/fields')) {
        return json([{ name: 'title' }, { name: 'slug' }, { name: 'body' }]);
      }
      if (url.startsWith('/api/v1/collections/posts')) return json({ name: 'posts' });
      if (url === '/api/v1/collections') {
        return { status: 409, body: JSON.stringify({ errors: [{ code: 'COLLECTION_EXISTS' }] }) };
      }
      if (url.includes('/access/grants/public/enable')) return json({ roleId: 'role-public' });
      if (url.includes('/access/grants/public')) return json({});

      if (url.includes('/rotate')) {
        opts.onRotate();
        return json({ token: opts.liveToken });
      }
      if (url === '/api/v1/api-keys' && method === 'GET') {
        return json([
          {
            id: 'key1',
            name: 'Website (http://localhost:3000)',
            publishable: true,
            revokedAt: null,
            metadata: { starterOwner: 'lumibase-starter:http://localhost:3000' },
          },
        ]);
      }
      if (/\/api-keys\/key1$/.test(url)) return json({ roles: [{ roleId: 'role-public' }] });

      // The probe that decides reuse-vs-rotate, and the assertion that matters:
      // only the live token authenticates. Everything else is refused the way
      // the CMS refuses a revoked key.
      if (url.startsWith('/api/v1/items/posts')) {
        return { status: 200, body: JSON.stringify({ data: [] }) };
      }
      return json({});
    };
  }

  it('rotates when the stored token is refused, and finishes successfully', async () => {
    // The revoked-token case proper: a token IS present, and the server answers
    // 401 for it. An earlier version of this test passed an empty string, which
    // short-circuits inside tokenWorks() before any request — so it exercised
    // the missing-token path while claiming to cover revocation.
    let rotated = false;
    const REVOKED = 'lbk_pub_revoked';
    const LIVE = 'lbk_pub_fresh';

    const stub = bootstrapStub({ liveToken: LIVE, onRotate: () => { rotated = true; } });
    const url = await stubCms((req) => {
      if (req.url.startsWith('/api/v1/items/posts')) {
        const auth = String(req.headers.authorization ?? '');
        if (auth.includes(REVOKED)) {
          return { status: 401, body: JSON.stringify({ errors: [{ code: 'UNAUTHENTICATED' }] }) };
        }
        return { status: 200, body: JSON.stringify({ data: [] }) };
      }
      return stub(req);
    });

    const result = await runScript('bootstrap.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      LUMIBASE_ADMIN_EMAIL: 'admin@example.com',
      LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!',
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: REVOKED,
    });

    expect(rotated, `bootstrap did not rotate a refused token:\n${result.out}`).toBe(true);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/rotating/);
  });

  it('reuses the token when it still authenticates', async () => {
    // The control. Without it, "rotates" above could pass because the script
    // always rotates, which would be its own bug.
    let rotated = false;
    const LIVE = 'lbk_pub_live';

    const url = await stubCms(bootstrapStub({ liveToken: LIVE, onRotate: () => { rotated = true; } }));

    const result = await runScript('bootstrap.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      LUMIBASE_ADMIN_EMAIL: 'admin@example.com',
      LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!',
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: LIVE,
    });

    expect(result.code, result.out).toBe(0);
    expect(rotated, `bootstrap rotated a working token:\n${result.out}`).toBe(false);
    expect(result.out).toMatch(/reusing the existing key/);
  });

  it('writes .env into its own working directory, never the caller\'s', async () => {
    // The regression this file caused: the subprocess inherited vitest's cwd
    // and updateEnvFile() wrote fixture credentials into the repository.
    const before = await readEnvSnapshot();
    const url = await stubCms(bootstrapStub({ liveToken: 'lbk_pub_live', onRotate: () => {} }));

    const result = await runScript('bootstrap.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      LUMIBASE_ADMIN_EMAIL: 'admin@example.com',
      LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!',
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_live',
    });

    expect(result.code, result.out).toBe(0);
    const written = await readFile(join(result.cwd, '.env'), 'utf8');
    expect(written).toMatch(/NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY=/);

    // And the package's own .env is untouched.
    //
    // "Untouched" is the claim, so that is what is compared. Asserting the file
    // does not exist would test a property of the machine instead: a developer
    // with a perfectly good .env would fail this, and the test would be wrong
    // about them rather than about the code.
    const after = await readEnvSnapshot();
    expect(after, 'the bootstrap subprocess wrote to the package\'s own .env').toBe(before);
  });
});
