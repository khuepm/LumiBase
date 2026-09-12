/**
 * Safety invariants for the Next.js template (#332).
 *
 * These assert the two properties the starter's whole security story rests on,
 * both of which are easy to break with an innocent-looking edit:
 *
 *  1. No admin credential is reachable from the browser. Next.js inlines every
 *     `NEXT_PUBLIC_*` variable into the client bundle, so naming a secret with
 *     that prefix leaks it to every visitor — silently, with no error.
 *
 *  2. The public read grant carries `publishedOnly`. `GET /api/v1/items`
 *     applies no implicit published-only filter of its own, so a grant written
 *     without that flag serves drafts to anonymous readers. The flag currently
 *     also defaults on for `read` server-side; this test pins the explicit
 *     request so the starter does not silently depend on that default.
 *
 * `verify.mjs` proves the same things against a live CMS. This file is the
 * cheap half that runs on every commit, with no Docker and no network.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../templates/nextjs',
);

const read = (rel: string) => readFileSync(join(templateDir, rel), 'utf8');

describe('nextjs template — secrets stay server-side', () => {
  it('never gives an admin or setup variable a NEXT_PUBLIC_ prefix', () => {
    const env = read('_env.example');
    const publicVars = [...env.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1]!);

    expect(publicVars.length).toBeGreaterThan(0);
    for (const name of publicVars) {
      expect(
        /ADMIN|SETUP|SECRET|PASSWORD/.test(name),
        `${name} is inlined into the client bundle by Next.js — it must not carry a credential`,
      ).toBe(false);
    }
  });

  it('keeps the admin token out of the browser client', () => {
    const client = read('lib/lumibase.ts');
    expect(client).not.toMatch(/LUMIBASE_ADMIN_TOKEN/);
    expect(client).toMatch(/NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY/);
  });

  it('declares the admin token without a public prefix', () => {
    // Present (the seed script needs it) but server-only.
    const env = read('_env.example');
    expect(env).toMatch(/^LUMIBASE_ADMIN_TOKEN=/m);
    expect(env).not.toMatch(/NEXT_PUBLIC_LUMIBASE_ADMIN_TOKEN/);
  });
});

describe('nextjs template — the public grant cannot leak drafts', () => {
  it('requests publishedOnly when granting public read', () => {
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/publishedOnly:\s*true/);
  });

  it('seeds a draft so the leak check has something to catch', () => {
    const seed = read('scripts/seed.mjs');
    expect(seed).toMatch(/status:\s*'draft'/);
  });

  it('verifies the publishable key cannot see non-published items', () => {
    const verify = read('scripts/verify.mjs');
    expect(verify).toMatch(/status !== 'published'/);
  });

  it('keeps the cross-tenant probe behind an opt-in flag', () => {
    // Sending a foreign X-Lumi-Site crashes v1.0.0-rc.1 — the denial is
    // audited under the client-supplied site id, which violates a foreign
    // key and kills the process. `cms:verify` must not knock over the
    // user's own CMS, so the probe stays opt-in until that is fixed.
    const verify = read('scripts/verify.mjs');
    expect(verify).toMatch(/LUMIBASE_VERIFY_CROSS_TENANT === '1'/);
  });
});

describe('nextjs template — the CMS image is pinned', () => {
  it('pulls a published image rather than building from source', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toMatch(/image:\s*ghcr\.io\/khuepm\/lumibase-cms[@:]/);
    expect(compose, 'the starter must not build the CMS from source').not.toMatch(
      /^\s*build:/m,
    );
  });

  it('pins the CMS by digest, not by any tag', () => {
    // Tags are the wrong instrument here, and not for style reasons:
    //
    //  - every semver tag (1.0.0-rc.1 included) was built before the CMS could
    //    serve Studio, so /app/studio is absent and Studio 404s. Verified by
    //    running the image, not by reading the current Dockerfile — which
    //    describes today's source, not what an older tag contains.
    //  - `latest` still points at the 0.x line.
    //  - `edge` does carry Studio but is rebuilt on every push to main, so it
    //    would change underneath a user who scaffolded weeks ago.
    //
    // A digest is immutable and names an artifact proven to contain Studio.
    const compose = read('docker-compose.yml');
    const ref = /image:\s*(ghcr\.io\/khuepm\/lumibase-cms\S+)/.exec(compose)?.[1];

    expect(ref, 'compose must reference the CMS image').toBeTruthy();
    expect(
      ref,
      `compose pins "${ref}". A tag can move or point at a Studio-less build; ` +
        'pin a sha256 digest that has been verified to contain /app/studio.',
    ).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe('nextjs template — package manifest', () => {
  it('depends on lumibase at runtime, not as a dev dependency', () => {
    // #332: a scaffolded project must actually use LumiBase, not merely
    // mention it. A devDependency would not survive into a deployed app.
    const manifest = JSON.parse(read('package.json.hbs')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['lumibase']).toBeTruthy();
    expect(manifest.devDependencies?.['lumibase']).toBeUndefined();
  });

  it('exposes the bootstrap, seed and verify scripts', () => {
    const manifest = JSON.parse(read('package.json.hbs')) as {
      scripts?: Record<string, string>;
    };
    for (const script of ['cms:up', 'cms:logs', 'cms:bootstrap', 'cms:seed', 'cms:verify']) {
      expect(manifest.scripts?.[script], `missing script: ${script}`).toBeTruthy();
    }
  });
});
