import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

/**
 * Tripwire for a silent-404 class in `apps/cms/src/index.ts`.
 *
 * Hono's `app.route(path, child)` **copies the child's routes at call time**.
 * Attaching a sub-router to a parent *after* that parent has been mounted
 * therefore registers handlers nobody can reach: the composed app answers 404
 * while the router object itself looks perfectly wired, and unit tests that
 * exercise the sub-router directly still pass.
 *
 * This happened with the native TOTP feature: `index.ts` had
 *
 *     api.route('/auth', authRouter);
 *     authRouter.route('/', tfaAuthRouter);   // ← too late
 *     api.route('/me', meRouter);
 *     meRouter.route('/', tfaMeRouter);       // ← too late
 *
 * so all six `/api/v1/me/tfa*` + `/api/v1/auth/verify-totp` endpoints returned
 * `404 NOT_FOUND` against a running server, while 326 CMS test files passed —
 * none of them drove those paths through the composed app.
 *
 * Two checks, mirroring `admin-path-guard.wiring.test.ts`: a source-order
 * assertion over `index.ts` (booting the real app would open Redis/Postgres),
 * plus a behavioural proof that Hono really does drop late-attached children,
 * so the rule this test enforces cannot be dismissed as cargo cult.
 */

const INDEX_SRC = readFileSync(
  resolve(__dirname, '..', 'index.ts'),
  'utf8',
);

/** `parent.route('/…', child)` — a sub-router being attached to a parent. */
const ATTACH_RE = /^\s*(\w+)\.route\(\s*'[^']*'\s*,\s*(\w+)\s*\)/gm;

interface Attachment {
  parent: string;
  child: string;
  index: number;
}

function attachments(src: string): Attachment[] {
  const out: Attachment[] = [];
  for (const m of src.matchAll(ATTACH_RE)) {
    out.push({ parent: m[1]!, child: m[2]!, index: m.index! });
  }
  return out;
}

describe('index.ts router mount order', () => {
  it('attaches every sub-router before its parent is mounted', () => {
    const all = attachments(INDEX_SRC);
    expect(all.length).toBeGreaterThan(20);

    // A router is "mounted" at the first position where it appears as the
    // child of some other router. Anything attached TO it after that point is
    // unreachable in the composed app.
    const mountedAt = new Map<string, number>();
    for (const a of all) {
      if (!mountedAt.has(a.child)) mountedAt.set(a.child, a.index);
    }

    const late = all.filter((a) => {
      const parentMounted = mountedAt.get(a.parent);
      return parentMounted !== undefined && a.index > parentMounted;
    });

    expect(
      late.map((a) => `${a.parent}.route(..., ${a.child}) is attached after ${a.parent} was mounted`),
    ).toEqual([]);
  });

  it('keeps the TOTP routers attached before /auth and /me are mounted', () => {
    const posOf = (needle: string) => INDEX_SRC.indexOf(needle);

    const authChildAttached = posOf("authRouter.route('/', tfaAuthRouter)");
    const authMounted = posOf("api.route('/auth', authRouter)");
    const meChildAttached = posOf("meRouter.route('/', tfaMeRouter)");
    const meMounted = posOf("api.route('/me', meRouter)");

    // Guard against the assertions silently passing on a rename.
    for (const [label, pos] of [
      ['authRouter.route(tfaAuthRouter)', authChildAttached],
      ["api.route('/auth')", authMounted],
      ['meRouter.route(tfaMeRouter)', meChildAttached],
      ["api.route('/me')", meMounted],
    ] as const) {
      expect(pos, `${label} not found in index.ts`).toBeGreaterThan(-1);
    }

    expect(authChildAttached).toBeLessThan(authMounted);
    expect(meChildAttached).toBeLessThan(meMounted);
  });
});

describe('Hono route-copy semantics (why the order matters)', () => {
  const build = (attachLate: boolean) => {
    const parent = new Hono();
    const child = new Hono();
    child.get('/tfa', (c) => c.text('ok'));

    if (attachLate) {
      const api = new Hono();
      api.route('/me', parent);
      parent.route('/', child); // after the fact — invisible
      return api;
    }
    const api = new Hono();
    parent.route('/', child);
    api.route('/me', parent);
    return api;
  };

  it('drops a child attached after the parent was mounted', async () => {
    const res = await build(true).request('/me/tfa');
    expect(res.status).toBe(404);
  });

  it('serves the same child when attached before mounting', async () => {
    const res = await build(false).request('/me/tfa');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
