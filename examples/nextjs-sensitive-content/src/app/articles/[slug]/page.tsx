import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toNextMetadata, jsonLdScript } from '@lumibase/sdk';
import { lumi } from '@/lib/lumi';

export const revalidate = 60;

interface Props {
  params: { slug: string };
}

async function fetchArticle(slug: string) {
  try {
    const res = await lumi.items('articles').list({
      status: 'published',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter: { slug: { _eq: slug } } as any,
      limit: 1,
    });
    return (res.data?.[0] as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

// Map the Delivery API's `_seo` block straight into Next.js metadata (Req 14.4).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = await fetchArticle(params.slug);
  if (!article) return {};
  return toNextMetadata(article) as Metadata;
}

export default async function ArticlePage({ params }: Props) {
  const article = await fetchArticle(params.slug);
  if (!article) return notFound();

  const jsonLd = jsonLdScript(article);

  return (
    <article style={{ maxWidth: 700, margin: '0 auto', padding: '60px 20px', fontFamily: 'system-ui' }}>
      {/* schema.org JSON-LD emitted from the `_seo` block. */}
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      ) : null}

      <h1>{String(article.title ?? '')}</h1>

      {/* Only public fields are rendered. pii/phi fields are not part of the
          public schema and would arrive masked anyway without a
          `read_decrypted` token — which must never live in this frontend. */}
      <div style={{ lineHeight: 1.8 }}>{String(article.body ?? '')}</div>
    </article>
  );
}
