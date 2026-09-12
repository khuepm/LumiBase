/**
 * Seed sample posts. Safe to run repeatedly.
 *
 *   npm run cms:seed
 *
 * Idempotence is by slug, not by database id: the script reads what is already
 * in the collection and only creates what is missing. Running it twice leaves
 * three posts, not six.
 *
 * One post is deliberately left as a draft. It is what proves the public
 * website cannot see unpublished content — see `npm run cms:verify`.
 */

import { api, requireEnv, waitForCms, COLLECTION } from './lumibase.mjs';

const POSTS = [
  {
    slug: 'hello-lumibase',
    title: 'Hello, LumiBase',
    body: 'This post is served by LumiBase and rendered by Next.js. Edit it in Studio, hit publish, then reload this page — the change is live.',
    status: 'published',
  },
  {
    slug: 'editing-in-studio',
    title: 'Editing in Studio',
    body: 'Studio ships inside the same container as the API, so there is no second service to run. Your edits reach this website through a read-only publishable key.',
    status: 'published',
  },
  {
    slug: 'this-post-is-a-draft',
    title: 'This post is a draft',
    body: 'You can read this in Studio, but the website must never show it. The public grant carries a `status = published` row filter, which is what keeps drafts private.',
    status: 'draft',
  },
];

async function main() {
  const token = requireEnv('LUMIBASE_ADMIN_TOKEN');
  await waitForCms();

  console.log(`Seeding "${COLLECTION}"…\n`);

  // Ask for both statuses so an existing draft counts as already-seeded.
  const existing = await api(`/api/v1/items/${COLLECTION}?limit=200`, { token });
  const bySlug = new Set(
    (existing?.data ?? []).map((item) => item?.slug ?? item?.data?.slug).filter(Boolean),
  );

  let created = 0;
  for (const post of POSTS) {
    if (bySlug.has(post.slug)) {
      console.log(`  = ${post.slug} (already there)`);
      continue;
    }

    const { status, ...data } = post;
    await api(`/api/v1/items/${COLLECTION}`, {
      method: 'POST',
      token,
      body: { data, status },
    });
    console.log(`  + ${post.slug} (${status})`);
    created += 1;
  }

  console.log(
    `\n✔ Seed complete — ${created} created, ${POSTS.length - created} already present.`,
  );
  console.log('  Run it again: nothing is duplicated.\n');
}

main().catch((err) => {
  console.error(`\n✖ Seed failed: ${err.message}\n`);
  process.exit(1);
});
