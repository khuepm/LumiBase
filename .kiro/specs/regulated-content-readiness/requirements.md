# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Regulated / Sensitive Content Readiness** — tập năng lực nền tảng giúp LumiBase (CMS) đủ điều kiện phục vụ các dự án dữ liệu nhạy cảm / được quản lý (regulated), với use case dẫn dắt là **content backend cho app sức khoẻ** chứa dữ liệu sức khoẻ cá nhân (PHI/PII).

**Nguyên tắc phạm vi (không thương lượng):** LumiBase **vẫn là một CMS đa dụng**. Mọi năng lực trong tài liệu này là **generic** (tổng quát, cấu hình được per-site / per-collection / per-field). Tài liệu **KHÔNG** định nghĩa schema y tế cứng, **KHÔNG** biến CMS thành ứng dụng sức khoẻ. "Health" chỉ là phép thử về độ nghiêm ngặt.

Tính năng phải hoạt động trên **cả hai runtime** (Cloudflare Workers và Docker/Node) thông qua lớp runtime abstraction hiện có.

Sáu khối năng lực:

1. **Field Encryption Hardening** — mã hoá field fail-closed, có AAD, versioning + rotation, qua lớp KMS abstraction.
2. **Field Data Classification** — gắn nhãn nhạy cảm (`none|internal|pii|phi`) điều khiển masking, bắt buộc mã hoá, và audit truy cập field.
3. **Content Scheduling** — hẹn giờ publish/unpublish content.
4. **Editorial Review Workflow** — luồng review→approve→publish do con người ký duyệt (HITL), tách bạch với AI veto-window.
5. **Data Erasure & Retention** — xoá cứng/crypto-shredding theo yêu cầu chủ thể (GDPR), audit chống giả mạo, retention policy, export SAR.
6. **Structured SEO/AIO Delivery** — phân phối metadata SEO có cấu trúc (OpenGraph/JSON-LD) + SDK helper + ví dụ frontend tham chiếu.

## Glossary

- **CMS**: Backend Hono tại `apps/cms`, REST API prefix `/api/v1`.
- **Studio**: Admin UI tại `apps/studio` (React + TanStack Router).
- **Runtime_Context**: Lớp abstraction tại `packages/runtime` cung cấp `cache/storage/database/search/queue/media`; cần mở rộng thêm `secret`/`keys`.
- **Field_Classification**: Nhãn độ nhạy cảm của một field — `none | internal | pii | phi`.
- **Encrypted_Field**: Field có `encrypted=true`, giá trị được CryptoService mã hoá trước khi ghi DB.
- **CryptoService**: Service mã hoá đối xứng AES-GCM tại `apps/cms/src/services/crypto-service.ts`.
- **DEK** (Data Encryption Key): Khoá mã hoá dữ liệu thực tế. **KEK** (Key Encryption Key): Khoá bọc DEK (envelope encryption).
- **Key_Provider**: Interface mới trong Runtime_Context trả về khoá theo `keyId/version`, hỗ trợ nhiều khoá active để rotate.
- **AAD** (Additional Authenticated Data): Dữ liệu ngữ cảnh được xác thực kèm ciphertext trong AES-GCM, không mã hoá nhưng chống thay/chuyển ciphertext.
- **Ciphertext_Envelope**: Định dạng ciphertext mới `v{n}:{payload}` mang version khoá; định dạng cũ (không prefix) coi là `v0`.
- **read_decrypted**: Permission action hiện hữu cho phép đọc giá trị đã giải mã của Encrypted_Field.
- **Field_Access_Log**: Bản ghi audit mỗi lần một field được phân loại `pii|phi` bị đọc ở dạng giải mã.
- **Publish_Window**: Khoảng `[publishAt, unpublishAt)` mà một item được coi là khả dụng công khai.
- **Scheduler**: Cơ chế reconcile định kỳ áp các chuyển trạng thái theo `publishAt`/`unpublishAt`, dùng QueueProvider + Flows schedule trigger.
- **Content_Review**: Bản ghi luồng duyệt nội dung do con người, gắn item + revision + reviewer + quyết định.
- **Editorial_State**: Trạng thái biên tập của item — `draft | in_review | approved | scheduled | published | rejected`.
- **Erasure_Request**: Yêu cầu xoá dữ liệu của một chủ thể (data subject), gồm phạm vi, lý do, người yêu cầu, trạng thái.
- **Crypto_Shredding**: Xoá DEK của bản ghi để dữ liệu mã hoá trở nên bất khả phục hồi, thay cho/đi kèm xoá vật lý.
- **SAR** (Subject Access Request): Yêu cầu xuất toàn bộ dữ liệu của một chủ thể.
- **Audit_Log**: Bảng `audit_log` (uuidv7) ghi sự kiện bảo mật/compliance.
- **Site_Id**: Định danh tenant; mọi bảng domain phải có `site_id` và mọi query phải scope theo nó.

## Requirements

### Requirement 1: Giải mã field fail-closed (toàn vẹn dữ liệu)

**User Story:** Là một người vận hành dữ liệu nhạy cảm, tôi muốn lỗi giải mã không bao giờ bị che giấu, để không một giá trị giả nào lọt vào hệ thống mà tôi tưởng là dữ liệu thật.

#### Acceptance Criteria

1. WHEN giải mã một Encrypted_Field thất bại (sai khoá, dữ liệu hỏng, AAD không khớp), THE CryptoService SHALL ném lỗi có mã `DECRYPTION_FAILED` và SHALL KHÔNG trả về chuỗi placeholder hay giá trị thay thế.
2. WHEN một lỗi `DECRYPTION_FAILED` xảy ra, THE CMS SHALL ghi một entry `decryption_failed` vào Audit_Log gồm `siteId`, `collection`, `field`, `recordId`, `keyId` (không kèm ciphertext hay khoá), và SHALL trả response `{ errors: [{ code: 'DECRYPTION_FAILED' }] }` với HTTP 500.
3. THE CryptoService SHALL KHÔNG ghi ciphertext, khoá, hoặc plaintext giải mã được vào log ở bất kỳ mức nào.
4. WHERE một collection bật cờ `degradedReadOnFailure=true`, WHEN giải mã một field thất bại trong thao tác đọc danh sách nhiều item, THE CMS SHALL bỏ qua field lỗi của riêng item đó (trả field đó là `null` kèm cờ `_decryptError: true` ở metadata item) thay vì làm hỏng toàn bộ response, và vẫn ghi Audit_Log theo tiêu chí 2.

### Requirement 2: AAD binding cho ciphertext

**User Story:** Là kỹ sư bảo mật, tôi muốn ciphertext gắn chặt với ngữ cảnh của nó, để kẻ có quyền ghi store không thể tái sử dụng ciphertext sang record/field khác.

#### Acceptance Criteria

1. WHEN mã hoá một Encrypted_Field, THE CryptoService SHALL truyền AAD = chuỗi canonical `"{siteId}|{collection}|{field}|{recordId}"` vào phép AES-GCM.
2. WHEN giải mã, THE CryptoService SHALL truyền cùng AAD; nếu AAD không khớp, THE phép giải mã SHALL thất bại theo Requirement 1.
3. WHERE một record chưa có `recordId` tại thời điểm mã hoá (ví dụ tạo mới chưa flush), THE service SHALL dùng `recordId` đã được phân bổ trước khi mã hoá (ID sinh ở tầng ứng dụng, không phụ thuộc DB).
4. THE định dạng AAD SHALL được mô tả một chỗ duy nhất (helper dùng chung) và SHALL không phụ thuộc thứ tự field.

### Requirement 3: Key versioning và rotation

**User Story:** Là người vận hành, tôi muốn xoay khoá mã hoá mà không phải re-encrypt toàn bộ ngay lập tức, để vận hành an toàn và không downtime.

#### Acceptance Criteria

1. THE Ciphertext_Envelope SHALL mang prefix version `v{n}:` xác định khoá đã dùng để mã hoá.
2. WHEN giải mã một ciphertext không có prefix version, THE CryptoService SHALL coi đó là `v0` và dùng khoá `ENCRYPTION_KEY` hiện hành để giải mã (tương thích ngược).
3. THE Key_Provider SHALL hỗ trợ nhiều khoá ở trạng thái khác nhau: đúng một khoá `active` (dùng để mã hoá mới) và không giới hạn khoá `retired` (chỉ dùng để giải mã).
4. WHEN một khoá ở trạng thái `retired`, THE CMS SHALL vẫn giải mã được ciphertext mã bằng khoá đó nhưng SHALL KHÔNG dùng nó để mã hoá mới.
5. THE CMS SHALL cung cấp endpoint quản trị `POST /api/v1/admin/encryption/keys/rotate` (yêu cầu quyền admin) để thêm khoá active mới và chuyển khoá cũ sang `retired`; thao tác này SHALL ghi Audit_Log `encryption_key_rotated`.
6. THE CMS SHALL cung cấp tác vụ nền re-encrypt (rewrap) tuỳ chọn để dần nâng ciphertext cũ lên khoá active; tác vụ này SHALL idempotent và resume được qua cursor.

### Requirement 4: Lớp KMS / Key Provider trong Runtime abstraction

**User Story:** Là kỹ sư nền tảng, tôi muốn cấp khoá qua một interface runtime thống nhất, để Cloudflare và Docker dùng chung business logic không lộ binding.

#### Acceptance Criteria

1. THE `packages/runtime` SHALL định nghĩa interface `KeyProvider` với tối thiểu `getActiveKey(): { keyId, key }`, `getKey(keyId): key`, `listKeys(): KeyMeta[]`.
2. THE Cloudflare adapter SHALL hiện thực `KeyProvider` đọc khoá từ Workers Secrets / KV binding; THE Docker adapter SHALL hiện thực từ biến môi trường và `*_FILE` (tương thích cơ chế secret-file hiện có ở `config/production.ts`).
3. THE business logic (services) SHALL truy cập khoá chỉ qua `Runtime_Context.keys` và SHALL KHÔNG import binding Cloudflare trực tiếp.
4. WHERE không có `KeyProvider` được cấu hình, THE CMS SHALL fallback về `ENCRYPTION_KEY` đơn (hành vi `v0`) để không phá vỡ cài đặt hiện tại.
5. WHERE bật chế độ envelope (`LUMIBASE_ENVELOPE_ENCRYPTION=true`), THE CMS SHALL sinh DEK per-record, bọc DEK bằng KEK từ `KeyProvider`, và lưu DEK đã bọc cùng record (phục vụ Crypto_Shredding ở Requirement 13).
6. THE production validation (`config/production.ts`) SHALL kiểm tra cấu hình khoá hợp lệ ở production (định dạng base64 AES-GCM, không phải dev secret) và SHALL fail-fast lúc khởi động nếu thiếu.

### Requirement 5: Phân loại dữ liệu field

**User Story:** Là người quản trị, tôi muốn gắn nhãn độ nhạy cảm cho từng field, để hệ thống tự áp masking, mã hoá và audit phù hợp.

#### Acceptance Criteria

1. THE FieldDefinition (`packages/shared/src/field`) SHALL có thuộc tính tuỳ chọn `classification` nhận `none | internal | pii | phi`, mặc định `none`.
2. WHEN tạo/sửa một field có `classification` ∈ {`pii`,`phi`} mà `encrypted` không phải `true`, THE Schema service SHALL từ chối với mã `CLASSIFICATION_REQUIRES_ENCRYPTION` (HTTP 422).
3. THE `classification` SHALL được compile vào `CompiledField` (`schema-service.ts`) để các service đọc được lúc runtime.
4. WHERE một field có `classification` ∈ {`pii`,`phi`}, THE mặc định masking SHALL coi field đó là ẩn trừ khi caller có quyền `read_decrypted` (không phụ thuộc field whitelist mặc định).
5. THE thay đổi `classification` của field hiện có SHALL được ghi Audit_Log `field_classification_changed`.

### Requirement 6: Audit truy cập field nhạy cảm

**User Story:** Là cán bộ tuân thủ, tôi muốn biết ai đọc dữ liệu PHI/PII và khi nào, để chứng minh trách nhiệm giải trình.

#### Acceptance Criteria

1. WHEN một caller đọc thành công giá trị giải mã của một field `classification` ∈ {`pii`,`phi`}, THE CMS SHALL ghi một Field_Access_Log gồm `siteId`, `collection`, `recordId`, `field`, `actor`, `action`, `requestId`, `timestamp` — và SHALL KHÔNG ghi giá trị đã giải mã.
2. THE Field_Access_Log ghi theo lô (batch) để không tạo một row mỗi field gây phình DB, nhưng SHALL đảm bảo mọi truy cập đều được ghi (không mất mát) trước khi response trả về cho thao tác đơn-item; với thao tác list nhiều item, ghi theo aggregate `{recordIds[], fields[]}`.
3. THE CMS SHALL cung cấp endpoint query Field_Access_Log có phân trang, lọc theo `actor`, `collection`, khoảng thời gian (yêu cầu quyền admin).
4. THE Field_Access_Log SHALL chịu RLS site-isolation như các bảng khác.

### Requirement 7: Hẹn giờ publish content

**User Story:** Là biên tập viên, tôi muốn đặt thời điểm bài tự lên và tự gỡ, để chạy chiến dịch nội dung mà không cần thao tác thủ công đúng giờ.

#### Acceptance Criteria

1. THE bảng `items` SHALL có cột tuỳ chọn `publishAt` (timestamp) và `unpublishAt` (timestamp).
2. WHEN `unpublishAt` ≤ `publishAt` (cả hai cùng được set), THE CMS SHALL từ chối với mã `INVALID_PUBLISH_WINDOW` (HTTP 422).
3. WHEN thời điểm hiện tại đạt `publishAt` của một item ở `scheduled`, THE Scheduler SHALL chuyển item sang `published` và phát các side-effect publish hiện hữu (revalidation, webhook) đúng một lần.
4. WHEN thời điểm hiện tại đạt `unpublishAt` của một item `published`, THE Scheduler SHALL chuyển item sang `archived` (hoặc `draft` theo cấu hình collection) và phát revalidation tương ứng.
5. THE Delivery API (`deliver.ts`) SHALL chỉ trả item nằm trong Publish_Window hiện tại (item `published` nhưng `publishAt` ở tương lai hoặc `unpublishAt` đã qua SHALL bị loại).
6. THE Scheduler SHALL idempotent và an toàn khi chạy trễ (catch-up): nhiều lần chạy trên cùng mốc thời gian SHALL không phát side-effect trùng.
7. THE Scheduler SHALL dùng `QueueProvider` + Flows schedule trigger hiện hữu, không tạo cơ chế nền song song mới.

### Requirement 8: State machine biên tập

**User Story:** Là tổ chức xuất bản nội dung độ chính xác cao, tôi muốn nội dung phải qua review và ký duyệt trước khi public, để kiểm soát chất lượng và trách nhiệm.

#### Acceptance Criteria

1. THE item SHALL có Editorial_State ∈ {`draft`,`in_review`,`approved`,`scheduled`,`published`,`rejected`} bổ sung trên/đồng bộ với cột `status` hiện hữu (`draft|published|archived`); ánh xạ giữa hai khái niệm SHALL được mô tả rõ trong design.
2. WHERE một collection bật `editorialWorkflow=true`, THE CMS SHALL chỉ cho phép chuyển một item sang `published` qua trạng thái `approved` (trực tiếp hoặc qua `scheduled`); chuyển thẳng `draft → published` SHALL bị từ chối với `EDITORIAL_GATE_REQUIRED` (HTTP 409).
3. WHERE một collection có `editorialWorkflow=false` (mặc định), THE hành vi publish hiện tại SHALL giữ nguyên không đổi.
4. THE các chuyển trạng thái hợp lệ SHALL được định nghĩa tập trung (transition table) và mọi chuyển sai SHALL bị từ chối với `INVALID_TRANSITION`.
5. THE mỗi chuyển trạng thái SHALL ghi Audit_Log `editorial_transition` gồm from/to/actor/itemId/revisionId.

### Requirement 9: Review và ký duyệt (HITL người)

**User Story:** Là reviewer, tôi muốn nhận, xem diff và ký duyệt/từ chối nội dung, để chịu trách nhiệm về nội dung được public.

#### Acceptance Criteria

1. WHEN một item được submit review, THE CMS SHALL tạo một Content_Review gắn `itemId`, `revisionId`, `requestedBy`, `status='pending'` và chuyển item sang `in_review`.
2. THE Content_Review SHALL hỗ trợ phân công `assignedTo` (user hoặc role) và SHALL chịu RLS site-isolation.
3. WHEN reviewer approve, THE CMS SHALL set `Content_Review.status='approved'`, `decidedBy`, `decidedAt`, và chuyển item sang `approved`; reviewer SHALL khác người `requestedBy` WHERE collection cấu hình `requireSeparateReviewer=true`.
4. WHEN reviewer reject kèm lý do, THE CMS SHALL set `status='rejected'` và chuyển item về `draft` (hoặc `rejected`), kèm lý do hiển thị cho author.
5. THE luồng review SHALL độc lập với AI veto-window (`agentApprovals`); design SHALL nêu rõ ranh giới: veto-window dành cho AI writes, Content_Review dành cho phê duyệt biên tập của con người.

### Requirement 10: Tích hợp Studio cho workflow & scheduling

**User Story:** Là người vận hành, tôi muốn quản lý lịch và duyệt nội dung ngay trong Studio, để không cần công cụ ngoài.

#### Acceptance Criteria

1. THE Studio content editor SHALL hiển thị và sửa được `publishAt`/`unpublishAt` cho collection bật scheduling.
2. THE Studio SHALL hiển thị Editorial_State hiện tại của item và các action hợp lệ (Submit for review / Approve / Reject / Schedule / Publish) theo quyền của user.
3. THE Studio SHALL có màn hình hàng đợi review (review queue) liệt kê item `in_review` được phân công cho user/role hiện tại.
4. WHERE user không đủ quyền cho một transition, THE action tương ứng SHALL bị disable (không ẩn thông tin trạng thái).

### Requirement 11: Xoá theo yêu cầu chủ thể (erasure) và crypto-shredding

**User Story:** Là DPO, tôi muốn thực thi quyền được lãng quên của chủ thể dữ liệu một cách bất khả phục hồi và có bằng chứng, để tuân thủ GDPR.

#### Acceptance Criteria

1. THE CMS SHALL cung cấp endpoint `POST /api/v1/admin/erasure` (yêu cầu quyền admin) tạo một Erasure_Request với phạm vi xác định (collection + bộ lọc khoá định danh chủ thể), `reason`, `requestedBy`, `status='pending'`.
2. WHEN một Erasure_Request được thực thi, THE CMS SHALL xoá vật lý (hard-delete) các item trong phạm vi và các `revisions` liên quan; WHERE envelope encryption bật, THE CMS SHALL thực hiện Crypto_Shredding (huỷ DEK của các record) để mọi ciphertext còn sót (kể cả backup) trở nên bất khả giải mã.
3. THE erasure SHALL KHÔNG cascade-xoá `audit_log` và `field_access_log`; THE CMS SHALL giữ chứng cứ đã xoá dưới dạng entry `data_erased` tamper-evident (gồm phạm vi, đếm bản ghi, hash của định danh chủ thể đã xoá — không lưu định danh dạng plaintext).
4. THE Erasure_Request SHALL có vòng đời `pending → confirmed → executing → completed | failed`; bước `confirmed` SHALL yêu cầu xác nhận của admin thứ hai WHERE site cấu hình `erasureDualControl=true`.
5. WHEN erasure hoàn tất, THE CMS SHALL phát revalidation/webhook để dọn cache delivery của các item bị xoá.

### Requirement 12: Retention policy

**User Story:** Là người vận hành, tôi muốn dữ liệu hết hạn lưu trữ tự bị dọn, để giảm bề mặt rủi ro và tuân thủ chính sách lưu trữ.

#### Acceptance Criteria

1. THE site SHALL cấu hình được Retention_Policy per-collection gồm `maxAgeDays` và `action` ∈ {`archive`,`hard_delete`,`crypto_shred`}.
2. THE Scheduler SHALL quét định kỳ và áp action cho item vượt `maxAgeDays` tính từ mốc cấu hình (`createdAt` hoặc `updatedAt`), idempotent.
3. WHEN retention áp `hard_delete`/`crypto_shred`, THE hành vi audit tamper-evident SHALL tuân theo Requirement 11.3.
4. THE mọi lần áp retention SHALL ghi Audit_Log `retention_applied` gồm collection, đếm bản ghi, action.

### Requirement 13: Export dữ liệu chủ thể (SAR)

**User Story:** Là DPO, tôi muốn xuất toàn bộ dữ liệu của một chủ thể, để đáp ứng yêu cầu truy cập dữ liệu.

#### Acceptance Criteria

1. THE CMS SHALL cung cấp endpoint `POST /api/v1/admin/sar/export` (yêu cầu quyền admin) nhận phạm vi (collection + bộ lọc định danh chủ thể) và trả về (hoặc tạo job tạo) một archive chứa dữ liệu đã giải mã của chủ thể.
2. THE thao tác SAR export SHALL ghi Audit_Log `sar_exported` và SHALL ghi Field_Access_Log cho các field `pii|phi` được giải mã theo Requirement 6.
3. THE archive SHALL ở định dạng máy đọc được (JSON) và SHALL gồm metadata provenance (`authorType`, `model`, nguồn) có sẵn trên revisions.
4. THE endpoint SHALL scope theo `site_id` và SHALL từ chối phạm vi vượt site của caller.

### Requirement 14: Phân phối SEO/AIO có cấu trúc

**User Story:** Là lập trình viên frontend, tôi muốn lấy metadata SEO đã chuẩn hoá từ Delivery API, để render `<head>` mà không phải tự suy luận.

#### Acceptance Criteria

1. THE Delivery API SHALL có khả năng trả khối `_seo` chuẩn hoá cho một item/page gồm `title`, `description`, `canonical`, `openGraph`, `jsonLd` (schema.org) dựng từ field interface `seo`/`aio` hiện hữu.
2. THE khối `jsonLd` SHALL là JSON-LD hợp lệ, type cấu hình được (mặc định `Article`/`WebPage`), KHÔNG hard-code type y tế.
3. WHERE một field bị loại do classification/permission, THE khối `_seo` SHALL KHÔNG chứa giá trị của field đó (không rò rỉ qua SEO).
4. THE `@lumibase/sdk` SHALL cung cấp helper trích `_seo` từ delivery response để dùng trong Next.js `generateMetadata`.

### Requirement 15: Ví dụ frontend tham chiếu

**User Story:** Là người mới, tôi muốn một ví dụ chạy được minh hoạ dự án Tier 2, để biết cách dùng đúng các năng lực mới.

#### Acceptance Criteria

1. THE repo SHALL có một ví dụ Next.js (mở rộng từ `examples/nextjs-blog`) minh hoạ: tiêu thụ Delivery API tôn trọng Publish_Window, render SEO/JSON-LD từ `_seo`, và ISR revalidation theo tag.
2. THE ví dụ SHALL KHÔNG render bất kỳ field `classification` ∈ {`pii`,`phi`} nào ra trang public; ví dụ SHALL minh hoạ ranh giới content công khai vs dữ liệu nhạy cảm.
3. THE ví dụ SHALL có README nêu rõ biến môi trường (`LUMIBASE_TOKEN`, `LUMIBASE_SITE_ID`) và cảnh báo không đặt token có quyền `read_decrypted` ở client public.

### Requirement 16: Bảo toàn tương thích & ràng buộc nền tảng

**User Story:** Là maintainer, tôi muốn các năng lực mới không phá vỡ cài đặt hiện có và tuân thủ quy tắc kiến trúc, để nâng cấp an toàn.

#### Acceptance Criteria

1. THE mọi bảng/cột mới SHALL có `site_id` (với bảng domain) và SHALL theo quy tắc ID: `nanoid` cho bảng domain, `uuidv7` cho bảng audit.
2. THE mọi response mới SHALL theo định dạng `{ data, meta? }` hoặc `{ errors: [...] }`.
3. THE mọi skill/endpoint có `schema:write` hoặc bắt đầu bằng `delete` SHALL đi qua HITL (`ai_approvals`) theo quy tắc hiện hữu.
4. THE migration mới SHALL additive/idempotent ở mức có thể (cột nullable/có default; guard `IF NOT EXISTS`) để không yêu cầu data migration bắt buộc cho cài đặt Tier 1 hiện tại.
5. THE site đang chạy với cấu hình mặc định (Tier 1, không classification, không editorialWorkflow, không scheduling) SHALL giữ hành vi không đổi sau khi nâng cấp.
