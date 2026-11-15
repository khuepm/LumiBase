# `@lumibase/vue`

Vue 3 composables and a Nuxt 3/4 module for [LumiBase](https://lumibase.dev), a thin, typed layer over [`@lumibase/sdk`](../sdk).

```bash
pnpm add @lumibase/vue @lumibase/sdk vue
```

```ts
import { createLumiClient, RealtimeClient } from '@lumibase/sdk';
import { createLumiBase, useItems } from '@lumibase/vue';

app.use(createLumiBase({ client: createLumiClient({ url, siteId, token }), realtime: new RealtimeClient({ baseUrl: url, siteId, token }) }));

// in a component
const { items, pending } = useItems('posts', { limit: 10 }, { live: true });
```

Nuxt: `modules: ['@lumibase/vue/nuxt']`, with `lumibase: { url, siteId }` in `nuxt.config`. The server token goes in `NUXT_LUMIBASE_TOKEN`.

SSR-safe. Realtime subscriptions are cleaned up on unmount. Full guide: [docs/en/sdk/frameworks.md](../../docs/en/sdk/frameworks.md).
