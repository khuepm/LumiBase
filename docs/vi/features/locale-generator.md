---
version: 2
lastUpdated: 2026-11-15T19:56:17.582Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: eaf803d4e34db9d2
codeVerified: 2026-11-15T19:56:17.582Z
codeVerifiedHash: eaf803d4e34db9d2
codeVerifiedClaims: 20
---

# Locale generator

**Settings → Localization → Add a locale** (`/settings/locale-generator`) dựng một locale mới trong một bước: thêm locale vào setting `locales` của site, rồi dịch mọi giá trị còn thiếu của các collection đã chọn và UI string của site vào một **hàng đợi review** (#714, epic #671 A06). Không bản dịch máy nào tới được nội dung cho tới khi một reviewer duyệt.

## Một giá trị được dịch thế nào

Với mỗi item của từng collection đã chọn, mỗi field `translatable-text` có văn bản ở locale nguồn và chưa có gì ở locale mới trở thành một suggestion. UI string là các dòng của bảng `translations` thuộc namespace `ui` chưa có dòng ở locale mới.

Mỗi giá trị đi qua pipeline [translation memory](./translation-memory.md) sẵn có: translation memory trước (khớp từ ngưỡng mặc định trở lên thì dùng nguyên, `origin: tm`), rồi glossary và MT provider (`origin: mt`, ghi lại provider). Provider là cái được nêu trong request, nếu không thì Workers AI khi có binding, nếu không thì provider đầu tiên được cấu hình (`DEEPL_API_KEY`, `OPENAI_API_KEY`). Không cấu hình provider nào thì request bị từ chối với `PROVIDER_UNAVAILABLE`; provider thử nghiệm `echo` chỉ được dùng khi gọi đích danh.

## Job

`POST /api/v1/locale-generation/jobs` với `{ locale, sourceLocale?, collections, includeUi?, provider? }` validate request (`VALIDATION`, `NO_TRANSLATABLE_FIELDS`, `409 JOB_ACTIVE` khi locale đã có job đang chạy), dựng setting locale và trả `202` kèm job. Request tự chạy job tối đa 20 giây; một tick mỗi phút trên cả Docker (`serve.ts`) và Cloudflare (`cloudflare.ts`) chạy tiếp từ cursor mỗi khi lease rảnh, nên một lần restart không bao giờ lặp hay bỏ sót một chunk. Tiến độ (`counters`: items, suggestions, từ memory, máy, bỏ qua, lỗi) và trạng thái review của các suggestion nằm ở `GET /jobs/:id`. `POST /jobs/:id/cancel` dừng job đang chạy giữa hai chunk; `POST /jobs/:id/resume` đưa job lỗi hoặc đã huỷ trở lại hàng đợi tại cursor của nó. Giá trị dịch lỗi được đếm và job chạy tiếp; provider không tồn tại làm job thất bại.

Suggestion là duy nhất theo site, đích và locale, nên chạy lại generator chỉ xếp hàng những gì vẫn còn thiếu.

## Review

`GET /api/v1/locale-generation/suggestions?locale=…&status=pending` liệt kê hàng đợi kèm provenance (`origin`, `provider`, `tmScore`, `jobId`). `POST /suggestions/:id/decide` với `{ decision: 'approve', text? }` hoặc `{ decision: 'reject' }` áp một quyết định; `POST /suggestions/decide-bulk` áp tối đa 200.

Duyệt sẽ đọc lại item **bằng chính quyền của reviewer** và ghi locale mới vào map của field qua item service, nên quyền field, validation, pinned field, revision và audit log đều được áp. Duyệt bị từ chối với `stale` (và không ghi gì) khi văn bản nguồn đã đổi kể từ lúc tạo suggestion hoặc ai đó đã ghi locale mới. Một lần ghi bị item service từ chối giữ suggestion ở trạng thái pending (`422`). UI string được duyệt trở thành một dòng `translations`. Mọi giá trị được duyệt được thêm vào translation memory (`source: human` khi reviewer đã sửa), nên lần chạy sau dùng lại được.

## Quyền truy cập

`/api/v1/locale-generation` là tiền tố control plane: chỉ site administrator tới được. Văn bản nguồn được đọc trên kết nối của job, trong phạm vi site; nội dung chỉ được ghi khi duyệt, dưới danh nghĩa reviewer.

## Multi-tenancy

Job và suggestion mang `site_id` và có trong `rls-policies.sql`; mọi truy vấn lọc theo site của request, và tick resume xử lý từng job trong site của nó. Kiểm bằng `locale-generation.db.integration.test.ts` (PostgreSQL thật, hai site, MT provider giả).
