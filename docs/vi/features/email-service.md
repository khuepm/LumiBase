---
version: 1
lastUpdated: 2026-06-22T11:37:06.122Z
sourceLang: vi
contentHash: 10c2a365a38fa9a2
---

# Email Service

> Mục tiêu: cung cấp một **dịch vụ gửi email dùng chung** ở tầng core, có template/layout store, để Studio và các extension đều dùng được — hoặc cấu hình hoàn toàn bằng env nếu không cần UI.

## 1. Kiến trúc tổng quan

LumiBase tách email thành hai tầng rõ ràng:

| Tầng | Trách nhiệm | Vị trí |
|---|---|---|
| **Transport** (gửi byte) | SMTP (Nodemailer) cho Docker/Node, MailChannels HTTP cho Cloudflare Workers | `apps/cms/src/services/email/transport.ts` |
| **EmailService** | Chọn transport theo runtime, áp default `from`/`replyTo`, expose `send()` | `apps/cms/src/services/email/email-service.ts` |
| **Render engine** | Thay biến `{{var}}` an toàn (escape HTML mặc định), ghép body vào layout | `apps/cms/src/services/email/render.ts` |
| **Template/layout store** | Bảng `email_templates`, `email_layouts` (site-scoped, RLS) | `packages/database/src/schema/platform.ts` |
| **HTTP module** | CRUD + preview + send dưới `/api/v1/email/*` | `apps/cms/src/modules/email/` |
| **UI** | Trang Studio quản lý template/layout + gửi test | `apps/studio/src/modules/settings/email-page.tsx` |

Luồng gửi: caller (UI hoặc extension) → `POST /api/v1/email/send` → module render template (nếu có `templateKey`) → `EmailService.send()` → transport phù hợp với runtime → audit log (`email_sent` / `email_send_failed`).

> Kênh security-notification cũ (`modules/notifications/email-channel.ts`) nay **dùng chung transport** này; nó chỉ còn giữ template subject/body cố định theo spec (Req 13.2).

## 2. Cấu hình bằng env (không cần UI)

EmailService cấu hình hoàn toàn qua biến môi trường. Thêm vào `apps/cms/.dev.vars` (local) hoặc `wrangler secret put` (deploy).

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `LUMIBASE_SMTP_URL` | Docker: có | Chuỗi kết nối SMTP dạng nodemailer, vd `smtps://user:pass@smtp.example.com:465`. Không set ⇒ email ở chế độ degraded (không gửi). |
| `LUMIBASE_MAIL_FROM` | nên có | Địa chỉ gửi mặc định. Mặc định fallback `no-reply@lumibase.local`. |
| `LUMIBASE_MAIL_REPLY_TO` | không | Reply-To mặc định. |
| `LUMIBASE_MAIL_ENABLED` | không | Đặt `"false"` để tắt toàn bộ gửi email (kill switch). |
| `LUMIBASE_RUNTIME` | không | `"cloudflare"` ⇒ dùng MailChannels; còn lại ⇒ SMTP. Mặc định `"docker"`. |

### Quyết định transport

```
LUMIBASE_RUNTIME === 'cloudflare' → MailChannels (HTTP)
ngược lại                         → SMTP qua LUMIBASE_SMTP_URL (null nếu chưa set → degraded)
```

> **Deliverability:** trên Cloudflare/MailChannels cần cấu hình SPF/DKIM/DMARC ở tầng DNS; adapter không tự kiểm tra. Trên SMTP, deliverability phụ thuộc nhà cung cấp.

### Chế độ degraded

Khi không có transport (Workers thiếu MailChannels, hoặc Docker thiếu `LUMIBASE_SMTP_URL`, hoặc `LUMIBASE_MAIL_ENABLED=false`), `EmailService.fromEnv()` trả về `null`. Khi đó:
- `GET /api/v1/email/capabilities` trả `configured: false` để UI hiển thị cảnh báo.
- `POST /api/v1/email/send` trả `503 EMAIL_NOT_CONFIGURED`.
- Luồng mời teammate **degrade im lặng** (vẫn tạo user `invited`, chỉ không gửi mail).

## 3. Template & layout

- **Layout** = vỏ HTML tái dùng, bắt buộc chứa slot `{{content}}`. Branding/header/footer/style đặt một chỗ.
- **Template** = thông điệp có địa chỉ (`key`, vd `teammate_invite`) gồm `subject` + `bodyHtml`, tùy chọn `bodyText`, tùy chọn gắn một layout.

### Cú pháp biến (render engine)

| Cú pháp | Hành vi |
|---|---|
| `{{ name }}` | Thay + **escape HTML** (mặc định, an toàn cho biến không tin cậy). |
| `{{{ name }}}` | Thay **không escape** (chỉ dùng cho HTML đã tin cậy). |
| `{{content}}` | Slot trong layout để chèn body template đã render. |

Biến được tham chiếu nhưng không có trong `variables` ⇒ render thành chuỗi rỗng và được gom vào `missing` (không bao giờ để lại literal `{{x}}` trong mail). Nếu không có `bodyText`, engine tự suy ra text/plain từ HTML.

## 4. HTTP API

Mount dưới `/api/v1/email/*`, **trong** stack đã xác thực, gated bởi `requireSiteAdmin()`. Mọi query đều scoped theo `site_id`. Envelope chuẩn `{ data }` / `{ errors: [...] }`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/email/capabilities` | Báo transport có sẵn + `from`. |
| GET/POST | `/email/layouts` | List / tạo layout. |
| PATCH/DELETE | `/email/layouts/:id` | Sửa / xóa layout. |
| GET/POST | `/email/templates` | List / tạo template. |
| PATCH/DELETE | `/email/templates/:id` | Sửa / xóa template. |
| POST | `/email/templates/:key/preview` | Render thử (không gửi), trả `{ subject, html, text, missing }`. |
| POST | `/email/send` | Render (nếu `templateKey`) + gửi. **Điểm tích hợp cho extension.** |
| POST | `/email/test` | Gửi một mail test tới một địa chỉ. |

### `POST /email/send`

```jsonc
{
  "to": ["teammate@example.com"],          // bắt buộc, 1..50
  "cc": ["lead@example.com"],              // tùy chọn
  "replyTo": "support@example.com",        // tùy chọn
  // chọn ĐÚNG MỘT trong hai:
  "templateKey": "teammate_invite",        // render template đã lưu
  "inline": { "subject": "Hi", "html": "<p>…</p>", "text": "…" },
  "variables": { "name": "Sam" }
}
```

Phản hồi: `{ data: { sent: true, subject } }`, hoặc `502 DELIVERY_FAILED` (kèm `retryable`), `404 NOT_FOUND` (template), `503 EMAIL_NOT_CONFIGURED`.

## 5. Quản lý qua UI

Studio → **Settings → Email**:
- **Status**: hiển thị transport đã cấu hình hay chưa.
- **Templates**: tạo/sửa key, subject, layout, body HTML; pane **Preview** gọi `/preview` với JSON biến mẫu, render trong iframe; cảnh báo biến thiếu.
- **Layouts**: vỏ HTML có slot `{{content}}`.
- **Send test**: gửi mail test nhanh.

## 6. Mời teammate (invite email)

Route `POST /api/v1/users/invite` sau khi tạo bản ghi `invited` sẽ gửi email best-effort (qua `ctx.waitUntil` trên Workers, fire-and-forget trên Node — không bao giờ làm hỏng invite):
- Nếu site có template `teammate_invite` (enabled) ⇒ dùng nó.
- Nếu không ⇒ dùng message dựng sẵn trong `apps/cms/src/modules/email/invite.ts`.

> Lưu ý: invite **trong wizard setup** vẫn chỉ tạo bản ghi, **không** gửi email — vì ở thời điểm setup transport thường chưa cấu hình. Muốn tùy biến nội dung, tạo template `teammate_invite` trong Studio rồi mời lại qua trang Users.

## 7. Tích hợp từ extension

Extension **không** tự gửi SMTP — nó gọi `POST /api/v1/email/send` của core với một `templateKey`. Xem ví dụ đầy đủ ở [`examples/extension-email-setup`](../../../examples/extension-email-setup/README.md) và hướng dẫn ở [contributing/extension-dev.md](../contributing/extension-dev.md).

## 8. Bảo mật & ghi chú

- Template không bao giờ nhúng secret: payload không mang password hash/token (đảm bảo bởi kiểu dữ liệu).
- Biến được escape HTML mặc định ⇒ tránh injection từ dữ liệu người dùng.
- Mọi lần gửi đều ghi audit (`email_sent` / `email_send_failed`) kèm `templateKey`, số người nhận, subject (không log nội dung body).
