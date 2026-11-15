// In a SvelteKit app this is `src/routes/+page.server.ts`, typed by `./$types`.
import { readItems } from '@lumibase/sdk';

export async function load({ locals }: { locals: App.Locals }) {
  const posts = await locals.lumi.request(readItems('posts', { limit: 10, sort: ['-created_at'] }));
  // Fully typed from the generated schema: `title` is `string | null`.
  const firstTitle: string | null | undefined = posts.data[0]?.data.title;
  return { posts, firstTitle };
}
