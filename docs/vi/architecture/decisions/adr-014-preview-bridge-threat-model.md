---
version: 1
lastUpdated: 2026-11-15T19:48:28.721Z
sourceLang: en
translatedFrom: en
sourceHash: 32f370d0d5d7af2b
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T19:48:28.721Z
codeVerifiedHash: 32f370d0d5d7af2b
codeVerifiedClaims: 8
---

# ADR-014: Cầu nối live preview — preview token, nhúng frame và threat model của postMessage

**Date:** 2026-11-15
**Status:** Accepted

## Context

Epic #667 thêm live preview và visual editing: trình sửa item của Studio nhúng
frontend của chính site vào frame, đẩy giá trị field chưa lưu vào đó, và cho
biên tập viên bấm vào một phần tử trên trang để nhảy tới field tương ứng. Việc
này cần ba thứ LumiBase chưa có:

1. một credential cho phép frontend **public** đọc nội dung **draft** trong
   thời gian ngắn;
2. một trang Studio nhúng frame từ **origin của bên thứ ba**;
3. một kênh `postMessage` hai chiều giữa hai origin.

Hai lỗ hổng đã công bố của đối thủ đặt ra mức chuẩn:

- **Sanity #12794** — preview secret bị ghi nhầm dataset trong Studio nhiều
  workspace, nên secret của workspace này dùng được ở workspace khác. Theo cách
  nói của LumiBase: credential preview cấp cho site A không bao giờ được đọc
  site B.
- **Builder.io #4501** (CWE-346) — visual editor nhận `postMessage` từ mọi
  origin và hành động theo nó, dẫn tới chạy code cross-origin.

TinaCMS #7134 (overlay re-hydrate trang ở mỗi phím gõ và chạm trần payload
1 MB) và Sanity #12806 (Safari sandbox iframe cross-origin) là các kiểu hỏng về
độ tin cậy cần thiết kế để tránh.

### Assets

| Tài sản | Vì sao quan trọng |
|---|---|
| Nội dung draft | Chưa xuất bản, có thể đang bị cấm công bố. |
| Preview token | Đọc nội dung draft mà không cần session Studio. |
| Session Studio (bearer token ở origin Studio) | Toàn quyền biên tập/admin. |
| Sự chú ý của biên tập viên | Một cú bấm trong frame dời focus trong Studio. |

### Attackers

| Kẻ tấn công | Khả năng |
|---|---|
| A1 — người có preview URL bị lộ | Có chuỗi token. |
| A2 — admin của tenant khác | Có credential hợp lệ ở site B, muốn đọc draft của site A. |
| A3 — trang độc hại hoặc bị chiếm | Có thể nhúng frontend hoặc bị nhúng; có thể `postMessage` bất cứ gì. |
| A4 — frontend bị chiếm | Chạy bên trong frame preview của Studio. |
| A5 — template collection độc hại | Một `meta.previewUrl` kiểu `javascript:…`. |

## Decision

### 1. Preview token gắn site hai lớp, thu hồi được và sống ngắn (V01)

- Token là JWT HS256 có khoá dẫn xuất **theo từng site**:
  `HMAC-SHA256(JWT_SECRET, "lumibase:preview:v1|" + siteId)`. Audience là
  `lumibase-preview:<siteId>`. Token của site A trượt bước kiểm **chữ ký** ở
  site B trước mọi lần đọc database (A2).
- Mỗi token được mint có một dòng trong `lumibase_preview_secrets` (`site_id`,
  SHA-256 của token, đích, `created_by`, `expires_at`, `revoked_at`). Lần đọc
  public đòi **cả** chữ ký hợp lệ **và** một dòng còn sống trên site đang được
  gọi, nên thu hồi được từng token và xoay vòng được mọi token của một site
  cùng lúc (`POST /api/v1/preview/tokens/revoke-all`). Plaintext chỉ trả về một
  lần, lúc mint; không bao giờ được lưu hay ghi log.
- Thời hạn mặc định 900 s, trần 3600 s (`preview.ttlSeconds`).
- Lần đọc chạy với quyền của **người tạo**, đánh giá lại ở mỗi lần đọc: token
  không bao giờ đọc được nhiều hơn những gì biên tập viên đã mint nó đọc được
  hiện tại, và chết khi người đó mất quyền (A1).
- Mọi lỗi — sai định dạng, sai site, hết hạn, bị thu hồi, người tạo mất quyền —
  đều trả cùng một body `401`, nên endpoint không thành oracle. Lỗi có chữ ký
  hợp lệ được audit (`preview.token_rejected`); mint, đọc, thu hồi và xoay vòng
  cũng được audit.
- Response có `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`. Token được nhận ở header
  `x-lumibase-preview` (nên dùng) hoặc `?__preview=`.
- Chỉ user principal mới mint được (không dùng API key) và bị rate limit theo
  user (30/phút).

### 2. Nhúng frame được allowlist ở cả hai phía (V02, V05)

- **Phía Studio.** Studio chỉ nhúng một URL khi origin của nó là origin của
  chính template collection hoặc nằm trong `preview.allowedOrigins` của site
  (chính xác `scheme://host[:port]`, không wildcard). Studio từ chối URL cùng
  origin với Studio: frame cùng origin có `allow-scripts allow-same-origin` có
  thể tự gỡ sandbox của mình (A4).
- Frame dùng `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`,
  `referrerpolicy="no-referrer"`, `allow=""` (không có tính năng nhạy cảm). Không
  có `allow-top-navigation`, nên frame không điều hướng được Studio.
- HTML Studio do CMS phục vụ mang `frame-src` (mặc định
  `https: http://localhost:* http://127.0.0.1:*`, siết lại bằng
  `LUMIBASE_STUDIO_FRAME_SRC`). Baseline vẫn giữ `frame-ancestors 'none'` cho
  chính Studio, và không CSP nào cho phép `unsafe-eval`.
- **Phía frontend.** Frontend phải gửi
  `Content-Security-Policy: frame-ancestors 'self' <studio origin>` để chỉ Studio
  nhúng được nó (A3 nhúng frontend để điều khiển nó khi đó bị trình duyệt chặn,
  và dù sao cũng bị §3 chặn).
- `meta.previewUrl` được kiểm khi ghi (CMS) và trước khi dùng (Studio): URL
  `http(s)` tuyệt đối, chỉ chứa các placeholder đã biết; mọi giá trị đi qua
  `encodeURIComponent` (A5).

### 3. Cầu nối nhận dữ liệu, không bao giờ nhận code (V03, V05)

Cả hai chiều đi qua một cổng dùng chung (`@lumibase/visual-editing/protocol`),
theo thứ tự:

1. `event.origin` nằm trong allowlist **chính xác** — không bao giờ `*`, không
   bao giờ `null`;
2. `event.source` là window mong đợi (`contentWindow` của iframe ở Studio;
   `window.parent` ở frontend);
3. payload JSON tối đa 64 KiB;
4. payload khớp schema Zod **strict** của chiều đó (key lạ, sai channel/version
   và định danh sai định dạng đều bị từ chối).

Mọi thứ trượt đều bị bỏ và được báo lại (`onReject`, mặc định `console.warn`).
Message gửi đi luôn ghi rõ origin đích. Sau bắt tay, frontend khoá vào đúng một
origin Studio đã chào nó.

Không gì trong message được thực thi, dùng làm URL để điều hướng, hay chèn như
HTML: giá trị field được áp bằng `textContent` hoặc giao cho ứng dụng như dữ
liệu. Patch ở mức field, gộp một lần mỗi animation frame, tối đa 50 field mỗi
message, và hàng đợi quá đầy sẽ gộp thành một lần reload (backpressure thay vì
phình vô hạn).

Overlay không làm gì trừ khi trang nằm trong frame và đang ở chế độ preview, và
có kích thước ≤ 15 kB gzip (kiểm trong CI).

## Consequences

- Một preview URL bị lộ bị giới hạn bởi TTL, việc thu hồi, quyền hiện tại của
  người tạo và `noindex`/`no-store`; site admin vô hiệu hoá được mọi token bằng
  một lần xoay vòng.
- Đổi `JWT_SECRET` làm mất hiệu lực mọi preview token của mọi site (khoá site
  dẫn xuất từ nó); đó là chủ ý.
- Operator phục vụ frontend từ origin khác origin của template phải thêm nó vào
  `preview.allowedOrigins`; operator muốn giới hạn frame hẹp hơn "mọi origin
  https" thì đặt `LUMIBASE_STUDIO_FRAME_SRC`.
- Token nằm trong URL mà Studio mở (frontend cần nó). Frontend mẫu chuyển nó
  vào cookie `httpOnly` ở request đầu rồi redirect, nên nó không còn trong URL
  trang, HTML hay bundle.
- Phạm vi trình duyệt: e2e cầu nối cross-origin
  (`packages/visual-editing/e2e/bridge.e2e.mjs`) chạy Chromium và WebKit; engine
  nào chưa cài được báo là skipped, không phải passed.

## Security review checklist

Mọi thay đổi trên bề mặt preview phải giữ đúng tất cả các mục dưới đây (cũng
được liệt kê trong `.kiro/steering/definition-of-done.md`):

- [ ] Query preview chạy trên `scopedDbFor(c, siteId)` với site lấy từ URL; token
      không bao giờ chọn site.
- [ ] Một body `401` cho mọi lỗi token; không thêm lỗi phân biệt được.
- [ ] Không `postMessage(…, '*')`; mọi handler inbound gọi `acceptPreviewMessage`.
- [ ] Không giá trị message nào tới `innerHTML`, `eval`, `Function`, `location` hay `src`.
- [ ] Không `unsafe-eval` trong CSP nào; Studio giữ `frame-ancestors 'none'`.
- [ ] Bundle overlay giữ ≤ 15 kB gzip.
