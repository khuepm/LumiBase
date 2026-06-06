import Link from 'next/link';
import { lumi } from '@/lib/lumi';

export const revalidate = 60; // Revalidate every 60 seconds (ISR)

export default async function HomePage() {
  let posts: any[] = [];
  let errorMsg = '';

  try {
    // Fetch only 'published' status posts
    const response = await lumi.items('posts').list({
      status: 'published',
      sort: ['-created_at'],
    });
    posts = response.data;
  } catch (err: any) {
    errorMsg = err.message || 'Failed to fetch posts from LumiBase';
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>LumiBase Next.js Blog</h1>
        <p style={styles.subtitle}>
          Example app displaying posts fetched using the Type-Safe JS SDK.
        </p>
      </header>

      {errorMsg ? (
        <div style={styles.errorCard}>
          <p><strong>Error:</strong> {errorMsg}</p>
          <p style={styles.errorHint}>Please ensure your LumiBase server is running and configured correctly.</p>
        </div>
      ) : posts.length === 0 ? (
        <p style={styles.noPosts}>No published posts found. Go to LumiBase Studio to add some!</p>
      ) : (
        <div style={styles.grid}>
          {posts.map((post) => (
            <article key={post.id} style={styles.card}>
              <h2 style={styles.cardTitle}>{post.title}</h2>
              <p style={styles.cardMeta}>
                By {post.author} • {new Date(post.created_at || Date.now()).toLocaleDateString()}
              </p>
              <p style={styles.cardExcerpt}>
                {post.content.length > 150
                  ? `${post.content.slice(0, 150)}...`
                  : post.content}
              </p>
              <Link href={`/posts/${post.id}`} style={styles.cardLink}>
                Read More →
              </Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

const styles = {
  main: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '40px 20px',
    fontFamily: 'Inter, system-ui, sans-serif',
    color: '#333',
    backgroundColor: '#fff',
    minHeight: '100vh',
  },
  header: {
    textAlign: 'center' as const,
    marginBottom: '40px',
    borderBottom: '1px solid #eaeaea',
    paddingBottom: '20px',
  },
  title: {
    fontSize: '2.5rem',
    fontWeight: 800,
    color: '#111',
    letterSpacing: '-0.025em',
    margin: '0 0 10px 0',
  },
  subtitle: {
    fontSize: '1.1rem',
    color: '#666',
    margin: 0,
  },
  grid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '30px',
  },
  card: {
    border: '1px solid #eaeaea',
    borderRadius: '12px',
    padding: '24px',
    transition: 'transform 0.2s, box-shadow 0.2s',
    boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
  },
  cardTitle: {
    fontSize: '1.5rem',
    fontWeight: 700,
    margin: '0 0 8px 0',
    color: '#111',
  },
  cardMeta: {
    fontSize: '0.875rem',
    color: '#888',
    margin: '0 0 16px 0',
  },
  cardExcerpt: {
    fontSize: '1rem',
    color: '#444',
    lineHeight: 1.6,
    margin: '0 0 20px 0',
  },
  cardLink: {
    display: 'inline-block',
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#0070f3',
    textDecoration: 'none',
  },
  noPosts: {
    textAlign: 'center' as const,
    color: '#666',
    fontSize: '1.1rem',
    marginTop: '40px',
  },
  errorCard: {
    backgroundColor: '#fff5f5',
    border: '1px solid #ffc9c9',
    borderRadius: '8px',
    padding: '20px',
    color: '#c92a2a',
    marginBottom: '20px',
  },
  errorHint: {
    fontSize: '0.875rem',
    color: '#862e2e',
    margin: '8px 0 0 0',
  },
};
