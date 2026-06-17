import Link from 'next/link';
import { notFound } from 'next/navigation';
import { lumi, type Post } from '@/lib/lumi';

interface PostPageProps {
  params: {
    id: string;
  };
}

// GraphQL query for a single post by id (`posts_by_id` is generated per tenant).
const GET_POST = /* GraphQL */ `
  query GetPost($id: ID!) {
    posts_by_id(id: $id) {
      id
      title
      content
      author
      status
      createdAt
    }
  }
`;

// Lightweight query used only to collect ids for static generation.
const LIST_POST_IDS = /* GraphQL */ `
  query ListPostIds($limit: Int) {
    posts(status: "published", limit: $limit) {
      id
    }
  }
`;

// Generate static params for all published posts for static generation (SSG)
export async function generateStaticParams() {
  try {
    const data = await lumi.query<{ posts: Pick<Post, 'id'>[] }>(LIST_POST_IDS, {
      limit: 100,
    });
    return data.posts.map((post) => ({ id: post.id }));
  } catch (err) {
    console.error('Failed to generate static params for posts:', err);
    return [];
  }
}

export default async function PostDetailPage({ params }: PostPageProps) {
  let post: Post | null = null;

  try {
    // Fetch a single post detail via GraphQL
    const data = await lumi.query<{ posts_by_id: Post | null }>(GET_POST, {
      id: params.id,
    });
    post = data.posts_by_id;
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
          <span>{new Date(post.createdAt || Date.now()).toLocaleDateString()}</span>
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
