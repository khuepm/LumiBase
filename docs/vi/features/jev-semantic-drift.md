---
version: 7
lastUpdated: 2026-10-15T22:44:20.177Z
sourceLang: en
translatedFrom: en
sourceHash: 4966e3c190fcbd9e
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-15T22:44:20.177Z
codeVerifiedHash: 4966e3c190fcbd9e
codeVerifiedClaims: 16
---

# Drift ngữ nghĩa Jev cho Content Intent

Các rule xác định của một Content Intent (`required_fields`, `freshness`, `translations`, `link_health`, `field_constraint`, `glossary_compliance`) được kiểm tra bằng code. Rule `semantic` bổ sung một phán đoán mà các rule đó không làm được, ví dụ "bài này đi lệch khỏi brief" hay "đoạn này lệch giọng thương hiệu". Phán đoán đến từ một câu hỏi `noul` của một phiên bản [review profile](./draft-review.md) được ghim, hỏi qua cùng đường decision có governance với `POST /api/v1/ai/reviews`.

Tính năng chỉ phát hiện và đề xuất review. Nó không bao giờ sửa nội dung hay publish.

> **Trạng thái.** Pass ngữ nghĩa tắt mặc định (`aiDecisions.drift: false`). Fixture drift VI/EN đã có và được chấm bởi [Benchmark Jev](./jev-benchmark.md) (`--task drift`), nhưng chưa có lần chạy provider live nào. Chưa có số đo precision hay tỉ lệ false-positive.

## Rule

```json
{
  "type": "semantic",
  "key": "off-brief",
  "version": 1,
  "profileKey": "brief",
  "profileVersion": 3,
  "questionKey": "off_brief",
  "threshold": 0.8,
  "fields": ["title", "body"],
  "contextSource": "field:brief"
}
```

- `key` định danh rule qua các phiên bản và phải là duy nhất giữa các rule ngữ nghĩa của intent. Tăng `version` mỗi khi ý nghĩa của rule thay đổi. Một lần cập nhật intent đổi `profileKey`, `questionKey`, `contextSource` hoặc `fields` của một rule đã lưu mà không tăng `version` sẽ bị từ chối với `422 SEMANTIC_RULE_VERSION_REQUIRED` (`assertSemanticVersionBumps`), vì fingerprint giữ nguyên và câu trả lời cũ sẽ được dùng cho rule mới. `profileVersion` và `threshold` đổi được mà không cần tăng: phiên bản profile nằm trong fingerprint, còn ngưỡng được áp lên câu trả lời đã lưu ở mỗi pass.
- `profileKey` + `profileVersion` ghim một phiên bản review profile, và `questionKey` chỉ một câu hỏi `noul` trong đó. Câu hỏi hỏi item có drift hay không. Câu hỏi kiểu khác làm mọi lần đánh giá thành `unevaluated` (`question_not_noul`).
- `threshold` (0.5–1): `noul ≥ threshold` là drift, `1 − noul ≥ threshold` là sạch, còn lại ở giữa là `unevaluated` (`between_thresholds`). Với threshold 0.5, câu trả lời đúng bằng 0.5 thoả cả hai phía nên cũng là `unevaluated`.
- `fields` là các field được đánh giá (mặc định: field của profile). Chỉ field đồng thời là field của profile mới được đọc.
- `contextSource`: `intent` nghĩa là tiêu chí của profile là toàn bộ tham chiếu. `field:<name>` gửi thêm field đó của item (một brief, một dàn ý) làm tham chiếu. Field đó phải là field của profile, và nếu nó rỗng thì lần đánh giá là `unevaluated` (`context_missing`).

Schema là `ruleSchema` trong `apps/cms/src/services/intent-service.ts`. Phép ánh xạ kết quả và các helper fingerprint nằm trong `apps/cms/src/services/semantic-drift.ts`.

## Bật tính năng

Admin site đặt cả hai cờ trong setting `aiDecisions`:

```json
{ "enabled": true, "drift": true }
```

`enabled` là việc site đồng ý gửi nội dung tới provider, và tắt nó là kill switch. `drift` chỉ bật pass ngữ nghĩa. Khi một trong hai cờ tắt, scan báo `semantic.status: "off"`, không gửi gì, và giữ nguyên mọi hàng drift ngữ nghĩa. Mỗi lần gọi provider đều đọc lại cả hai cờ, và pass kiểm lại `drift` trước mỗi item, nên tắt `drift` sẽ dừng pass đang chạy ở item kế tiếp và giữ cursor. Site admin bật/tắt `drift` trong Studio ở **Settings → AI decisions** (**Evaluate semantic drift rules**), hoặc qua settings API. Các key khác của `aiDecisions` (ví dụ pilot kiểm tra bản nháp do Studio ghi) được giữ nguyên.

## Một lần scan chạy thế nào

`POST /api/v1/intents/:id/scan` và operation Flows `drift-scan` chạy các rule xác định trước, rồi tới pass ngữ nghĩa (`apps/cms/src/services/semantic-drift-scan.ts`):

- **Budget.** Tối đa `maxSemanticItems` item mỗi lần scan (mặc định 25, tối đa 500; là option của node `drift-scan`) và một deadline (`semanticTimeBudgetMs`, mặc định bằng time budget của scan). Pass tiếp tục từ `semantic_scan_cursor` trên intent, tách riêng với `scan_cursor` của pass xác định. Object `semantic` trong kết quả scan báo `items`, `drift`, `clean`, `unevaluated`, `skipped`, `opened`, `reopened`, `resolved`, `completed` và `cursor`.
- **Ai đọc.** Scan là một job của site, nên nó đọc qua `itemServiceForSystem(…, 'semantic-drift-scan')` (`reviewContentAccessForDriftScan`). Chỉ các field của rule trừ field đã ghim của item, cộng với field context, được đọc và gửi đi. Các field khác của profile được ghi là bị bỏ qua (omitted) trên review run.
- **Field đã ghim.** Field đã ghim không bao giờ được đánh giá. Nếu mọi field cần đánh giá đều đã ghim, rule được bỏ qua cho item đó, giống một rule xác định theo field.
- **Quyết định.** Mỗi item được đánh giá qua `ReviewService.runReview` với principal hệ thống `system:drift-scan`, nên opt-in của site, allowlist field, quota và audit `ai_decision` đều áp dụng. Sự kiện audit ghi principal `null` và request id `drift:<intentId>`.

## Fingerprint, retry và vô hiệu hoá

`rule_key` của một hàng drift ngữ nghĩa là `<key>@v<version>:<profileVersion>:<contentHash>`, và fingerprint của nó là `intentId:itemId:semantic:<rule_key>`. Content hash là hash review của J05 trên đúng phần đã gửi đi.

- **Retry.** Nội dung không đổi cho cùng fingerprint và cùng idempotency key của review. Run đã lưu được phát lại mà không gọi provider lần hai, và không mở drift hay goal thứ hai. Một run kết thúc bằng lỗi được thử lại tại chỗ. Idempotency key còn bao gồm định nghĩa của rule (profile, câu hỏi, context và fields), nên một rule bị xoá rồi thêm lại với profile khác dưới cùng key và version sẽ có review run mới thay vì câu trả lời của profile cũ.
- **Vô hiệu hoá.** Phiên bản rule mới, phiên bản profile mới hoặc nội dung thay đổi cho fingerprint mới. Trạng thái mới được đánh giá, và hàng cũ được resolve khi lần đánh giá đó có kết luận.
- **Rule bị gỡ.** Các hàng của một rule ngữ nghĩa mà intent không còn khai báo được resolve ở lần scan kế tiếp mà không cần phán đoán nào, kể cả khi intent không còn rule ngữ nghĩa nào và pass không chạy. Kết quả scan báo chúng là `semanticOrphansResolved`.

## Trạng thái không chắc chắn

Provider gián đoạn, lỗi quota hay timeout, câu trả lời nằm giữa hai ngưỡng, thiếu phiên bản profile hoặc field context rỗng đều ghi một hàng `unevaluated` kèm mã lý do. Một kết quả `unevaluated`:

- không bao giờ resolve drift cũ của rule đó trên item đó (`diffDrifts` không đụng vào các fingerprint đó);
- không bao giờ tạo goal (reconciler chỉ nhận drift `open`);
- mở lại thành `open` khi một pass sau phát hiện drift, và được resolve khi một pass sau có kết luận và không còn thấy drift.

Pass xác định bỏ qua các hàng ngữ nghĩa, nên một lần scan không có đường decision (scan verify của dispatcher) không bao giờ resolve drift ngữ nghĩa.

## Goal

Drift ngữ nghĩa đang mở thành goal qua `ReconcilerService.reconcileIntent` có sẵn, với cùng budget, breaker, kill switch và maintenance window như drift khác. Goal có tiêu đề `Review semantic drift "<key>" on <collection>/<item>`, và metadata của nó mang `reviewOnly: true` cùng `semantic` chứa provenance đã ghi: rule và phiên bản rule, key và phiên bản profile, câu hỏi, ngưỡng, content hash, revision, id của review run, provider, model, calibrated và câu trả lời. [Repair loop](./reconciler-repair-loop.md) (#455) không có skill sửa cho drift ngữ nghĩa, nên dispatcher chặn goal với lý do `HUMAN_REVIEW_REQUIRED`. Không có vòng approval thứ hai.

## Mission Control

Trang chi tiết intent liệt kê drift ngữ nghĩa kèm key và phiên bản rule, profile và phiên bản, câu hỏi, model, câu trả lời và ngưỡng, revision, content hash và review run, tất cả lấy từ những gì scan đã ghi. Một hàng `unevaluated` hiện mã lý do của nó và nói rằng drift cũ được giữ lại. Mô hình decision không trả về lời giải thích nào, nên không hiện lời giải thích nào. Bảng SLO bỏ các hàng `unevaluated` ra khỏi tỉ lệ health và hiện chúng thành một số đếm "not evaluated" riêng. Health hiện `unknown`, không phải 100 %, khi không có gì có kết luận đứng sau nó: drift không tải được, mọi hàng đều `unevaluated`, hoặc intent có rule ngữ nghĩa mà không có hàng nào có kết luận. Một câu trả lời ngữ nghĩa sạch và một pass bị tắt hay không khả dụng đều không để lại hàng nào, nên danh sách rỗng không phân biệt được hai trường hợp đó. Thẻ SLO health trên dashboard chỉ lấy trung bình các intent có health đã biết và đếm các intent chưa biết health trong nhãn. Một intent có health đã biết nhưng cũng có hàng `unevaluated` (health của nó chỉ tính các hàng đã được đánh giá) được đếm là "partly not evaluated" trong nhãn, và thẻ được đánh dấu cảnh báo kể cả khi đạt 100 %. Với intent có rule ngữ nghĩa mà không có hàng drift nào, trang chi tiết intent nói rằng danh sách rỗng không cho thấy các rule ngữ nghĩa đạt, thay vì "content meets the SLO".

## Multi-tenancy

- **Cô lập theo site:** intent, hàng drift và cursor ngữ nghĩa (`site_id` trên `lumibase_content_intents` và `lumibase_content_drifts`), review profile và run, setting `aiDecisions` và các key quota decision. Mọi query của pass đều lọc theo `site_id`.
- **Dùng chung toàn deployment:** cấu hình provider decision (`DECISION_*`) và `ENCRYPTION_KEY`, giống kiểm tra bản nháp.
- **Được kiểm bởi** `drift-semantic.db.integration.test.ts`: scan trên một site không tạo drift hay goal nào trên site kia.

## Giới hạn

- Chưa có benchmark live, nên chưa có số đo precision, recall hay tỉ lệ false-positive của drift.
- Trên worker Docker/Node, lần chạy Flows theo event và theo lịch nhận cùng cache và cấu hình provider như lần chạy thủ công (`registerFlowEventWorker` trong `serve.ts`), nên một `drift-scan` theo lịch chạy pass ngữ nghĩa ở đó; nó vẫn bị chặn bởi `aiDecisions.enabled` và `aiDecisions.drift`. Cloudflare Workers tiêu thụ `flow-events` qua cùng đoạn đăng ký đó (`apps/cms/src/cloudflare-flow-queue.ts`) và quét các flow theo lịch đến hạn bằng cron `* * * * *`. Trước khi backlog B118 được sửa, flow theo event và theo lịch hoàn toàn không chạy trên Workers. Trên cả hai runtime, lần chạy theo event và theo lịch vẫn không mang principal.
- Đã kiểm bằng unit test, một bộ integration trên Postgres và một lần chạy `wrangler dev` cục bộ, chưa chạy trên một Cloudflare Worker đã deploy.
