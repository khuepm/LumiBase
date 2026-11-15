---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T18:17:20.023Z
translatedFrom: en
sourceHash: 6655f6a1e5149cef
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T18:17:20.023Z
codeVerifiedHash: 6655f6a1e5149cef
codeVerifiedClaims: 18
---

# Adapter cho framework: Vue/Nuxt, Svelte/SvelteKit, Astro

> Các lớp mỏng, có type, dựng trên `@lumibase/sdk` cho Vue 3 và Nuxt, Svelte và SvelteKit, và Astro.

## Tổng quan

Mỗi adapter bọc SDK. Request đi qua các lệnh của SDK (`readItems`, `readItem`) trên một `LumiClient`, còn realtime đi qua `RealtimeClient`. Adapter chỉ thêm reactivity và vòng đời của framework lên trên. Không adapter nào có mã HTTP riêng, nên xác thực, `X-Lumi-Site`, làm mới token ngầm và `LumiError` hoạt động như mô tả trong [JavaScript SDK](./javascript.md).

| Gói | Dùng cho | Entry point |
| --- | --- | --- |
| `@lumibase/vue` | Vue ≥ 3.3, Nuxt 3.10+ / 4 | `@lumibase/vue`, `@lumibase/vue/nuxt` |
| `@lumibase/svelte` | Svelte 4 / 5, SvelteKit 2 / 3 | `@lumibase/svelte`, `@lumibase/svelte/kit` |
| `@lumibase/astro` | Astro 5 / 6 / 7 | `@lumibase/astro`, `@lumibase/astro/loader`, `@lumibase/astro/client` |

Mã nguồn: `packages/vue/src/composables.ts`, `packages/vue/src/nuxt.ts`, `packages/svelte/src/index.ts`, `packages/svelte/src/kit.ts`, `packages/astro/src/index.ts`, `packages/astro/src/loader.ts`, `packages/astro/src/client.ts`, và bộ đếm kết nối dùng chung trong `packages/sdk/src/realtime/retain.ts`.

`vue` và `svelte` là peer dependency. Nuxt, SvelteKit và Astro được khai là peer tuỳ chọn, không kèm dải phiên bản, nên trình quản lý gói không bao giờ tự cài chúng thay bạn. Adapter tự khai type theo phần nhỏ của các API đó mà nó dùng. Dải phiên bản trong bảng là các phiên bản đã được kiểm tra.

Cả ba adapter theo cùng các quy tắc:

- **An toàn với SSR.** Import adapter không đụng tới `window` hay `document`. Realtime không bao giờ kết nối khi render trên server.
- **Dọn dẹp tự động.** Một subscription sống bằng đúng thời gian sống của component, subscriber của store hoặc trang đã tạo ra nó. Tất cả dùng chung một kết nối cho mỗi `RealtimeClient` thông qua `retainRealtime()` của SDK. Bên giữ đầu tiên mở kết nối, bên cuối cùng rời đi thì đóng nó.
- **Type theo schema của bạn.** Đưa output của `lumibase types` qua `SchemaOf`. Khi đó tên collection được kiểm tra và `row.data` có type:

```ts
import { createLumiClient, type SchemaOf } from '@lumibase/sdk';
import type { LumibaseSchema } from './lumibase-types';

export const client = createLumiClient<SchemaOf<LumibaseSchema>>({ url, siteId, token });
```

`SchemaOf` tồn tại vì typegen sinh ra các `interface`. Interface không có index signature ngầm định, nên tự nó không thoả ràng buộc `DefaultSchema` của client.

- **Token.** Token dùng trong trình duyệt sẽ tới tay mọi người truy cập, nên nó phải là token chỉ đọc. Token admin hoặc token ghi nằm trong cấu hình chỉ có ở server, như từng phần dưới đây trình bày.

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

| Composable | Trả về | Vòng đời |
| --- | --- | --- |
| `useItems(collection, params?, options?)` | `{ data, items, error, pending, refresh }` | `params` có thể là ref hoặc getter, đổi giá trị thì fetch lại. `live: true` fetch lại khi có sự kiện realtime trong lúc đang mount. Một loạt sự kiện dồn lại thành một lần fetch tiếp theo. |
| `useItem(collection, id, options?)` | `{ data, error, pending, refresh }` | Với `live: true` chỉ fetch lại khi có sự kiện cho đúng id của nó. |
| `useRealtime(collection, handler, options?)` | `{ stop }` | Subscribe khi mount và huỷ khi unmount, hoặc khi scope bị dispose. |
| `usePresence(target)` | `{ users, stop }` | Báo presence khi đang mount và xoá khi unmount. |
| `useLumiClient()` / `useLumiBase()` | client / context đã inject | — |

Khi render SSR bằng Vue, lần fetch đầu của `useItems` / `useItem` chạy trong `onServerPrefetch`, nên HTML đã chứa dữ liệu. Truyền `initialData` để hydrate từ dữ liệu bạn đã có và bỏ qua lần fetch đầu.

### Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@lumibase/vue/nuxt'],
  lumibase: { url: 'https://cms.example.com', siteId: 'site_123', realtime: true },
});
```

Module đặt `url`, `siteId`, `publicToken` và `realtime` vào `runtimeConfig.public.lumibase`. Nó cũng thêm một `runtimeConfig.lumibase.token` riêng tư để trống, bạn điền bằng `NUXT_LUMIBASE_TOKEN`. Nuxt không bao giờ gửi runtime config riêng tư xuống trình duyệt. Runtime plugin dùng token riêng tư trên server và chỉ dùng `publicToken` trong trình duyệt. Nó chỉ tạo `RealtimeClient` trong trình duyệt, và cung cấp `$lumi` cùng `$lumiRealtime`. Module cũng đăng ký auto-import cho các composable và cho `readItems` / `readItem`. Dùng `useAsyncData` để chuyển payload SSR:

```vue
<script setup lang="ts">
const lumi = useLumiClient();
const { data } = await useAsyncData('posts', () => lumi.request(readItems('posts', { limit: 10 })));
const { items } = useItems('posts', { limit: 10 }, { initialData: data.value, live: true });
</script>
```

Module là một hàm `(options, nuxt)` thuần, không dùng `@nuxt/kit`, nên adapter không kéo theo cây phụ thuộc lúc build.

## Svelte và SvelteKit

Các store chạy được trên Svelte 4 và 5. Trong component dùng runes của Svelte 5, bọc store bằng `fromStore()` từ `svelte/store` rồi đọc `.current`.

```ts
import { defineLumiStores, presenceStore } from '@lumibase/svelte';

export const lumi = defineLumiStores(client, { realtime });
const posts = lumi.items('posts', { limit: 10 }, { live: true }); // $posts.data?.data
```

| Export | Là gì | Vòng đời |
| --- | --- | --- |
| `itemsStore` / `itemStore` (hoặc `lumi.items` / `lumi.item`) | `Readable<{ data, error, loading }>` kèm `refresh()` | Fetch khi có subscriber đầu tiên. `live` chỉ gắn realtime trong trình duyệt, và lần huỷ subscribe cuối (component bị destroy) gỡ nó ra. |
| `realtimeStore(realtime, collection)` | `RealtimeEvent` mới nhất | Subscribe và huỷ cùng các subscriber của nó. Chỉ trong trình duyệt. |
| `presenceStore(realtime, target)` | những người đang có mặt trên target | Báo presence khi đang được subscribe và xoá sau đó. |
| `use:lumiPresence={{ realtime, collection, itemId }}` | action | Báo, cập nhật, và xoá presence khi destroy. |
| `setLumiContext` / `getLumiClient` | helper cho context | `setLumiContext` trả về `destroy()` để dọn extension. |

### Helper phía server cho SvelteKit

```ts
// src/hooks.server.ts
import { env } from '$env/dynamic/private';
import { createLumiHandle } from '@lumibase/svelte/kit';

export const handle = createLumiHandle(() => ({
  url: env.LUMIBASE_URL, siteId: env.LUMIBASE_SITE_ID, token: env.LUMIBASE_TOKEN,
}));
```

`createLumiHandle` đặt một client cho từng request vào `event.locals.lumi`, tạo bằng `event.fetch` của SvelteKit. Cấu hình là một hàm, nên nó đọc env riêng tư lúc có request và token không bao giờ nằm trong bundle. Trong `load`, gọi `locals.lumi.request(readItems(...))` rồi truyền kết quả cho trang làm `initialData`. Dùng `lumiForEvent(event, config)` khi cần client mà không qua hook. Khai `lumi` trên `App.Locals` trong `src/app.d.ts` để có type.

## Astro

```js
// astro.config.mjs
import lumibase from '@lumibase/astro';
export default defineConfig({
  integrations: [lumibase({ url: 'https://cms.example.com', siteId: 'site_123' })],
});
```

Integration thêm một virtual module chỉ dùng ở server là `virtual:lumibase`. Nó export `lumi` (client đã cấu hình), `createClient(token?)` và `config`. Type của nó được inject cho Astro ≥ 5. Token không bao giờ là option của integration. Module đọc `LUMIBASE_TOKEN` (hoặc biến có tên trong `tokenEnv`) bằng `getSecret()` từ `astro:env/server` khi server chạy, nên bản build SSR không bao giờ mang token của máy build trong `dist/server` và đổi token không cần build lại. Nếu mã trình duyệt import module này thì build thất bại, nên token không thể vô tình bị đóng vào bundle.

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

Loader lật trang qua `readItems` (`pageSize` mặc định 100) và lưu từng bản ghi đầy đủ theo id. Nó chỉ xoá store sau khi đã nhận đủ mọi trang, nên khi fetch lỗi thì nội dung tốt gần nhất vẫn được giữ.

### Realtime trong client script

`watchCollection(realtime, collection, handler)` từ `@lumibase/astro/client` subscribe từ một `<script>`. Nó tự dọn khi gọi hàm stop trả về, khi có `pagehide` và khi có `astro:before-swap`, vì view transition giữ nguyên document. Bên trong framework island, hãy dùng adapter Vue hoặc Svelte.

## Điểm mở rộng (visual editing)

Visual editing (V03, `@lumibase/visual-editing`) chưa tồn tại. Các adapter không hiện thực nó. Chúng chừa một chỗ nối cho nó, hoặc cho bất kỳ phần bổ sung phía client nào:

- Vue: `createLumiBase({ client, extensions: [{ name, setup(ctx) { return cleanup } }] })`. `setup` chạy trong trình duyệt khi plugin được cài. `cleanup` chạy khi app unmount.
- Svelte: `setLumiContext({ client, extensions })`. `setup` chạy trong trình duyệt, và `destroy()` được trả về sẽ chạy các hàm dọn.
- Astro: `lumibase({ …, pageScripts: ['some-module'] })` inject `import 'some-module'` vào mọi trang.

## Ví dụ smoke

`examples/vue-adapter`, `examples/svelte-adapter` và `examples/astro-adapter` là thành viên workspace. CI type-check chúng theo mã nguồn của adapter bằng `pnpm -r typecheck`, nên thay đổi phá vỡ API có type của một adapter sẽ làm CI thất bại.
