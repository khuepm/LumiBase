/**
 * Prove the public setup is actually safe.
 *
 *   npm run cms:verify
 *
 * Four assertions, all made with the publishable key the browser holds — never
 * with the admin token:
 *
 *   1. The key can read published posts.
 *   2. The key CANNOT see the draft.
 *   3. The key cannot write.
 *   4. The key cannot read another tenant's content.
 *
 * (2) is the one worth keeping. `GET /api/v1/items` has no implicit
 * published-only filter, so a read grant made without `publishedOnly` would
 * serve drafts to every visitor. This test fails loudly if that protection is
 * ever removed.
 */

import { api, requireEnv, waitForCms, CmsError, COLLECTION } from './lumibase.mjs';

const PUBLIC_ORIGIN = process.env.LUMIBASE_PUBLIC_ORIGIN || 'http://localhost:3000';

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
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

  // 3 — cannot write
  let wrote = false;
  try {
    await asPublic(`/api/v1/items/${COLLECTION}`, {
      method: 'POST',
      body: { data: { title: 'should not exist', slug: 'should-not-exist' } },
    });
    wrote = true;
  } catch (err) {
    if (!(err instanceof CmsError)) throw err;
  }
  check('publishable key cannot create items', !wrote);

  // 4 — cannot cross tenants.
  //
  // Skipped by default, and that is deliberate. Presenting the key with a
  // foreign X-Lumi-Site does correctly return 401 — but on v1.0.0-rc.1 it also
  // CRASHES the CMS: the denial is written to the audit log under the
  // client-supplied site id, which no row in `sites` matches, so the insert
  // violates a foreign key and takes the process down. One request from an
  // unauthenticated caller is enough.
  //
  // Running this check would therefore knock over your own container. Opt in
  // with LUMIBASE_VERIFY_CROSS_TENANT=1 once that is fixed upstream.
  if (process.env.LUMIBASE_VERIFY_CROSS_TENANT === '1') {
    let crossed = false;
    try {
      await api(`/api/v1/items/${COLLECTION}?limit=1`, {
        token: key,
        headers: { origin: PUBLIC_ORIGIN, 'x-lumi-site': 'some-other-site' },
      });
      crossed = true;
    } catch (err) {
      if (!(err instanceof CmsError)) throw err;
    }
    check('publishable key cannot read another site', !crossed);
  } else {
    console.log(
      '  · cross-tenant check skipped (it crashes v1.0.0-rc.1 — ' +
        'set LUMIBASE_VERIFY_CROSS_TENANT=1 to run it anyway)',
    );
  }

  if (failures > 0) {
    console.error(`\n✖ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('\n✔ All checks passed.\n');
}

main().catch((err) => {
  console.error(`\n✖ Verification failed: ${err.message}\n`);
  process.exit(1);
});
