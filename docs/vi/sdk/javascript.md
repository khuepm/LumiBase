---
version: 1
lastUpdated: 2026-07-28T11:42:32.541Z
sourceLang: en
translatedFrom: en
sourceHash: f4cef639eade1ebc
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:42:32.541Z
codeVerifiedHash: f4cef639eade1ebc
codeVerifiedClaims: 4
---

# LumiBase JavaScript SDK

> **Package:** `@lumibase/sdk`
>
> Một REST client có type, kết hợp được (composable), cho LumiBase, cộng với realtime subscription và việc sinh type TypeScript.

## Cài đặt

```bash
npm install @lumibase/sdk
# hoặc
pnpm add @lumibase/sdk
```

## Hình dạng của SDK này

Có hai điều cần biết trước khi xem ví dụ, vì chúng khác với phần lớn CMS client:

1. **Client là một transport, không phải một façade.** `createLumiClient` cho bạn
   `rawRequest`, `request`, và `with`. Các operation là những hàm **command**
   riêng biệt mà bạn truyền vào `request` — một command là một hàm nhận client và
   trả về một promise. Cách này giữ cho bundle tree-shake được: bạn chỉ import
   những command mình dùng.
2. **Không có `login()`.** Client nhận một `token` mà bạn đã có. Hãy lấy nó qua
   luồng auth của bạn (Logto, hoặc `dev:<logtoId>` ở chế độ dev) rồi truyền vào.
   Client có thể refresh nó một cách âm thầm nếu bạn cũng cung cấp `refreshToken`.

Một plugin tiện lợi, `legacyRest()`, gộp toàn bộ bề mặt REST thành các namespace
theo nhóm, nếu bạn không muốn import từng command một.

## Bắt đầu nhanh

```typescript
import { createLumiClient, readItems } from '@lumibase/sdk'

const client = createLumiClient({
  url: 'https://api.mysite.lumibase.dev',
  siteId: 'site_abc123',
  token: process.env.LUMIBASE_TOKEN!,
})

// Command được curry: dựng một cái, rồi đưa cho request().
const articles = await client.request(
  readItems('articles', {
    filter: { status: { _eq: 'published' } },
    sort: ['-created_at'],
    limit: 10,
  }),
)
```

---

## Cấu hình client

`createLumiClient(opts: LumiClientOptions)` (`packages/sdk/src/client.ts`):

| Option | Type | Bắt buộc | Mô tả |
|--------|------|----------|-------------|
| `url` | `string` | Có | Base URL của API, ví dụ `https://api.lumibase.dev` |
| `token` | `string` | Có | Bearer token (Logto access token, hoặc `dev:<logtoId>` ở chế độ dev) |
| `siteId` | `string` | Có | Id tenant đang hoạt động; gửi dưới dạng `X-Lumi-Site` |
| `fetcher` | `typeof fetch` | Không | Ghi đè fetch (polyfill cho Node/Workers); mặc định là `globalThis.fetch` |
| `headers` | `Record<string, string>` | Không | Header thêm cho mọi request |
| `onUnauthorized` | `() => void` | Không | Chạy một lần khi gặp `401`, trước khi `LumiError` được throw — hãy xoá token cũ và điều hướng về login. Khi bật auto-refresh, nó chỉ chạy sau khi lần thử refresh cũng thất bại |
| `refreshToken` | `string` | Không | Refresh token có rotation. Khi đó một `401` sẽ kích hoạt một `POST /api/v1/auth/refresh` và retry request gốc một lần |
| `onTokensRefreshed` | `(tokens) => void` | Không | Được gọi sau một lần refresh âm thầm thành công, kèm cặp token đã rotate, để host lưu lại — refresh token cũ giờ đã bị revoke |

`LumiClient` được trả về:

| Thành phần | Mô tả |
|--------|-------------|
| `rawRequest<T>(path, init?)` | Một lệnh gọi HTTP; trả về `{ data, meta? }` |
| `request<Output>(command)` | Chạy một hàm command với client này |
| `with(plugin)` | Trả về client đã được mở rộng bằng các thành phần của plugin |
| `url`, `token`, `siteId`, `fetcher` | Cấu hình đã được resolve |

Refresh là single-flight: một loạt `401` song song chỉ kích hoạt một lần refresh, không phải một lần cho mỗi request.

---

## Namespace theo nhóm qua `legacyRest()`

`legacyRest()` là một plugin. Gắn nó bằng `with()` và bạn có bề mặt REST dưới dạng
các namespace — tiện cho code ứng dụng và cho Studio:

```typescript
import { createLumiClient, legacyRest } from '@lumibase/sdk'

const client = createLumiClient({ url, siteId, token }).with(legacyRest())

await client.schema.collections.list()
await client.items('articles').list({ limit: 20 })
await client.me.getPreferences()
```

Các namespace được phơi ra: `schema` (`collections`, `fields`, `relations`),
`items`, `roles`, `policies`, `access`, `apiKeys`, `shares`, `me`, `permissions`,
`presets`, `translations`, `tm`, `settings`, `uploads`, `site`, `domains`,
`users`, `teams`, `folders`, `files`, `webhooks`, `activity`, `extensions`,
`deployments`, `realtime`.

---

## Items

### Envelope của item

Một item **không** phải là một record phẳng. Giá trị các field nằm dưới `data`;
các cột workflow và scheduling nằm bên cạnh nó:

```typescript
{ data: { title: 'Hello' }, status: 'draft', sort: 1, publishAt: null, unpublishAt: null }
```

### List

```typescript
const res = await client.items('articles').list({
  fields: ['id', 'title', 'status'],
  filter: { status: { _eq: 'published' } },
  sort: ['-published_at'],
  limit: 20,
  offset: 0,
  status: 'published',
})
```

Các param list được hỗ trợ là `fields`, `filter`, `sort`, `limit`, `offset`, và
`status`. Lưu ý là **không** có param `page` — hãy phân trang bằng
`limit`/`offset` — và endpoint này không có `aggregate`/`groupBy`. Tìm kiếm
full-text là command `search` riêng.

### Detail

```typescript
const article = await client.items('articles').detail('art_abc123', ['id', 'title', 'content'])
```

### Create

```typescript
const created = await client.items('articles').create({
  data: { title: 'New Article', author: 'usr_abc123' },
  status: 'draft',
})
```

### Update (patch) và replace

```typescript
await client.items('articles').patch('art_abc123', {
  data: { title: 'Updated title' },
  status: 'published',
  publishAt: new Date().toISOString(),
})

// PUT — thay toàn bộ `data`
await client.items('articles').replace('art_abc123', { data: { title: 'Only field left' } })
```

### Delete và bulk

```typescript
await client.items('articles').delete('art_abc123')

// op là 'create' | 'update' | 'delete'; xem docs/vi/features/data-import.md
await client.items('articles').bulk('create', [{ title: 'A' }, { title: 'B' }])
```

### Revision và pin

```typescript
const revisions = await client.items('articles').listRevisions('art_abc123')
await client.items('articles').revertRevision('art_abc123', revisions.data[0].id)

// Pin theo Law Zero — các field mà một lần sửa của con người đã khoá lại, chặn agent ghi
await client.items('articles').listPins('art_abc123')
```

---

## Files

```typescript
await client.files.list()
await client.files.create({ /* metadata của file */ })
await client.files.update('fil_abc123', { title: 'My Image' })
await client.files.delete('fil_abc123')
```

Việc upload nhị phân đi qua namespace `uploads`, đó là luồng presigned — CMS không
nhận body file trên `/files`.

Để có URL transform, hãy dùng command `mediaUrl` thay vì tự dựng query string.

---

## Agent Harness API

Vòng đời governance mà các AI run và các artifact app được sinh ra sử dụng:

```typescript
import {
  generateAgentApp,
  listAgentRuns,
  publishAgentArtifact,
  rollbackAgentArtifact,
} from '@lumibase/sdk/rest'

const result = await generateAgentApp({
  collections: ['products', 'orders', 'customers'],
  targetApp: 'storefront',
  approvalPolicy: 'before_commit',
  budget: { maxToolCalls: 20 },
})(client)

// result.artifacts chứa page_spec, component_spec, seed_data, api_spec
const runs = await listAgentRuns()(client)
const published = await publishAgentArtifact(result.artifacts[0].id)(client)
await rollbackAgentArtifact(published.id, 'revert generated storefront')(client)
```

Việc publish là idempotent. Các artifact schema và migration đòi hỏi một lượt evaluation đạt, trừ khi caller cung cấp một lý do override.

Các command agent khác: `createAgentGoal`, `listAgentGoals`, `retryAgentRun`,
`listAgentTools`, `listAgentApprovals`, `decideAgentApproval`,
`createAgentArtifact`, `listAgentArtifacts`, `evaluateAgentArtifact`,
`readAgentMemoryContext`, `writeAgentMemory`.

---

## Change Feed

```typescript
import { readCdcEvents, ackCdcSubscription } from '@lumibase/sdk'

let cursor: string | undefined
for (;;) {
  const { data, meta } = await client.request(readCdcEvents({ collections: ['posts'], cursor }))
  for (const event of data) await handle(event) // dedupe theo event.id
  cursor = (meta as { nextCursor?: string }).nextCursor ?? cursor
  if (!(meta as { hasMore?: boolean }).hasMore) break
}
await client.request(ackCdcSubscription(subId, cursor!))
```

Xem [Change Feed](../features/cdc-change-feed.md) để hiểu ngữ nghĩa gửi.

---

## Realtime

Realtime là một `RealtimeClient`, được tạo qua namespace `realtime` cùng một token cho handshake WebSocket:

```typescript
const rt = client.realtime.create(process.env.LUMIBASE_TOKEN!, {
  userId: 'usr_abc123',
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
})
```

`RealtimeClient` và `AudienceClient` cũng được export trực tiếp từ
`@lumibase/sdk` nếu bạn muốn tự khởi tạo mà không dùng plugin.

---

## Type TypeScript

Client là generic theo schema của bạn, nên các type được sinh ra sẽ chảy vào mọi lệnh gọi:

```typescript
import { createLumiClient } from '@lumibase/sdk'
import type { Collections } from './lumibase-types'

const client = createLumiClient<Collections>({ url, siteId, token })
```

Xem [tham chiếu TypeGen](./typegen.md) để biết cách sinh `lumibase-types.ts`.

---

## Xử lý lỗi

Mọi response không phải 2xx đều throw `LumiError`:

```typescript
import { LumiError } from '@lumibase/sdk'

try {
  await client.items('articles').create({ data: { title: '' } })
} catch (error) {
  if (error instanceof LumiError) {
    console.error(error.status)            // 400
    console.error(error.body.errors[0].code)    // 'VALIDATION_FAILED'
    console.error(error.body.errors[0].message) // 'title is required'
    console.error(error.body.errors[0].path)    // path của field, tuỳ chọn
  }
}
```

Một lần thất bại không phải JSON hoặc không có body vẫn được chuẩn hoá về cùng
envelope đó, với code `HTTP_ERROR`.
