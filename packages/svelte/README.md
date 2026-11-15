# `@lumibase/svelte`

Svelte 4/5 stores and actions, plus SvelteKit server helpers, for [LumiBase](https://lumibase.dev). A thin, typed layer over [`@lumibase/sdk`](../sdk).

```bash
pnpm add @lumibase/svelte @lumibase/sdk svelte
```

```ts
import { defineLumiStores } from '@lumibase/svelte';
const lumi = defineLumiStores(client, { realtime });
const posts = lumi.items('posts', { limit: 10 }, { live: true }); // $posts.data?.data

// src/hooks.server.ts
import { createLumiHandle } from '@lumibase/svelte/kit';
export const handle = createLumiHandle(() => ({ url, siteId, token: env.LUMIBASE_TOKEN }));
```

SSR-safe. A store's realtime subscription ends when its last subscriber leaves. Full guide: [docs/en/sdk/frameworks.md](../../docs/en/sdk/frameworks.md).
