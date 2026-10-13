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
 *   4. The key cannot read another tenant's content (set
 *      LUMIBASE_VERIFY_OTHER_SITE to a second existing site id).
 *   5. A made-up site id is refused, and the CMS is still healthy afterwards.
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

import { api, requireEnv, waitForCms, CmsError, COLLECTION, CMS_URL } from './lumibase.mjs';

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
 * Deliberately NOT used anywhere else. For a write, a 404 means the route is
 * wrong. For the cross-site probe, a site with no `posts` collection answers
 * 404 too, so accepting it would let an empty second site pass a test that
 * proves nothing about isolation. Both must see a real refusal.
 */
const DENIED_OR_HIDDEN = new Set([401, 403, 404]);

/**
 * Read the `data` array out of a successful response, or explain why it is not
 * one.
 *
 * An HTTP 200 is not proof of anything on its own: a proxy error page, a
 * gateway timeout rendered as HTML, or an envelope that changed shape all
 * arrive as "success". Treating those as an empty list is how a verifier
 * reports "no drafts are visible" about a response that never contained items
 * at all — a false pass of exactly the kind this script exists to prevent.
 *
 * So the documented envelope is required: an object with a `data` array.
 */
function readList(body) {
  if (typeof body === 'string') {
    const head = body.trim().slice(0, 40).replace(/\s+/g, ' ');
    return { ok: false, why: `expected JSON, got a non-JSON body ("${head}…")` };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, why: `expected a JSON object, got ${body === null ? 'null' : typeof body}` };
  }
  if (!Array.isArray(body.data)) {
    return {
      ok: false,
      why: `expected a { data: [...] } envelope, got keys: ${Object.keys(body).join(', ') || 'none'}`,
    };
  }
  return { ok: true, items: body.data };
}

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

/**
 * A site id that does not exist must be refused, and refusing it must not hurt
 * the server.
 *
 * 404 is accepted here ONLY with the `TENANT_NOT_FOUND` code: that is the CMS
 * rejecting the site itself, before any route runs. A bare 404 could just as
 * well be a wrong path, which proves nothing — the same reason the cross-site
 * probe above refuses a plain 404.
 */
async function expectUnknownSiteRefused(key) {
  const name = 'a non-existent site id is refused';
  try {
    await api(`/api/v1/items/${COLLECTION}?limit=1`, {
      token: key,
      headers: { origin: PUBLIC_ORIGIN, 'x-lumi-site': 'lumibase-verify-no-such-site' },
    });
    check(name, false, 'the request SUCCEEDED — the guard is missing');
  } catch (err) {
    if (!(err instanceof CmsError)) {
      check(name, false, `unexpected error: ${err.message}`);
    } else if (DENIED.has(err.status)) {
      check(name, true, `denied with ${err.status}`);
    } else if (
      err.status === 404 &&
      err.body?.errors?.some?.((e) => e?.code === 'TENANT_NOT_FOUND')
    ) {
      check(name, true, 'denied with 404 TENANT_NOT_FOUND');
    } else {
      check(
        name,
        false,
        `expected 401/403 or 404 TENANT_NOT_FOUND but got ${err.status} — this is not ` +
          'a denial, and a broken server must never read as a passing security check',
      );
    }
  }

  let healthy = false;
  try {
    healthy = (await fetch(`${CMS_URL}/health`)).ok;
  } catch {
    // connection refused: the probe took the server down
  }
  check('the CMS is still healthy after that probe', healthy, healthy ? '' : 'health check failed');
}

async function main() {
  const key = requireEnv('NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY');
  await waitForCms();

  console.log('\nVerifying the public client…\n');

  // The publishable key is origin-locked, so send the Origin the browser sends.
  const asPublic = (path, init = {}) =>
    api(path, { ...init, token: key, headers: { origin: PUBLIC_ORIGIN, ...init.headers } });

  // 1 — can read published content
  const list = readList(await asPublic(`/api/v1/items/${COLLECTION}?limit=100`));
  if (!list.ok) {
    check('publishable key reads published posts', false, list.why);
    console.error('\n✖ The list response is malformed; later checks would be meaningless.\n');
    process.exit(1);
  }
  const items = list.items;
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
    const all = readList(await api(`/api/v1/items/${COLLECTION}?limit=200`, { token: adminToken }));
    if (!all.ok) {
      check('the draft is unreachable by direct id', false, `admin list: ${all.why}`);
    } else {
    const draft = all.items.find((i) => i?.status && i.status !== 'published');

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
  }

  // 2c — asking for drafts explicitly must not produce any.
  //
  // Two acceptable outcomes, and they are checked separately: the server either
  // refuses the query (401/403) or answers with an empty list. A 500 is neither.
  try {
    const asked = readList(await asPublic(`/api/v1/items/${COLLECTION}?status=draft&limit=50`));
    if (!asked.ok) {
      // An unreadable 200 tells us nothing about whether drafts are exposed.
      check('asking for status=draft returns nothing', false, asked.why);
    } else {
      check(
        'asking for status=draft returns nothing',
        asked.items.length === 0,
        `${asked.items.length} item(s)`,
      );
    }
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
  // Two different probes, because they ask different questions:
  //
  //   (a) an EXISTING other site — the real isolation question: does a key
  //       bound to site A read site B? Point LUMIBASE_VERIFY_OTHER_SITE at a
  //       second site id to enable it.
  //
  //   (b) a NON-EXISTENT site id — always run. v1.0.0-rc.1 crashed on this
  //       (#469): the denial was audited under a site id no row matches and
  //       the foreign-key failure took the process down. The CMS this starter
  //       pins answers 404 TENANT_NOT_FOUND before authentication, so the
  //       probe also re-checks health: a refusal from a server that then died
  //       is not a pass.
  const otherSite = process.env.LUMIBASE_VERIFY_OTHER_SITE;
  if (otherSite) {
    // Strictly 401/403 — NOT the relaxed set used for the draft-by-id read.
    //
    // That exception is justified only because the id is known to exist, so a
    // 404 can mean nothing but "hidden from you". Here it is ambiguous: a site
    // that simply has no `posts` collection answers 404 too, and accepting it
    // would let an empty site B pass a test that proves nothing about
    // isolation. The CMS refuses a key/site mismatch with 401 before a
    // principal is even built, so that is what this must see.
    await expectDenied(
      `publishable key cannot read another site (${otherSite})`,
      () =>
        api(`/api/v1/items/${COLLECTION}?limit=1`, {
          token: key,
          headers: { origin: PUBLIC_ORIGIN, 'x-lumi-site': otherSite },
        }),
    );
  } else {
    skip(
      'publishable key cannot read another site',
      'set LUMIBASE_VERIFY_OTHER_SITE to a second existing site id',
    );
  }

  await expectUnknownSiteRefused(key);

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
