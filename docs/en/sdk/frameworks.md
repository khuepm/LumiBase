---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T18:17:20.023Z
contentHash: 6655f6a1e5149cef
codeVerified: 2026-11-15T18:17:20.023Z
codeVerifiedHash: 6655f6a1e5149cef
codeVerifiedClaims: 18
---

# Framework adapters: Vue/Nuxt, Svelte/SvelteKit, Astro

> Thin, typed layers over `@lumibase/sdk` for Vue 3 and Nuxt, Svelte and SvelteKit, and Astro.

## Overview

Each adapter wraps the SDK. Requests go through the SDK commands (`readItems`, `readItem`) on a `LumiClient`, and realtime goes through `RealtimeClient`. The adapter adds the framework's reactivity and lifecycle on top. No adapter has its own HTTP code, so authentication, `X-Lumi-Site`, silent token refresh and `LumiError` behave as described in [the JavaScript SDK](./javascript.md).

| Package | For | Entry points |
| --- | --- | --- |
| `@lumibase/vue` | Vue ≥ 3.3, Nuxt 3.10+ / 4 | `@lumibase/vue`, `@lumibase/vue/nuxt` |
| `@lumibase/svelte` | Svelte 4 / 5, SvelteKit 2 / 3 | `@lumibase/svelte`, `@lumibase/svelte/kit` |
| `@lumibase/astro` | Astro 5 / 6 / 7 | `@lumibase/astro`, `@lumibase/astro/loader`, `@lumibase/astro/client` |

Source: `packages/vue/src/composables.ts`, `packages/vue/src/nuxt.ts`, `packages/svelte/src/index.ts`, `packages/svelte/src/kit.ts`, `packages/astro/src/index.ts`, `packages/astro/src/loader.ts`, `packages/astro/src/client.ts`, and the shared connection counter in `packages/sdk/src/realtime/retain.ts`.

`vue` and `svelte` are peer dependencies. Nuxt, SvelteKit and Astro are listed as optional peers with no version range, so a package manager never installs them for you. The adapters type themselves against the small parts of those APIs they use. The ranges in the table are the versions they were checked against.

All three adapters follow the same rules:

- **SSR-safe.** Importing an adapter touches no `window` or `document`. Realtime never connects during a server render.
- **Cleanup is automatic.** A subscription lives as long as the component, store subscriber or page that created it. All of them share one connection per `RealtimeClient` through `retainRealtime()` from the SDK. The first holder connects it and the last one to leave disconnects it.
- **Typed from your schema.** Pass the output of `lumibase types` through `SchemaOf`. Collection names are then checked and `row.data` is typed:

```ts
import { createLumiClient, type SchemaOf } from '@lumibase/sdk';
import type { LumibaseSchema } from './lumibase-types';

export const client = createLumiClient<SchemaOf<LumibaseSchema>>({ url, siteId, token });
```

`SchemaOf` exists because typegen emits `interface`s. An interface has no implicit index signature, so it does not satisfy the client's `DefaultSchema` constraint on its own.

- **Tokens.** A token used in the browser ships to every visitor, so it must be read-only. Admin or write tokens stay in server-only config, as each section below shows.

## Vue 3

```ts
import { createApp } from 'vue';
import { createLumiClient, RealtimeClient } from '@lumibase/sdk';
import { createLumiBase, defineLumiComposables } from '@lumibase/vue';

const client = createLumiClient<Schema>({ url, siteId, token });
const realtime = new RealtimeClient({ baseUrl: url, siteId, token }); // not connected yet

createApp(App).use(createLumiBase({ client, realtime })).mount('#app');

export const { useItems, useItem } = defineLumiComposables<Schema>();
```

| Composable | Returns | Lifecycle |
| --- | --- | --- |
| `useItems(collection, params?, options?)` | `{ data, items, error, pending, refresh }` | `params` may be a ref or getter, and a change re-fetches. `live: true` re-fetches on realtime events while mounted. Bursts collapse into one follow-up fetch. |
| `useItem(collection, id, options?)` | `{ data, error, pending, refresh }` | With `live: true` it re-fetches only on events for its own id. |
| `useRealtime(collection, handler, options?)` | `{ stop }` | Subscribes on mount and unsubscribes on unmount, or on scope dispose. |
| `usePresence(target)` | `{ users, stop }` | Announces presence while mounted and clears it on unmount. |
| `useLumiClient()` / `useLumiBase()` | the injected client / context | — |

In a Vue SSR render, the first fetch of `useItems` / `useItem` runs in `onServerPrefetch`, so the HTML contains the data. Pass `initialData` to hydrate from data you already have and skip the first fetch.

### Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@lumibase/vue/nuxt'],
  lumibase: { url: 'https://cms.example.com', siteId: 'site_123', realtime: true },
});
```

The module puts `url`, `siteId`, `publicToken` and `realtime` in `runtimeConfig.public.lumibase`. It also adds an empty private `runtimeConfig.lumibase.token`, which you fill with `NUXT_LUMIBASE_TOKEN`. Nuxt never sends private runtime config to the browser. The runtime plugin uses the private token on the server and only `publicToken` in the browser. It builds the `RealtimeClient` in the browser only, and exposes `$lumi` and `$lumiRealtime`. The module also registers auto-imports for the composables and for `readItems` / `readItem`. Use `useAsyncData` for SSR payload transfer:

```vue
<script setup lang="ts">
const lumi = useLumiClient();
const { data } = await useAsyncData('posts', () => lumi.request(readItems('posts', { limit: 10 })));
const { items } = useItems('posts', { limit: 10 }, { initialData: data.value, live: true });
</script>
```

The module is a plain `(options, nuxt)` function without `@nuxt/kit`, so the adapter has no build-time dependency tree.

## Svelte and SvelteKit

The stores work in Svelte 4 and 5. In a Svelte 5 runes component, wrap a store in `fromStore()` from `svelte/store` and read `.current`.

```ts
import { defineLumiStores, presenceStore } from '@lumibase/svelte';

export const lumi = defineLumiStores(client, { realtime });
const posts = lumi.items('posts', { limit: 10 }, { live: true }); // $posts.data?.data
```

| Export | What it is | Lifecycle |
| --- | --- | --- |
| `itemsStore` / `itemStore` (or `lumi.items` / `lumi.item`) | `Readable<{ data, error, loading }>` plus `refresh()` | Fetches on the first subscriber. `live` attaches realtime in the browser only, and the last unsubscribe (component destroy) detaches it. |
| `realtimeStore(realtime, collection)` | the latest `RealtimeEvent` | Subscribes and unsubscribes with its subscribers. Browser only. |
| `presenceStore(realtime, target)` | peers on the target | Announces presence while subscribed and clears it afterwards. |
| `use:lumiPresence={{ realtime, collection, itemId }}` | action | Announces, updates, and clears presence on destroy. |
| `setLumiContext` / `getLumiClient` | context helpers | `setLumiContext` returns `destroy()` for extension cleanup. |

### SvelteKit server helpers

```ts
// src/hooks.server.ts
import { env } from '$env/dynamic/private';
import { createLumiHandle } from '@lumibase/svelte/kit';

export const handle = createLumiHandle(() => ({
  url: env.LUMIBASE_URL, siteId: env.LUMIBASE_SITE_ID, token: env.LUMIBASE_TOKEN,
}));
```

`createLumiHandle` puts a per-request client on `event.locals.lumi`, built with SvelteKit's `event.fetch`. Configuration is a function, so it reads the private env at request time and the token never lands in a bundle. In `load`, call `locals.lumi.request(readItems(...))` and pass the result to the page as `initialData`. Use `lumiForEvent(event, config)` when you need a client without the hook. Declare `lumi` on `App.Locals` in `src/app.d.ts` to type it.

## Astro

```js
// astro.config.mjs
import lumibase from '@lumibase/astro';
export default defineConfig({
  integrations: [lumibase({ url: 'https://cms.example.com', siteId: 'site_123' })],
});
```

The integration adds a server-only virtual module `virtual:lumibase`. It exports `lumi` (a configured client), `createClient(token?)` and `config`. Its types are injected for Astro ≥ 5. The token is never an integration option. The module reads `LUMIBASE_TOKEN` (or the variable named by `tokenEnv`) with `getSecret()` from `astro:env/server` when the server runs, so an SSR build never carries the build machine's token in `dist/server` and a token rotation needs no rebuild. If browser code imports the module, the build fails, so the token cannot be bundled by mistake.

```astro
---
import { lumi } from 'virtual:lumibase';
import { readItems } from '@lumibase/sdk';
const posts = await lumi.request(readItems('posts', { limit: 10 }));
---
```

### Content loader

```ts
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { lumibaseLoader } from '@lumibase/astro/loader';

export const collections = {
  posts: defineCollection({
    loader: lumibaseLoader({ client, collection: 'posts', params: { status: 'published' } }),
  }),
};
```

The loader pages through `readItems` (default `pageSize` 100) and stores each full row under its id. It clears the store only after every page has arrived, so a failed fetch keeps the last good content.

### Realtime in client scripts

`watchCollection(realtime, collection, handler)` from `@lumibase/astro/client` subscribes from a `<script>`. It cleans up on the returned stop, on `pagehide` and on `astro:before-swap`, because view transitions keep the document. Inside framework islands, use the Vue or Svelte adapter instead.

## Extension point (visual editing)

Visual editing (V03, `@lumibase/visual-editing`) does not exist yet. The adapters do not implement it. They leave one seam for it, or for any other client-side add-on:

- Vue: `createLumiBase({ client, extensions: [{ name, setup(ctx) { return cleanup } }] })`. `setup` runs in the browser when the plugin is installed. `cleanup` runs when the app unmounts.
- Svelte: `setLumiContext({ client, extensions })`. `setup` runs in the browser, and the returned `destroy()` runs the cleanups.
- Astro: `lumibase({ …, pageScripts: ['some-module'] })` injects `import 'some-module'` on every page.

## Smoke examples

`examples/vue-adapter`, `examples/svelte-adapter` and `examples/astro-adapter` are workspace members. CI type-checks them against the adapters' source with `pnpm -r typecheck`, so a breaking change to an adapter's typed API fails CI.
