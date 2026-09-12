/**
 * Prove the public setup is actually safe.
 *
 *   npm run cms:verify
 *
 * Every assertion is made with the publishable key the browser holds — never
 * with the admin token:
 *
 *   1. The key can read published posts.
 *   2. The key CANNOT see the draft — by list, by direct id, or by asking.
 *   3. The key cannot write.
 *   4. The key cannot read another tenant's content.
 *
 * (2) is the one worth keeping. `GET /api/v1/items` has no implicit
 * published-only filter, so a read grant made without `publishedOnly` would
 * serve drafts to every visitor. This script fails loudly if that protection is
 * ever removed.
 *
 * ## Why a rejection is only trusted when it is the RIGHT rejection
 *
 * "The request failed, so we must be safe" is not sound. A 500 from a broken
 * server, a 404 from a typo in the path, a connection reset — all of those look
 * like a refusal if you only check that *something* went wrong, and a security
 * check that passes because the server is broken is worse than no check at all.
 *
 * So a denial counts only when the server actually denied it: HTTP 401 or 403 —
 * plus 404 for the one case where hiding a row IS the refusal (see
 * DENIED_OR_HIDDEN). Anything else fails the run and prints the status it got,
 * and a check that could not be performed is reported as SKIPPED rather than
 * folded into "all checks passed".
 */

import { api, requireEnv, waitForCms, CmsError, COLLECTION } from './lumibase.mjs';

const PUBLIC_ORIGIN = process.env.LUMIBASE_PUBLIC_ORIGIN || 'http://localhost:3000';

/** Statuses that mean "the server refused this on purpose". */
const DENIED = new Set([401, 403]);

/**
 * Reading a hidden row is the one case where 404 is also a correct refusal —
 * and in fact the better one.
 *
 * The public grant hides drafts with a row filter, so a draft simply does not
 * exist for this principal; the server says "not found" rather than "forbidden",
 * which is what you want, since 403 would confirm the id is real. Verified
 * against a live CMS: the same id returns the draft to the admin token, 404 to
 * the publishable key, while a published id returns 200 to both.
 *
 * This is deliberately NOT accepted for writes: there, a 404 means the route is
 * wrong and the test proved nothing.
 */
const DENIED_OR_HIDDEN = new Set([401, 403, 404]);

let failures = 0;
let skipped = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function skip(name, why) {
  console.log(`  · ${name} — SKIPPED (${why})`);
  skipped += 1;
}

/**
 * Run a request that MUST be refused.
 *
 * Passes only when the server answered with one of `accepted`. A success means
 * the guard is missing; any other failure means we learned nothing and must not
 * pretend otherwise — both are reported, neither is silently swallowed.
 */
async function expectDenied(name, run, accepted = DENIED) {
  const expected = [...accepted].join('/');
  try {
    await run();
    check(name, false, 'the request SUCCEEDED — the guard is missing');
    return;
  } catch (err) {
    if (!(err instanceof CmsError)) {
      // Connection reset, DNS, a crashed server mid-request… not a denial.
      check(name, false, `unexpected error: ${err.message}`);
      return;
    }
    if (!accepted.has(err.status)) {
      check(
        name,
        false,
        `expected ${expected} but got ${err.status} — this is not a denial, and ` +
          'a broken server must never read as a passing security check',
      );
      return;
    }
    check(name, true, `denied with ${err.status}`);
  }
}

async function main() {
  const key = requireEnv('NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY');
  await waitForCms();

  console.log('\nVerifying the public client…\n');

  // The publishable key is origin-locked, so send the Origin the browser sends.
  const asPublic = (path, init = {}) =>
    api(path, { ...init, token: key, headers: { origin: PUBLIC_ORIGIN, ...init.headers } });

  // 1 — can read published content
  const list = await asPublic(`/api/v1/items/${COLLECTION}?limit=100`);
  const items = list?.data ?? [];
  check('publishable key reads published posts', items.length > 0, `${items.length} item(s)`);

  // 2 — cannot see drafts
  const statuses = [...new Set(items.map((i) => i?.status).filter(Boolean))];
  const leaked = items.filter((i) => i?.status && i.status !== 'published');
  check(
    'draft posts are NOT visible to the public key',
    leaked.length === 0,
    leaked.length === 0
      ? `only saw: ${statuses.join(', ') || 'published'}`
      : `LEAKED ${leaked.length} non-published item(s)`,
  );

  // 2b — cannot reach the draft by its own id either.
  //
  // Checking the list alone is not enough: a row filter that only applied to
  // list queries would still hand over the draft on a direct GET. The id comes
  // from the admin token (server-side, never in the browser) precisely so the
  // public key is asked for something we know exists.
  const adminToken = process.env.LUMIBASE_ADMIN_TOKEN;
  if (!adminToken) {
    skip('the draft is unreachable by direct id', 'LUMIBASE_ADMIN_TOKEN not set');
  } else {
    const all = await api(`/api/v1/items/${COLLECTION}?limit=200`, { token: adminToken });
    const draft = (all?.data ?? []).find((i) => i?.status && i.status !== 'published');

    if (!draft) {
      skip(
        'the draft is unreachable by direct id',
        'no draft to test against — run: npm run cms:seed',
      );
    } else {
      await expectDenied(
        `the draft is unreachable by direct id (${draft.id})`,
        () => asPublic(`/api/v1/items/${COLLECTION}/${draft.id}`),
        DENIED_OR_HIDDEN,
      );
    }
  }

  // 2c — asking for drafts explicitly must not produce any.
  //
  // Two acceptable outcomes, and they are checked separately: the server either
  // refuses the query (401/403) or answers with an empty list. A 500 is neither.
  try {
    const asked = await asPublic(`/api/v1/items/${COLLECTION}?status=draft&limit=50`);
    const got = asked?.data ?? [];
    check('asking for status=draft returns nothing', got.length === 0, `${got.length} item(s)`);
  } catch (err) {
    if (err instanceof CmsError && DENIED.has(err.status)) {
      check('asking for status=draft returns nothing', true, `denied with ${err.status}`);
    } else {
      check(
        'asking for status=draft returns nothing',
        false,
        err instanceof CmsError
          ? `expected an empty list or 401/403, got ${err.status}`
          : `unexpected error: ${err.message}`,
      );
    }
  }

  // 3 — cannot write
  await expectDenied('publishable key cannot create items', () =>
    asPublic(`/api/v1/items/${COLLECTION}`, {
      method: 'POST',
      body: { data: { title: 'should not exist', slug: 'should-not-exist' } },
    }),
  );

  // 4 — cannot cross tenants.
  //
  // Skipped by default, and that is deliberate. Presenting the key with a
  // foreign X-Lumi-Site does correctly return 401 — but on the published image
  // it also CRASHES the CMS: the denial is written to the audit log under the
  // client-supplied site id, which no row in `sites` matches, so the insert
  // violates a foreign key and takes the process down. One request from an
  // unauthenticated caller is enough.
  //
  // Running this check would therefore knock over your own container. Opt in
  // with LUMIBASE_VERIFY_CROSS_TENANT=1 once that is fixed upstream (#469).
  if (process.env.LUMIBASE_VERIFY_CROSS_TENANT === '1') {
    await expectDenied('publishable key cannot read another site', () =>
      api(`/api/v1/items/${COLLECTION}?limit=1`, {
        token: key,
        headers: { origin: PUBLIC_ORIGIN, 'x-lumi-site': 'some-other-site' },
      }),
    );
  } else {
    skip(
      'publishable key cannot read another site',
      'it crashes the published CMS (#469) — set LUMIBASE_VERIFY_CROSS_TENANT=1 to run it',
    );
  }

  if (failures > 0) {
    console.error(`\n✖ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  if (skipped > 0) {
    console.log(`\n✔ All checks passed (${skipped} skipped — see above).\n`);
  } else {
    console.log('\n✔ All checks passed.\n');
  }
}

main().catch((err) => {
  console.error(`\n✖ Verification failed: ${err.message}\n`);
  process.exit(1);
});
