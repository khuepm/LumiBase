import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LumiError } from 'lumibase';
import { lumi, type Post } from '@/lib/lumi';

interface PostPageProps {
  params: Promise<{ id: string }>;
}

// Revalidate on the same cadence as the list page. Without this the route
// would be cached indefinitely: `generateStaticParams` alone pre-renders each
// post once at build time and never refreshes it, so edits made in Studio
// would never reach the detail page.
export const revalidate = 60;

// A post published after the build is not in `generateStaticParams`. Leaving
// `dynamicParams` at its default (`true`) lets Next render it on demand the
// first time it is requested, then cache it like the rest.
export const dynamicParams = true;

// Pre-render a page per published post. The reader credential cannot see
// drafts, so this list is exactly the public set.
export async function generateStaticParams() {
  try {
    const { data } = await lumi.items('posts').list({
      status: 'published',
      fields: ['id'],
      limit: 100,
    });
    return data.map((post) => ({ id: post.id }));
  } catch (err) {
    console.error('Failed to generate static params for posts:', err);
    return [];
  }
}

export default async function PostDetailPage({ params }: PostPageProps) {
  const { id } = await params;
  let post: Post;

  try {
    // A draft (or unknown id) answers 404 for this credential — the SDK
    // turns every non-2xx into a `LumiError` carrying the status.
    const res = await lumi.items('posts').detail(id);
    post = res.data;
  } catch (err) {
    if (err instanceof LumiError && err.status === 404) return notFound();
    throw err;
  }

  if (post.status !== 'published') {
    return notFound();
  }

  return (
    <article style={styles.main}>
      <Link href="/" style={styles.backLink}>
        ← Back to all posts
      </Link>
      
      <header style={styles.header}>
        <h1 style={styles.title}>{post.data.title}</h1>
        <div style={styles.meta}>
          <span>By <strong>{post.data.author}</strong></span>
          <span>•</span>
          <span>{new Date(post.createdAt).toLocaleDateString()}</span>
        </div>
      </header>

      <div style={styles.content}>
        {post.data.body.split('\n\n').map((para: string, idx: number) => (
          <p key={idx} style={styles.paragraph}>
            {para}
          </p>
        ))}
      </div>
    </article>
  );
}

const styles = {
  main: {
    maxWidth: '700px',
    margin: '0 auto',
    padding: '60px 20px',
    fontFamily: 'Inter, system-ui, sans-serif',
    color: '#333',
    lineHeight: 1.8,
  },
  backLink: {
    display: 'inline-block',
    marginBottom: '30px',
    fontSize: '0.95rem',
    color: '#666',
    textDecoration: 'none',
  },
  header: {
    marginBottom: '40px',
    borderBottom: '1px solid #eaeaea',
    paddingBottom: '24px',
  },
  title: {
    fontSize: '2.5rem',
    fontWeight: 800,
    color: '#111',
    lineHeight: 1.25,
    letterSpacing: '-0.025em',
    margin: '0 0 16px 0',
  },
  meta: {
    display: 'flex',
    gap: '12px',
    fontSize: '0.9rem',
    color: '#888',
  },
  content: {
    fontSize: '1.1rem',
    color: '#222',
  },
  paragraph: {
    marginBottom: '24px',
  },
};
