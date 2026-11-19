---
version: 1
lastUpdated: 2026-11-19T05:28:32.976Z
sourceLang: en
translatedFrom: en
sourceHash: 149c3ea6d9602be3
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T05:28:32.976Z
codeVerifiedHash: 149c3ea6d9602be3
codeVerifiedClaims: 14
---

# Chat agent (Slack và webhook chung)

Content Agent có thể được gọi từ một công cụ chat. Nhắc tên app LumiBase trong
Slack, ví dụ `@lumibase draft a post about our spring launch`, hoặc gửi một
request có chữ ký từ bot Teams hay Discord của bạn. LumiBase chạy một lượt
Copilot và trả lời trong thread. Khi hành động cần phê duyệt, câu trả lời có
nút **Approve** và **Reject**.

Không gì một tin nhắn chat làm được có thể vượt quá những gì người gửi làm được
trong Studio. Mỗi user chat được **liên kết** với một user LumiBase của site, và
lượt chat chạy **với tư cách user đó**. Nó dùng capability, quyền theo dòng và
theo field, mức autonomy và quy tắc phê duyệt của họ, và để lại cùng audit
trail. Một approval được bấm trong chat được quyết định với tư cách user đã liên
kết của người bấm, nên một editor đã liên kết không thể duyệt việc mà chỉ admin
mới được duyệt.

Code: `apps/cms/src/modules/chat-agent/`. API: [API spec §12d](../api/hono-api-spec.md#12d-chat-agent-slack--webhook-chung).

## Một tin nhắn được xử lý thế nào

1. Chữ ký request được xác minh bằng secret của integration (HMAC-SHA256 trên
   body thô và một timestamp; mọi thứ cũ hơn 300 giây bị từ chối). Một
   integration không tồn tại hoặc đã tắt, một integration của site hay provider
   khác, hoặc một event Slack từ workspace khác bị từ chối trước khi làm bất cứ
   việc gì.
2. Event được ghi một lần cho mỗi integration (`lumibase_chat_events`, event key
   duy nhất). Khi Slack gửi lại một delivery, không gì chạy lần thứ hai.
3. User chat được tra trong bảng liên kết. User chưa liên kết nhận câu trả lời
   nhờ admin liên kết tài khoản, và không model nào được gọi. Một liên kết chỉ
   có hiệu lực khi user LumiBase của nó vẫn là thành viên của site.
4. Tin nhắn chạy qua chính router `/ai` mà Studio dùng, với tư cách user đã liên
   kết: `POST /api/v1/ai/chat`. Các tin nhắn trong một thread chat của cùng một
   user tiếp tục cùng một cuộc hội thoại Copilot.
5. Kết quả được gửi lại. Khi lượt chat phải chờ phê duyệt, câu trả lời có nút
   Approve và Reject mang giá trị là id của approval.
6. Một lần bấm nút được xác minh theo cùng cách. Nó được quyết định qua
   `POST /api/v1/ai/approvals/:id/decide` với tư cách liên kết của **người bấm**,
   kèm các bước kiểm tra admin và capability của chính endpoint đó. Tin nhắn
   gốc được thay bằng kết quả. Một lần bị từ chối chỉ hiện cho người đã bấm.

Output của model được escape trước khi gửi lên Slack, nên câu trả lời không thể
mention `@channel` hay giả mạo link. Câu trả lời cho slash command chỉ được gửi
tới response URL thuộc `hooks.slack.com`.

## Cài đặt Slack

1. Tạo một Slack app cho workspace của bạn. Cấp cho nó bot scope
   `app_mentions:read`, `chat:write` và, nếu dùng slash command, `commands`.
   Cài app vào workspace, rồi copy **Bot User OAuth Token** (`xoxb-…`) và
   **Signing Secret** của app.
2. Cài integration lên site (site admin):

   ```http
   POST /api/v1/chat-agent/integrations
   { "provider": "slack", "name": "Acme Slack", "externalId": "T0123ABCD",
     "signingSecret": "<signing secret>", "botToken": "xoxb-…" }
   ```

   `externalId` là id của workspace (team). Response liệt kê ba `endpoints` để
   dán vào Slack app.
3. Trong Slack app, đặt **Event Subscriptions → Request URL** là endpoint
   `events` và đăng ký bot event `app_mention`. Đặt
   **Interactivity → Request URL** là `interactions`. Tuỳ chọn, tạo một slash
   command (ví dụ `/lumibase`) với URL `commands`.
4. Liên kết từng người sẽ dùng nó:

   ```http
   PUT /api/v1/chat-agent/integrations/<id>/links/U0123ABCD
   { "userId": "<their LumiBase user id>" }
   ```

   Slack user id nằm trong profile Slack của họ (**Copy member ID**).

## Webhook chung (Teams, Discord, bot của bạn)

Cài `{ "provider": "webhook", "name": "Teams bridge" }`. Response chứa
`signingSecret` **một lần**; lưu nó trong bot của bạn. Liên kết user id của công
cụ chat như ở trên. Sau đó ký từng request:

```js
const body = JSON.stringify({ userId: 'teams-29:1abc', text: 'draft a post about X', threadId: 'conv-42' });
const ts = Math.floor(Date.now() / 1000);
const mac = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
await fetch(`${base}/api/v1/chat-agent/webhook/${siteId}/${integrationId}/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lumibase-timestamp': String(ts),
    'x-lumibase-signature': `v1=${mac}`,
    'x-lumibase-delivery': deliveryId, // optional: makes the request idempotent
  },
  body,
});
```

Câu trả lời là đồng bộ: kết quả Copilot (`status`, `message`, `approvalId` khi
phải chờ duyệt, `conversationId`) cộng `threadId`. Quyết định một approval bằng
request có chữ ký
`POST …/approvals/:approvalId/decide { "userId", "decision": "approved" | "rejected" }`.
`POST /api/v1/chat-agent/integrations/:id/rotate-secret` thay secret, và secret
cũ ngừng xác minh được ngay.

## Ghi chú bảo mật

- Secret (Slack signing secret, bot token, webhook secret) được mã hoá at rest
  bằng `ENCRYPTION_KEY` (AES-GCM, ràng buộc vào site, dòng và field). Chúng
  không bao giờ được trả về khi đọc, và integration không dùng được nếu thiếu
  `ENCRYPTION_KEY`.
- Chữ ký sai được trả `401` và ghi vào audit log
  (`chat_agent_signature_rejected`). Việc cài, sửa, rotate và xoá integration,
  cũng như liên kết hay huỷ liên kết user, đều được audit.
- Xoá một user khỏi site, hoặc đổi role của họ, có hiệu lực ngay từ tin nhắn
  chat tiếp theo: capability được resolve ở mọi request.

## Giới hạn

- Một tool call mỗi tin nhắn, như Copilot trong Studio. Không nhận file đính kèm
  từ chat.
- Trả lời Slack cần bot token. Không có bot token thì một mention vẫn chạy,
  nhưng câu trả lời không thể được gửi. Slash command trả lời qua `response_url`
  thay vào đó.
- Chưa có màn hình Studio cho chat integration; quản lý chúng bằng API ở trên.

## Multi-tenancy

| Tài nguyên | Phạm vi |
|---|---|
| `lumibase_chat_integrations`, `lumibase_chat_user_links`, `lumibase_chat_events` | `site_id` trên mọi dòng và mọi query; cả ba nằm trong danh sách RLS `site_isolation` (`packages/database/migrations/rls-policies.sql`). |
| Endpoint public | Site nằm trong path, và mọi query chạy trên `scopedDbFor(c, siteId)`. Id integration dưới path của site khác trả `404`. |
| Liên kết | Một user chat chỉ có thể được liên kết với thành viên của cùng site. |

## Nâng cấp

Migration `0044_chat_agent` thêm ba bảng và không thay đổi gì có sẵn. Áp lại
`rls-policies.sql` sau khi migrate, như sau mọi lần nâng cấp. Đặt
`ENCRYPTION_KEY` (vốn đã bắt buộc với Git integration) trước khi cài một
integration.
