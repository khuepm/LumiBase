import { cookies, draftMode } from 'next/headers';
import { redirect } from 'next/navigation';
import { PREVIEW_COOKIE, previewFetch } from '@/lib/preview';

/**
 * Entry point of a Studio preview: `/api/preview?token=…&id=…`.
 * Set the `posts` collection's Preview URL (Studio → Data model) to
 * `http://localhost:3000/api/preview?token={token}&id={id}`.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const id = searchParams.get('id');
  if (!token || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return new Response('Missing token or id', { status: 400 });
  }
  // Validate server-side: the CMS answers 401 for an expired, revoked or
  // foreign-site token.
  const check = await previewFetch(token);
  if (!check.ok) return new Response('Preview link expired', { status: 401 });

  (await draftMode()).enable();
  (await cookies()).set(PREVIEW_COOKIE, token, {
    httpOnly: true,
    sameSite: 'none', // the page is framed by the Studio (another site)
    secure: true,
    path: '/',
    maxAge: 60 * 60,
  });
  redirect(`/posts/${id}`);
}
