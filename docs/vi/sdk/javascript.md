---
version: 5
lastUpdated: 2026-10-26T15:54:55.091Z
sourceLang: en
translatedFrom: en
sourceHash: c6b8c8284912e170
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-26T15:54:55.091Z
codeVerifiedHash: c6b8c8284912e170
codeVerifiedClaims: 8
---

<!-- check-parity: allow code-fences -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-10T09:01:07.711Z. See commit history for rationale. -->

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

## Decisions

`decide` gọi `POST /api/v1/ai/decisions`: các câu hỏi có kiểu `noul` / `choice` / `score`, được TypeSafe Jev hoặc AI tương đương đã cấu hình trả lời kèm xác suất. Key của provider nằm ở CMS; client chỉ gửi bearer và header `X-Lumi-Site` như thường lệ, nên không bao giờ đặt key TypeSafe hay OpenRouter trong code chạy trên trình duyệt. Hãy gọi `decide` và các command review từ Studio hoặc từ server dùng secret API key: publishable API key (`lbk_pub_…`) hay session frontend nhận `403 FORBIDDEN`, kể cả khi role của nó cấp `ai:decide`.

```typescript
import { decide, LumiError } from '@lumibase/sdk'

const controller = new AbortController()
try {
  const result = await client.request(
    decide(
      {
        state: { title: 'Summer sale', body: 'Buy now!!!' },
        questions: {
          spam: {
            type: 'noul',
            instructions: 'Is this post spam?',
            criteria: { true: 'spam', false: 'legitimate' },
          },
          topic: {
            type: 'choice',
            instructions: 'Pick the topic',
            criteria: { promo: 'Promotion', news: null },
          },
        },
      },
      { signal: controller.signal },
    ),
  )
  result.answers.spam // { type: 'noul', noul: 0.12 }
} catch (err) {
  if (err instanceof LumiError && err.body.errors[0]?.code === 'DECISION_NOT_CONFIGURED') {
    // CMS chưa đặt DECISION_PROVIDER
  }
}
```

`calibrated` là `false` khi CMS trả lời bằng `DECISION_PROVIDER=llm`. Mã lỗi có kiểu `DecisionErrorCode`; xem [đặc tả API](../api/hono-api-spec.md) để biết giới hạn và status.

### Kiểm tra bản nháp

Kiểm tra bản nháp chạy một review profile có phiên bản, lưu trên CMS, trên một item đã lưu hoặc một bản nháp chưa lưu. Các lệnh dưới đây gọi các endpoint `/api/v1/ai/review-profiles` và `/api/v1/ai/reviews`:

- `listReviewProfiles({ collection? })` và `getReviewProfile(key, { version? })` đọc profile. Profile do admin tạo.
- `reviewDraft(request)` kiểm tra một item (`itemId`) hoặc một bản nháp (`snapshot`).
- `getReview(id)` và `listReviews({ collection, itemId })` đọc các lần chạy, kèm `stale` và `staleReason`.
- `submitReviewFeedback(runId, { entries })` ghi nhận `accept`, `edit` hoặc `reject` cho từng câu hỏi.
- `reviewContentHash(values)` tính content hash `sha256:<hex>` của một bản nháp theo đúng cách CMS tính. Hàm dùng WebCrypto và không gửi request nào.

Mọi lệnh đều nhận `{ signal }` ở tham số cuối. Review chỉ gợi ý: không lệnh nào ghi vào item.

```typescript
import {
  decisionErrorCode,
  listReviewProfiles,
  LumiError,
  reviewContentHash,
  reviewDraft,
  submitReviewFeedback,
} from '@lumibase/sdk'

const [profile] = await client.request(listReviewProfiles({ collection: 'posts' }))
const draft = { title: 'Summer sale', body: 'Buy now!!!' }
try {
  const hash = await reviewContentHash(draft) // 'sha256:<64 hex>', giống hệt cách CMS tính
  const run = await client.request(
    reviewDraft(
      {
        profile: profile.key,
        profileVersion: profile.version,
        collection: 'posts',
        snapshot: draft,
        // đổi theo bản nháp và phiên bản profile; tối đa 116 ký tự
        idempotencyKey: `${profile.key}@${profile.version}:${hash.slice(7, 47)}`,
      },
      { signal: controller.signal },
    ),
  )
  run.status     // 'success' | 'abstained' ("chưa đủ thông tin") | …
  run.calibrated // false khi xác suất do LLM tự báo
  run.usage      // { inputTokens: 120, outputTokens: null } — null nghĩa là không rõ, không phải 0

  // Sau đó, khi biên tập viên chấp nhận: hash bản nháp đúng như lúc đó.
  await client.request(
    submitReviewFeedback(run.id, {
      entries: [{ questionKey: 'category', verdict: 'accept' }],
      contentHash: await reviewContentHash(currentDraft),
    }),
  )
} catch (err) {
  const code = decisionErrorCode(err) // DecisionErrorCode có kiểu, hoặc null
  if (code === 'DECISION_QUOTA_EXCEEDED') {
    console.warn(`retry in ${(err as LumiError).retryAfter}s`)
  } else if (code === 'REVIEW_STALE') {
    // bản nháp đã đổi sau lần review: review bản nháp hiện tại (hash mới, key mới),
    // hoặc gửi acknowledgeStale: true
  }
}
```

CMS không đọc lại được một bản nháp chưa lưu. Với lần chạy snapshot, CMS chỉ phát hiện bản nháp đã đổi bằng cách so `contentHash` bạn gửi kèm feedback với hash nó đã review. Hãy tính giá trị đó bằng `reviewContentHash` trên đúng các field đã gửi trong `snapshot`, tại thời điểm ra quyết định. Gửi lại `run.contentHash` thì luôn khớp, nghĩa là tắt phép kiểm này. Lần chạy trên item không cần hash: CMS đọc lại item và báo `stale`.

Gửi lại cùng `idempotencyKey` sẽ trả về lần chạy đã lưu mà không gọi provider lần thứ hai. CMS tìm lần chạy chỉ theo site, người gọi và key, không so nội dung. Vì vậy một key giữ nguyên sau khi bản nháp đổi sẽ trả về kết quả review của bản nháp cũ. Hãy dựng key từ content hash và phiên bản profile như ví dụ trên, đừng bao giờ dùng một id cố định. Với lần chạy trên item, cũng đổi key khi `getReview` báo `stale`. Key dài 8–128 ký tự. Lỗi dùng cùng các mã với `decide`, gồm 403 `DECISION_DISABLED`, 504 `DECISION_TIMEOUT` và 429 kèm `retryAfter`, cộng thêm các mã `REVIEW_*`: 409 `REVIEW_STALE`, 422 `REVIEW_FIELD_NOT_ALLOWED`, và 404 `REVIEW_PROFILE_NOT_FOUND` / `REVIEW_RUN_NOT_FOUND`. `decisionErrorCode(err)` trả về `null` khi request bị huỷ, lỗi mạng, hoặc gặp mã mà phiên bản SDK này chưa biết. Khi đó hãy đọc `err.body`. Ví dụ đầy đủ, biên dịch được từ public entry, nằm ở `packages/sdk/examples/draft-review.ts`.

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

`error.retryAfter` chứa header `Retry-After` tính bằng giây, ví dụ khi gặp 429 do
hết ngân sách của site. Giá trị là `null` khi response không gửi header này.
