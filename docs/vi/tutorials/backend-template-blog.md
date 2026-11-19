---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T09:00:27.434Z
translatedFrom: en
sourceHash: 4a73874cf7ffed05
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T09:00:27.434Z
codeVerifiedHash: 4a73874cf7ffed05
codeVerifiedClaims: 12
---

# Tạo backend blog từ một template

Trong tutorial này bạn tạo một backend blog hoàn chỉnh trong một site từ
template chính thức `wordpress-alike`. Bạn làm theo ba cách: bằng REST API,
bằng một agent qua MCP, và trong Studio. Sau đó bạn thêm nội dung của chính
mình vào. Tham khảo: [Backend templates](../features/backend-templates.md).

Bạn cần một token site admin (`$TOKEN`), site cần cài vào (`$SITE`) và origin
của CMS (`$CMS`).

## Template là gì, và không phải là gì

- **Một content model, không phải một bản triển khai.** Template tạo các
  collection, field và relation, và tuỳ chọn một ít nội dung demo, trong site
  bạn chỉ định. Nó không tạo frontend, server, database hay project nào.
- **Collection logic, không phải bảng vật lý.** Collection là các dòng trong
  các bảng schema của site, và mỗi item là một dòng của `lumibase_items` với
  giá trị nằm trong một cột JSONB (`storageModes: ["jsonb"]`). Cài một
  template **không** tạo bảng vật lý nào cho từng collection. Hai site có thể
  cài cùng một template, và chúng vẫn độc lập với nhau.
- **Không tự động cho public truy cập.** Việc cài không tạo role, policy,
  permission hay user nào. Các collection mới không đọc được qua Delivery API
  công khai cho tới khi bạn cấp quyền, như mọi collection bạn tự tạo.
- **Không phải WordPress.** `wordpress-alike` mượn các khái niệm quen thuộc
  của WordPress (post, page, category, tag, comment). Không có PHP, không
  tương thích WordPress REST API, và không có plugin hay theme. Author của nó
  là hồ sơ nội dung, không phải tài khoản đăng nhập.

## 1. Tìm template

```bash
curl -s "$CMS/api/v1/backend-templates/official" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE"
```

Kết quả liệt kê `wordpress-alike` với version `1.0.0`.

## 2. Xem trước việc cài (plan)

Một plan chốt revision chính xác, kiểm tra tương thích và xung đột tên, và
liệt kê những gì sẽ được tạo. Nó không ghi schema hay nội dung nào. Site đích
luôn phải tường minh, và phải là site của request.

```bash
curl -s -X POST "$CMS/api/v1/backend-templates/plans" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { "source": "official", "slug": "wordpress-alike", "version": "1.0.0" },
    "targetSiteId": "'"$SITE"'"
  }'
```

`data.report.counts` cho thấy 8 collection và `seedRecords: 0`: không có seed
pack thì chỉ schema được tạo. Để kèm nội dung demo tổng hợp, thêm
`"seedMode": "pack", "seedPack": "demo"`. Nếu site đã có collection `posts`,
plan trả về `409 NAME_CONFLICT`. Thêm tiền tố bằng
`"namespace": { "prefix": "blog_" }` để cài song song.

Một plan hết hạn sau 15 phút.

## 3. Cài đặt

```bash
curl -s -X POST "$CMS/api/v1/backend-templates/installations" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "planId": "<data.id from step 2>", "idempotencyKey": "blog-1" }'
```

Mọi thứ commit trong một transaction, hoặc không gì cả. Gửi lại đúng request
đó trả về cùng installation (`meta.replayed: true`), nên thử lại là an toàn.
Đọc lại sau bằng `GET /api/v1/backend-templates/installations/<id>`.

## 4. Cùng việc đó với một agent (MCP)

Trên `POST /api/v1/mcp` (khi cờ `contentOs.mcp` của site được bật), một agent
gọi `planBackendTemplate` với cùng đầu vào như bước 2. Nếu người dùng chưa
nói site nào, tool trả về `MISSING_INPUT` và agent phải hỏi. Sau đó agent gọi
`instantiateBackendTemplate` với `planId` và `binding` được trả về:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "instantiateBackendTemplate",
              "arguments": { "planId": "<planId>", "expect": { "...": "the binding, unchanged" } } } }
```

Kết quả là `pending_approval`. Một người duyệt nó trong Studio (Mission
Control → Inbox), hoặc bằng `POST /api/v1/agent/approvals/<approvalId>/decide`
với `{ "decision": "approved" }`. Nếu có gì của plan đã đổi kể từ lúc đó,
approval không ghi gì (`BINDING_MISMATCH`). Agent sau đó đọc kết quả bằng
`getBackendTemplateInstallation` với `{ "installationId": "<planId>" }`.

## 5. Cùng việc đó trong Studio

Mở **Data model → Backend templates** và chọn **WordPress alike** cùng
revision **1.0.0**. Chọn site đích; không có mặc định. Để tắt nội dung demo.
Bấm **Preview**, kiểm tra các con số và danh sách collection, rồi bấm
**Install**. Đổi bất kỳ lựa chọn nào sau khi preview sẽ tắt **Install** cho
tới khi bạn preview lại.

## 6. Thêm nội dung của bạn

Các collection đã cài là collection bình thường. Dùng item API, Studio hoặc
các item tool của MCP với quyền bình thường của site:

```bash
curl -s -X POST "$CMS/api/v1/items/authors" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "data": { "name": "Ana", "slug": "ana" } }'
```

Một post thiếu `title` bắt buộc bị từ chối, và `status` phải là một trong
`draft`, `published` hoặc `private`. Không cần seed lại gì cả, và sửa nội dung
không bao giờ thay đổi template.

## Tự làm template của bạn

Capture các collection của một site thành draft bằng
`POST /api/v1/backend-templates/capture`, hoặc nhập một document JSON bằng
`POST /api/v1/backend-templates`. Publish nó bằng
`POST /api/v1/backend-templates/<id>/publish`, việc này tạo một revision bất
biến. Sau đó plan và cài như trên, với
`"template": { "source": "site", "slug": "<slug>", "version": "<version>" }`.
