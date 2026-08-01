---
version: 1
lastUpdated: 2026-07-28T11:34:33.530Z
sourceLang: en
translatedFrom: en
sourceHash: f22cd1fddd83f8e8
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:34:33.530Z
codeVerifiedHash: f22cd1fddd83f8e8
codeVerifiedClaims: 10
---

# Change Feed (CDC Extension Integration)

> Spec: `.kiro/specs/cdc-extension-integration/` · Module: `apps/cms/src/modules/cdc/change-feed/`

Một **transactional outbox + relay** do chính LumiBase cung cấp, đặt trên các mutation nội dung. Mỗi lần create/update/delete item đều append một change event bất biến; consumer đọc chúng qua một pull API phân trang bằng cursor, các webhook được ký HMAC, hoặc các extension subscriber chạy trong sandbox — đáng tin cậy, đúng thứ tự, và replay được.

Cái này khác với control plane của ClickHouse CDC (`docs/vi/cdc/`), thứ provision việc replicate Postgres→ClickHouse **bên ngoài** để phân tích. Change Feed nói về việc các thay đổi nội dung *của bạn* đến được các tích hợp *của bạn*.

## 1. Kiến trúc

```
ItemService mutation ──(cùng request)──▶ lumibase_cdc_change_events (outbox, chỉ ghi thêm)
        │                                        ▲
        └─ enqueue cdc-dispatch (đường độ trễ)   │ đọc keyset (occurred_at, id), safety lag 2s
                                                 │
   sweep 30s (chốt hạ về tính đúng) ──▶ CdcDispatcher ──▶ webhook (HMAC POST)
                                                 │       └▶ extension subscriber (sandbox, ngân sách 5s)
   GET /api/v1/cdc/events  ◀── pull consumers ───┘
```

- **Capture** — `OutboxWriter` chạy trong cụm side-effect sau mutation của `ItemService`. Nó không bao giờ throw: một lần insert lỗi sẽ phát audit warning `cdc_event_write_failed` và mutation vẫn tiếp tục. Các site không có subscription active (và không có `cdc_feed.enabled`) bỏ hẳn lần ghi đó (một flag theo site được cache).
- **Thứ tự** — id của event là nanoid (không mang nghĩa thứ tự). Thứ tự toàn phần của feed theo từng site là keyset ghép `(occurred_at, id)`, với `occurred_at` do Postgres `now()` đóng dấu — một đồng hồ duy nhất. Mọi đường đọc đều áp một **safety lag 2s** để một transaction dài đang giữ một `now()` sớm hơn không bị vượt qua rồi bị bỏ sót.
- **Ngữ nghĩa gửi** — at-least-once, không bao giờ exactly-once. `event.id` là idempotency key; consumer **bắt buộc** phải dedupe theo nó. Một cursor chỉ tiến qua một batch đã gửi thành công, nên event không bao giờ bị bỏ sót. Về lâu dài: trên driver HTTP (Workers), việc ghi outbox là best-effort sau commit — hãy hoà giải bằng cách so `updatedAt` của item với feed nếu bạn cần một đảm bảo chắc chắn.

## 2. Envelope của event (schemaVersion 1)

```jsonc
{
  "id": "V1StGXR8_Z5jdHi6B-myT",        // idempotency key
  "type": "items.update",                 // <resource>.<operation> — items.* | collections.* | fields.* | settings.*
  "schemaVersion": 1,
  "siteId": "s_abc",
  "collection": "posts",
  "itemId": "itm_xyz",
  "operation": "update",                  // create | update | delete
  "occurredAt": "2026-07-11T04:12:09.123Z",
  "actor": { "type": "api_key", "id": "key_123" },  // user | api_key | agent | system
  "source": "api",                        // api | agent | flow | system
  "changedFields": ["title", "status"],  // chỉ với update
  "data": { "title": "…" },              // CHỈ ở chế độ snapshot; pii/phi đã bị mask
  "cursor": "MTc1MT…"                     // token keyset của event này — mốc ack/resume
}
```

- `payloadMode: 'reference'` (mặc định) bỏ `data` — consumer tự fetch lại `GET /items/:collection/:id` bằng token của chính nó, nên RBAC của nó quyết định nó thấy gì. `snapshot` nhúng thẳng record sau mutation, với các field `pii`/`phi` đã được thay bằng `[masked]` **trước khi** event được lưu.
- **Các loại resource**: `items.*` là thay đổi ở row nội dung (mặc định). Schema DDL phát ra `collections.*` (với `collection`/`itemId` = tên collection) và `fields.*` (`collection` = collection sở hữu, `itemId` = tên field); `data` của chúng là phần định nghĩa, lưu nguyên văn (metadata schema không mang phân loại pii/phi theo từng field, nên việc mask chỉ áp cho item). Một consumer chỉ muốn thay đổi nội dung thì filter theo tiền tố `items.`. (`settings.*` là bước tiếp theo đã lên kế hoạch — xem `.kiro/specs/cdc-feed-roadmap/`.)
- Versioning: các field thêm vào vẫn giữ `schemaVersion: 1`; việc rename/bỏ sẽ nâng nó lên, và version trước vẫn serialize được trong ít nhất một bản minor release. `EventEnvelopeSchema` trong `@lumibase/contracts/schemas` là source of truth.

## 3. Pull consumer

```bash
# Trang đầu (cần capability cdc:subscribe — admin hàm ý có nó)
curl -H "Authorization: Bearer lbk_…" -H "X-Lumi-Site: s_abc" \
  "https://cms.example.com/api/v1/cdc/events?collections=posts&limit=100"
# → { "data": [...], "meta": { "nextCursor": "…", "hasMore": true } }

# Tiếp tục từ cursor; 410 CURSOR_EXPIRED (kèm earliestCursor) nghĩa là bạn đã
# tụt quá xa khỏi retention — hãy resync từ đầu hoặc từ earliestCursor.
curl … "https://cms.example.com/api/v1/cdc/events?cursor=<nextCursor>"

# Long-poll (tránh poll rỗng liên tục): server giữ lần đọc rỗng đầu tiên tối đa
# `wait` giây (≤25) và trả về ngay khi có event tới.
curl … "https://cms.example.com/api/v1/cdc/events?cursor=<nextCursor>&wait=20"
```

Hãy đăng ký một subscription `kind: 'pull'` để có checkpoint bền + metric về lag, rồi commit nó bằng `POST /api/v1/cdc/subscriptions/:id/ack {"cursor": "…"}`. Ack chỉ đi về phía trước (409 `ACK_REGRESSION` nếu lùi lại) — muốn lùi thì đó là việc của `replay`.

Muốn truy cập có type từ JS/TS? `@lumibase/sdk` có command resource cho toàn bộ bề mặt này (`readCdcEvents`, `ackCdcSubscription`, `replayCdcSubscription`, …); contract dạng máy đọc được nằm ở `apps/cms/openapi.yaml`:

```ts
import { readCdcEvents, ackCdcSubscription } from '@lumibase/sdk';

let cursor: string | undefined;
for (;;) {
  const { data, meta } = await client.request(readCdcEvents({ collections: ['posts'], cursor }));
  for (const event of data) await handle(event); // dedupe theo event.id
  cursor = meta.nextCursor ?? cursor;
  if (!meta.hasMore) break;
}
await client.request(ackCdcSubscription(subId, cursor!)); // checkpoint bền
```

## 4. Webhook consumer

Tạo một webhook (Settings → Webhooks) **kèm secret** — việc gửi mà không ký sẽ bị từ chối — rồi tạo một subscription với `kind: 'webhook'` và `webhook_id`. Các batch tới dưới dạng:

```
POST <webhook.url>
Content-Type: application/json
X-LumiBase-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>

{ "events": [<envelope>…], "subscription": { "id": "…", "name": "…" } }
```

Hãy verify trước khi tin (so sánh theo constant-time; từ chối timestamp quá cũ):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}
```

Các batch thất bại được retry theo exponential backoff (30s·2ⁿ, 5 lần); 10 batch cạn lượt retry liên tiếp sẽ chuyển subscription sang `dead` (có phát notification). Chỉ có thể tiếp tục qua replay.

## 5. Xây sink connector đầu tiên của bạn (extension subscriber)

1. **Manifest** (`lumibase-extension.json`): type `hook`, và một capability `cdc:subscribe:<collection>` cho mỗi collection (hoặc `cdc:subscribe:*`):

```json
{
  "name": "acme/algolia-sync",
  "version": "1.0.0",
  "type": "hook",
  "entry": "dist/index.js",
  "capabilities": ["cdc:subscribe:posts", "http:fetch:acme.algolia.net"],
  "compatibleWith": ">=0.21.0"
}
```

2. **Handler** — export `cdcSubscriber` (xem `defineCdcSubscriber` trong `@lumibase/extension-sdk`). Hãy làm nó **idempotent theo `event.id`**; thỉnh thoảng bạn sẽ thấy một batch hai lần:

```ts
import { defineCdcSubscriber } from '@lumibase/extension-sdk';

export const cdcSubscriber = defineCdcSubscriber({
  collections: ['posts'],
  handler: async ({ events, ctx }) => {
    for (const event of events) {
      // Upsert/delete theo itemId — tự nhiên đã idempotent.
      await fetch(`https://acme.algolia.net/1/indexes/posts/${event.itemId}`, {
        method: event.operation === 'delete' ? 'DELETE' : 'PUT',
        body: event.operation === 'delete' ? undefined : JSON.stringify({ id: event.itemId }),
      });
      ctx.logger.info('synced', { id: event.id });
    }
  },
});
```

3. **Ship nó**: build bundle ESM → upload qua Studio → admin review và **cấp** các capability → enable. Việc enable tự tạo subscription `ext:<name>`; disable thì tạm dừng nó (checkpoint vẫn còn). Host filter event về đúng các collection bạn được cấp **trước khi** vào sandbox — khai báo thêm trong code không cấp thêm gì cả.

Bản hiện thực tham chiếu của pattern này ở quy mô module: `apps/cms/src/modules/lumibase-firebase-sync/`.

## 6. Vận hành

- **Studio** → Settings → Change Feed: trạng thái/lag theo từng subscription, các lần gửi gần đây, pause/resume/replay/dispatch-now (các hành động phá huỷ đều xác nhận trước).
- **Replay** (`POST /api/v1/cdc/subscriptions/:id/replay {"occurred_after": "…"}`) lùi lại trong cửa sổ retention và reset `dead`/`stale` về `active` — đây là đường duy nhất ra khỏi các trạng thái đó. Có audit.
- **Retention** — setting theo site `cdc_feed.retentionDays` (mặc định 7, khoảng 1–90). Lượt sweep prune các event/delivery cũ hơn; một subscription mà checkpoint tụt quá sàn sẽ chuyển sang `stale` (không bao giờ bị bỏ qua trong im lặng).
- **AI skills** — `listCdcSubscriptions`, `getCdcSubscriptionStatus`, `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`), và `deleteCdcSubscription` (control-plane → cần HITL phê duyệt khi dưới mức autopilot). Cùng bề mặt đó qua MCP (các tool `cdc_*`) — passthrough REST, không bỏ qua guard nào.

## 7. Multi-tenancy

Cả ba bảng (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`) đều có `site_id`, đều được các policy RLS `site_isolation` bao phủ, và mọi query đều filter theo site. Các cache flag và dispatch lock đều có tiền tố theo tenant (`cdc:feed:<siteId>:…`, `cdc:dispatch:<siteId>:<subId>`). Property test ghim lượt smoke hai site: các lần đọc và lần gửi của site A không bao giờ chứa event của site B.

## 8. Tham chiếu setting & capability

| Key | Ở đâu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `cdc_feed.enabled` | `settings` (site) | `false` | Ghi outbox event kể cả khi không có subscription active |
| `cdc_feed.retentionDays` | `settings` (site) | `7` | Cửa sổ prune (1–90) |
| `cdc:subscribe` | role/capability | — | Đọc `/cdc/events`, ack checkpoint (admin hàm ý có) |
| `cdc:manage` | capability (skills) | — | Quản lý subscription qua AI skills/MCP |
| `cdc:subscribe:<collection>` | manifest của extension | — | Các collection mà một extension subscriber được nhận |
