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
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const scriptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../templates/nextjs/scripts',
);

type Handler = (req: { method: string; url: string }) => {
  status: number;
  body: string;
  type?: string;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
});

/** Start a stub CMS and return its base URL. */
async function stubCms(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const out = handler({ method: req.method ?? 'GET', url: req.url ?? '' });
    res.writeHead(out.status, { 'content-type': out.type ?? 'application/json' });
    res.end(out.body);
  });
  servers.push(server);

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** Run a starter script and capture its outcome. */
async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run('node', [join(scriptsDir, script)], {
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const PUBLISHED_ITEM = { id: 'pub1', status: 'published', data: { slug: 'a', title: 'A' } };

describe('cms:verify — a malformed 200 is not a passing check', () => {
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

describe('cms:bootstrap — a token in .env is not proof it still works', () => {
  it('rotates instead of reusing when the stored token is rejected', async () => {
    // Review round 3: a revoked token was written back unchanged and bootstrap
    // exited 0, leaving the website on 401 with no way to recover by rerunning.
    let rotated = false;

    const url = await stubCms(({ method, url }) => {
      const json = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });

      if (url.startsWith('/api/v1/setup/state')) return { status: 200, body: JSON.stringify({ state: 'initialized' }) };
      if (url.startsWith('/api/v1/auth/login')) return json({ token: 'admin-token' });
      // Fields live on their own endpoint; bootstrap reads them from there.
      if (url.startsWith('/api/v1/collections/posts/fields')) {
        return json([{ name: 'title' }, { name: 'slug' }, { name: 'body' }]);
      }
      if (url.startsWith('/api/v1/collections/posts')) return json({ name: 'posts' });
      if (url === '/api/v1/collections') return { status: 409, body: JSON.stringify({ errors: [{ code: 'EXISTS' }] }) };
      if (url.includes('/access/grants/public/enable')) return json({ roleId: 'role-public' });
      if (url.includes('/access/grants/public')) return json({});

      if (url.includes('/rotate')) {
        rotated = true;
        return json({ token: 'lbk_pub_fresh' });
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

      // The probe that decides reuse-vs-rotate: the stale token is refused,
      // the fresh one works.
      if (url.startsWith('/api/v1/items/posts')) {
        return { status: 200, body: JSON.stringify({ data: [] }) };
      }
      return json({});
    });

    const result = await runScript('bootstrap.mjs', {
      NEXT_PUBLIC_LUMIBASE_URL: url,
      LUMIBASE_ADMIN_EMAIL: 'admin@example.com',
      LUMIBASE_ADMIN_PASSWORD: 'Change-Me-N0w!',
      // Deliberately absent: this is the "token was lost" case, which must
      // rotate rather than reuse nothing.
      NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: '',
    });

    expect(rotated, `bootstrap did not rotate:\n${result.out}`).toBe(true);
  });
});
