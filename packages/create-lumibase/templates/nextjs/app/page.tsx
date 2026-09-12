import { getPosts, isConfigured, type Post } from '../lib/lumibase';

// Always hit the CMS, so a publish in Studio shows up on the next reload
// instead of being served from a build-time snapshot.
export const dynamic = 'force-dynamic';

function Setup() {
  return (
    <main className="wrap">
      <h1>Almost there</h1>
      <p>This site is not connected to a LumiBase instance yet.</p>
      <ol>
        <li>
          <code>cp .env.example .env</code>
        </li>
        <li>
          <code>npm run cms:up</code> — starts the CMS and Studio
        </li>
        <li>
          <code>npm run cms:logs</code> — copy the <code>SETUP_TOKEN</code> into{' '}
          <code>.env</code>
        </li>
        <li>
          <code>npm run cms:bootstrap</code> then <code>npm run cms:seed</code>
        </li>
      </ol>
    </main>
  );
}

export default async function Home() {
  if (!isConfigured) return <Setup />;

  let posts: Post[] = [];
  let error: string | null = null;

  try {
    posts = await getPosts();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (error) {
    return (
      <main className="wrap">
        <h1>Could not reach the CMS</h1>
        <pre className="error">{error}</pre>
        <p>
          Is it running? Try <code>npm run cms:up</code>, then{' '}
          <code>npm run cms:logs</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="wrap">
      <header>
        <h1>My LumiBase site</h1>
        <p className="lede">
          Rendered by Next.js, served by LumiBase. Edit a post in Studio, publish
          it, and reload this page.
        </p>
      </header>

      {posts.length === 0 ? (
        <p className="empty">
          No published posts yet. Run <code>npm run cms:seed</code>, or write one
          in Studio.
        </p>
      ) : (
        <ul className="posts">
          {posts.map((post) => (
            <li key={post.id}>
              <h2>{post.data.title ?? 'Untitled'}</h2>
              {post.data.slug ? <p className="slug">/{post.data.slug}</p> : null}
              {post.data.body ? <p>{post.data.body}</p> : null}
            </li>
          ))}
        </ul>
      )}

      <footer>
        <p>
          {posts.length} published post{posts.length === 1 ? '' : 's'}. Drafts are
          never returned here — the public key is restricted to published rows.
        </p>
      </footer>
    </main>
  );
}
