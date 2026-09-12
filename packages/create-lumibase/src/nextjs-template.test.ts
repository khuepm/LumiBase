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

describe('nextjs template — the stack stays on loopback', () => {
  // The compose file leaves the setup-token gate off (#470), and the argument
  // for that being acceptable is entirely "this only listens on localhost".
  // `"1989:1989"` would quietly break that argument: Docker publishes on ALL
  // interfaces unless a host IP is given, so anyone on the same network could
  // claim the admin account of a stack using a fixed dev JWT_SECRET.
  it.each(['1989', '5432', '6379'])('binds port %s to 127.0.0.1', (port) => {
    const compose = read('docker-compose.yml');
    const mapping = new RegExp(`- "([^"]*:)?\\$\\{[A-Z_]+:-${port}\\}:${port}"`).exec(compose);

    expect(mapping, `no published mapping found for ${port}`).toBeTruthy();
    expect(
      mapping?.[1],
      `port ${port} is published on all interfaces. The starter ships dev ` +
        'secrets and no setup-token gate, so every mapping must name 127.0.0.1.',
    ).toBe('127.0.0.1:');
  });
});

describe('nextjs template — verification cannot pass on a broken server', () => {
  // A check that treats *any* failure as "denied" passes when the server is
  // simply broken: a 500 reads exactly like a refusal. That turns the one
  // script whose job is to prove the site is safe into a rubber stamp.
  it('only accepts 401/403 as a denial', () => {
    const verify = read('scripts/verify.mjs');
    expect(verify).toMatch(/DENIED\s*=\s*new Set\(\[401,\s*403\]\)/);
    expect(verify).toMatch(/DENIED\.has\(err\.status\)/);
  });

  it('never swallows an unexpected error as a pass', () => {
    // The old shape — `catch (err) { if (!(err instanceof CmsError)) throw err }`
    // — accepted every HTTP status as proof of a working guard.
    const verify = read('scripts/verify.mjs');
    expect(verify).not.toMatch(/if\s*\(!\(err instanceof CmsError\)\)\s*throw err;\s*\n\s*\}/);
  });

  it('reports skipped checks separately from passing ones', () => {
    const verify = read('scripts/verify.mjs');
    expect(verify).toMatch(/SKIPPED/);
    expect(verify).toMatch(/skipped \+= 1/);
  });
});

describe('nextjs template — bootstrap and seed are re-runnable', () => {
  it('reuses an existing publishable key instead of minting another', () => {
    // Bootstrap is explicitly re-runnable (a retry after a partial failure),
    // so an unconditional POST would leave extra live keys carrying read
    // access with nothing to revoke them.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/reusing the existing key/);
    expect(bootstrap).toMatch(/rotate/);
  });

  it('checks the role attachment before posting it', () => {
    // `api_key_roles` has no ON CONFLICT clause and a (api_key_id, role_id)
    // primary key, so re-attaching the same role errors rather than no-opping.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/role already attached/);
  });

  it('looks a seed slug up by filter rather than scanning one page', () => {
    // Listing the first N items and searching them is wrong as soon as the
    // collection outgrows that page: the sample reads as missing and gets
    // duplicated over a post the user may have edited.
    const seed = read('scripts/seed.mjs');
    expect(seed).toMatch(/filter=/);
    expect(seed).not.toMatch(/limit=200/);
  });
});

describe('nextjs template — the collection is actually editable', () => {
  it('creates fields through the field endpoint, not the collection body', () => {
    // POST /collections validates with a schema that has no `fields` key, so
    // Zod strips it: the request returns 201 and creates a collection with no
    // fields at all. Items still save (item validation accepts undeclared JSON),
    // so nothing looks wrong until Studio shows "No editable fields" and the
    // edit flow this starter exists to demonstrate is dead.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/collections\/\$\{COLLECTION\}\/fields\/\$\{name\}/);
    expect(bootstrap).toMatch(/method: 'PUT'/);
  });

  it('reads existing fields from the fields endpoint', () => {
    // `GET /collections/:name` returns the collection row with no `fields`
    // key, so reading them from there yields an empty set — which would make
    // the post-check vacuous and re-PUT every field on every run.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/collections\/\$\{COLLECTION\}\/fields`/);
  });

  it('fails loudly when the fields did not register', () => {
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/No editable fields/);
  });
});

describe('nextjs template — a key belongs to one project', () => {
  it('identifies its key by an owner tag, not a shared display name', () => {
    // Every generated project used the same name, so a second site would find
    // the first site's key and rotate it — breaking a live website while still
    // not working itself, since rotation keeps the original origin allowlist.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/starterOwner/);
    expect(bootstrap).toMatch(/isOwnedByThisProject/);
  });

  it('spends the stored token before trusting it', () => {
    // A token in .env proves nothing: it may be revoked or rotated elsewhere.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/async function tokenWorks/);
  });
});

describe('nextjs template — onboarding matches the real flow', () => {
  it('does not ask for a setup token the stack never issues', () => {
    // The compose file deliberately leaves the gate off (#470), so telling a
    // new user to copy SETUP_TOKEN out of the logs sends them looking for
    // something that is never printed.
    const page = read('app/page.tsx');
    expect(page).not.toMatch(/SETUP_TOKEN/);
    expect(page).toMatch(/cms:bootstrap/);
  });
});

describe('nextjs template — errors are identified, not lumped together', () => {
  it('confirms COLLECTION_EXISTS rather than treating any 409/422 as existing', () => {
    // Swallowing every 409/422 as "already there" would hide a validation
    // failure or a real conflict and carry on as if the collection were fine.
    const bootstrap = read('scripts/bootstrap.mjs');
    expect(bootstrap).toMatch(/COLLECTION_EXISTS/);
  });
});

describe('nextjs template — tenant isolation is testable', () => {
  it('probes a real second site by default, and a fake id only on request', () => {
    // These are different questions. A real second site answers the isolation
    // question and is safe. A non-existent id crashes the published CMS (#469),
    // so it stays opt-in — running cms:verify must not kill the user's server.
    const verify = read('scripts/verify.mjs');
    expect(verify).toMatch(/LUMIBASE_VERIFY_OTHER_SITE/);
    expect(verify).toMatch(/LUMIBASE_VERIFY_CROSS_TENANT === '1'/);
  });
});

describe('nextjs template — the read-only connect path is documented', () => {
  it('tells a user with an existing CMS what to set and what it needs', () => {
    // Without this, path A of the contract exists only in the spec: a reader
    // with a running CMS sees a Docker quickstart and nothing else.
    const readme = read('README.md.hbs');
    expect(readme).toMatch(/Connecting to a CMS you already run/);
    expect(readme).toMatch(/No editable fields/);
    const page = read('app/page.tsx');
    expect(page).toMatch(/Already have a LumiBase instance/);
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
