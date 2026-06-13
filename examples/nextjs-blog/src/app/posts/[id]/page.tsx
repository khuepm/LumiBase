import Link from 'next/link';
import { notFound } from 'next/navigation';
import { lumi } from '@/lib/lumi';

interface PostPageProps {
  params: {
    id: string;
  };
}

// Generate static params for all published posts for static generation (SSG)
export async function generateStaticParams() {
  try {
    const response = await lumi.items('posts').list({
      status: 'published',
      limit: 100,
    });
    return response.data.map((post: any) => ({
      id: post.id,
    }));
  } catch (err) {
    console.error('Failed to generate static params for posts:', err);
    return [];
  }
}

export default async function PostDetailPage({ params }: PostPageProps) {
  let post: any = null;

  try {
    // Fetch a single post detail from the collection
    post = await lumi.items('posts').detail(params.id);
  } catch (err) {
    // If not found or API error, fall back to 404
    return notFound();
  }

  if (!post || post.status !== 'published') {
    return notFound();
  }

  return (
    <article style={styles.main}>
      <Link href="/" style={styles.backLink}>
        ← Back to all posts
      </Link>
      
      <header style={styles.header}>
        <h1 style={styles.title}>{post.title}</h1>
        <div style={styles.meta}>
          <span>By <strong>{post.author}</strong></span>
          <span>•</span>
          <span>{new Date(post.created_at || Date.now()).toLocaleDateString()}</span>
        </div>
      </header>

      <div style={styles.content}>
        {post.content.split('\n\n').map((para: string, idx: number) => (
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
