import { createLumiClient, legacyRest } from '@lumibase/sdk';

// 1. Define the schema of the collections you created in LumiBase Studio
// or use the output of `pnpm @lumibase/sdk typegen` directly!
export interface BlogSchema {
  posts: {
    id: string;
    title: string;
    content: string;
    author: string;
    status: 'draft' | 'published';
    created_at: string;
  };
}

const url = process.env.LUMIBASE_URL || 'http://127.0.0.1:1989';
const token = process.env.LUMIBASE_TOKEN || '';
const siteId = process.env.LUMIBASE_SITE_ID || '';

if (!token || !siteId) {
  console.warn(
    '[LumiBase] Missing LUMIBASE_TOKEN or LUMIBASE_SITE_ID environment variables. Fetching will fail.'
  );
}

// 2. Initialize the type-safe client
const baseClient = createLumiClient<BlogSchema>({
  url,
  token,
  siteId,
});

// 3. Attach the legacy REST methods for full CRUD capabilities
export const lumi = baseClient.with(legacyRest());
