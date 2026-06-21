import Link from 'next/link';
import { lumi } from '@/lib/lumi';

// ISR: re-fetch at most once a minute; LumiBase revalidation webhooks can also
// purge the `articles` tag on publish/unpublish (see README).
export const revalidate = 60;

export default async function HomePage() {
  let articles: Array<{ id: string; slug: string; title: string }> = [];
  try {
    // The Delivery/items API only returns items currently inside their
    // Publish_Window — scheduled-future and unpublished items are excluded
    // server-side, so the frontend never has to reason about timing.
    const res = await lumi.items('articles').list({ status: 'published', limit: 50 });
    articles = res.data as typeof articles;
  } catch (err) {
    console.error('Failed to load articles:', err);
  }

  return (
    <main style={{ maxWidth: 700, margin: '0 auto', padding: '60px 20px', fontFamily: 'system-ui' }}>
      <h1>Articles</h1>
      <p style={{ color: '#666' }}>
        Public content only. Sensitive (pii/phi) fields are never delivered here.
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {articles.map((a) => (
          <li key={a.id} style={{ margin: '16px 0' }}>
            <Link href={`/articles/${a.slug}`}>{a.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
