---
version: 6
sourceLang: en
lastUpdated: 2026-10-15T17:43:33.309Z
translatedFrom: en
sourceHash: c060dab1a6b367eb
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-15T17:43:33.309Z
codeVerifiedHash: c060dab1a6b367eb
codeVerifiedClaims: 14
---

# Tự động hoá Jev: gắn tag và phân luồng hàng chờ duyệt (shadow trước)

Tự động hoá Jev biến các quyết định [kiểm tra bản nháp](./draft-review.md) đủ tin cậy thành đề xuất metadata trong một [Flow](./flows-automation.md): thêm một tag phân loại, hoặc đưa một item vào một hàng chờ duyệt. Nó bắt đầu ở **chế độ shadow**: mọi đề xuất được ghi lại và không ghi gì vào item. Một site chỉ chuyển sang live sau khi benchmark held-out ([Benchmark Jev](./jev-benchmark.md)) và số liệu shadow bên dưới ủng hộ điều đó, và ngay cả khi đó mọi lần ghi đều thành một approval do con người quyết định.

> **Trạng thái.** Code được phát hành với shadow bật và không có cấu hình live nào. Precision và coverage chưa được đo trên dữ liệu thật, nên không site nào nên đặt `mode: 'live'` cho tới khi `GET /api/v1/ai/automation/metrics` báo `shadowRequired: false` cho locale và hành động của site đó.

## Các phần ghép với nhau thế nào

1. Một flow dựng từ template chạy `ai:decision` (J10) trên một item với một phiên bản profile được ghim.
2. Node tiếp theo, `ai:apply-tags` hoặc `editorial:route`, đọc quyết định đó và ghi một dòng vào `lumibase_ai_automation_actions` cho flow run, node và item.
3. Dòng đó là **shadow** trừ khi mọi điều kiện live đều thoả (xem [Chế độ](#chế-độ)). Một dòng live đi qua harness có quản trị, bị giới hạn ở L1, nên nó tạo một approval.
4. Người duyệt accept, override hoặc reject quyết định từ hàng chờ duyệt. Phán quyết được lưu thành review feedback trên quyết định đó.
5. `GET /api/v1/ai/automation/metrics` tính precision và coverage trong vùng tự động từ các dòng và phán quyết đó.

## Template

`GET /api/v1/ai/automation/templates` liệt kê hai template. `POST /api/v1/ai/automation/templates/:key/build` kiểm tra tham số và trả về thân của một flow; nó không ghi gì. Trong Studio, **Flows → Create from template** dựng flow và lưu thành một flow **nháp, kích hoạt thủ công**. Việc kích hoạt vẫn là một bước riêng.

| Template | Đồ thị | Tham số chính |
|---|---|---|
| `taxonomy-tagging` | `ai:decision` (choice) → `ai:apply-tags` | `profileKey`, `profileVersion`, `collection`, `questionKey`, `choices`, `minConfidence`, `tagField`, `tagMap` |
| `editorial-routing` | `ai:decision` (choice hoặc noul) → `editorial:route` | như trên, thêm `questionType`, `noulThreshold`, `queueField`, `queues`, `manualQueue`, `submitForReview` |

Mỗi khoá choice (hoặc `true`/`false` với noul) và `unknown` đều dẫn tới node hành động, nên một lần từ chối trả lời được ghi lại là `decision_unknown`. `error` kết thúc run. Chỉ run thủ công mang principal mà các node hành động thay mặt; run theo event, lịch và webhook bị từ chối, giống `ai:decision`.

## Các thao tác

| Thao tác | Đề xuất | Không bao giờ |
|---|---|---|
| `ai:apply-tags` | thêm phân loại được chọn (ánh xạ qua `tagMap`) vào một field mảng chuỗi | đổi `status`, xoá, đổi schema |
| `editorial:route` | đặt một field phân luồng thành hàng chờ ánh xạ qua `queues`; với `submitForReview`, nêu chuyển trạng thái `submit_review` khi `canTransition` cho phép | thực hiện chuyển trạng thái, publish |

Một quyết định `unknown` chỉ đề xuất `manualQueue`, và đề xuất đó không bao giờ live.

Trước khi đề xuất, mỗi node resolve lại principal của run và đọc lại `aiDecisions.enabled` và `aiDecisions.flows`. Nó đọc quyết định từ review run đã lưu: output của bước phía trước chỉ nêu run và câu hỏi, còn giá trị, độ tin cậy, provider, model và profile của nó phải khớp với run. Sau đó nó **bỏ qua và ghi lại** (status `skipped`) khi:

- quyết định bị thiếu, thất bại (`decision_error`) hoặc từ chối trả lời (`decision_unknown`);
- review run nói về một collection hoặc item khác với cái node đang tác động (`decision_item_mismatch`; dòng khi đó không lưu revision hay hash);
- output của bước không khớp với câu trả lời hoặc profile của review run, hoặc ngưỡng cắt của nó nằm ngoài khoảng mà `ai:decision` chấp nhận (`noulThreshold` 0.5–1, `minConfidence` 0–1) (`decision_mismatch`);
- review run đã stale: content hash hoặc revision mới nhất của item đã đổi kể từ quyết định (`stale:content_changed`, `stale:revision_changed`);
- một biên tập viên đã override quyết định bằng feedback `edit` hoặc `reject` (`human_override`);
- field đích bị con người ghim (`pinned`) hoặc principal không đọc được nó (`field_not_readable`).

Một đề xuất không thay đổi gì là `noop`.

## Chế độ

Setting `aiDecisions` (do site admin ghi qua `POST /api/v1/settings`) chứa khối tự động hoá:

```json
{
  "enabled": true,
  "flows": true,
  "automation": {
    "mode": "live",
    "thresholds": {
      "vi": {
        "tag": {
          "provider": "typesafe",
          "model": "jev-1.13",
          "profileKey": "taxonomy",
          "profileVersion": 3,
          "questionKey": "category",
          "minConfidence": 0.85
        }
      }
    },
    "gate": { "approvedBy": "usr_admin", "approvedAt": "2026-11-01T09:00:00Z", "evidenceRef": "eval/jev-benchmark/reports/v1/live/report.heldout.json" }
  }
}
```

Một đề xuất chỉ live khi mọi điều sau đều đúng; nếu không nó là shadow và `reason` cho biết vì sao:

| Điều kiện | Lý do shadow |
|---|---|
| khối cấu hình parse được | `settings_malformed` |
| `mode` là `live` | `mode_shadow` |
| `gate` có `approvedBy`, `approvedAt` và `evidenceRef` | `gate_missing` |
| item có locale (`options.locale` hoặc `input.locale`) với một ngưỡng cho hành động | `locale_unknown`, `threshold_missing` |
| `provider`, `model`, `profileKey`, `profileVersion` và `questionKey` của ngưỡng khớp quyết định | `provider_mismatch`, `model_mismatch`, `profile_mismatch`, `profile_version_mismatch`, `question_mismatch` |
| độ tin cậy của quyết định ít nhất bằng `minConfidence` | `below_threshold` |

Một ngưỡng nêu đúng quyết định mà nó được đo cho. Phiên bản profile được đánh số theo từng khoá profile, nên chỉ `profileVersion` không xác định được một profile; một ngưỡng thiếu `profileKey` và `questionKey` không parse được và được đọc là `settings_malformed`. Lấy `minConfidence` từ ngưỡng đã đóng băng của split tune J06 cho cùng provider, model, profile và câu hỏi. Các dòng shadow chỉ là `inZone` theo một ngưỡng được đo cho chính quyết định của chúng, nên shadow đo đúng vùng mà một lần chuyển sang live sẽ tác động.

## Ghi live có quản trị

Một đề xuất live gọi `AISecureHarness.execute('updateItem')` với:

- một ItemService gắn với principal của run (`itemServiceForPrincipal`), nên RBAC theo dòng/field và site là của principal đó;
- provenance agent trên revision, nên một field con người đã ghim bị từ chối (`PINNED_BY_HUMAN`);
- agent `jev-automation` và `autonomyCap: 1`. Harness lấy mức thấp hơn giữa grant và cap, nên mọi grant từ L2 tới L4 vẫn cho **L1: một approval**, và L0 bị từ chối (`AUTONOMY_SHADOW`). Tự động hoá không bao giờ tự thực hiện một lần ghi;
- kill switch, theo agent `jev-automation` (site hoặc agent bị đóng băng là `denied`, lý do `frozen`).

Dòng chuyển thành `pending_approval` kèm id của approval. Khi một người duyệt trong Mission Control, harness thực hiện lần ghi với quyền đã resolve lại của người yêu cầu; dòng khi đó được đọc là `applied`. Approval bị từ chối được đọc là `rejected`.

Đề xuất còn mang một điều kiện tiên quyết `expect` trên `updateItem`: field và giá trị mà đề xuất được tính từ đó. Harness kiểm lại điều kiện này khi lần ghi đã được duyệt chạy. Nếu một người đã đổi field đó ở giữa, không có gì được ghi, approval được chốt `failed` với lý do `ITEM_PRECONDITION_FAILED`, và dòng được đọc là `denied` với lý do `stale_at_approval`. Lần sửa của người đó được giữ. Chạy lại flow để có đề xuất mới.

## Hoàn tác

`POST /api/v1/ai/automation/actions/:id/revert` (site admin) khôi phục `previous` qua ItemService của người gọi. Nó từ chối với:

- `409 AUTOMATION_NOT_APPLIED` cho dòng shadow, đang chờ hoặc bị từ chối;
- `409 AUTOMATION_REVERT_CONFLICT` khi field không còn giữ giá trị mà hành động đã ghi, nên lần sửa sau của con người được giữ;
- `409 AUTOMATION_ALREADY_REVERTED` ở lần thứ hai.

## Hàng chờ duyệt

Hàng chờ duyệt biên tập trong Studio liệt kê các dòng tự động hoá của collection dưới mục **Automation suggestions**: tag hoặc hàng chờ được đề xuất, chế độ và trạng thái, độ tin cậy và việc nó có nằm trong vùng tự động hay không. **Accept**, **Override** (nhập tag hoặc hàng chờ đúng; lưu thành `edit`) và **Reject** gửi `POST /api/v1/ai/automation/actions/:id/feedback`. Chúng chỉ ghi feedback; không có gì được áp dụng từ hàng chờ. Một quyết định mà item đã đổi kể từ đó sẽ hỏi lại trước khi ghi (`acknowledgeStale`).

Feedback thuộc về quyết định (review run và câu hỏi), và một quyết định có thể cấp cho cả một node tag lẫn một node phân luồng. Vì vậy một override được lưu theo từ vựng của quyết định: CMS ánh xạ tag hoặc hàng chờ ngược về khoá choice (hoặc `true`/`false` với noul) qua `tagMap` hoặc `queues` của node, hoặc coi nó là một khoá choice khi nó không được ánh xạ. Một giá trị mà quyết định không thể nhận bị từ chối với `422 AUTOMATION_OVERRIDE_UNMAPPED`, và thông báo liệt kê các giá trị dùng được.

## Chuỗi kiểm toán

Mọi mắt xích là một id, nên một dòng có thể được lần theo từ đầu tới cuối:

revision đầu vào (`revision_id`, `content_hash`) → review run (`review_run_id`, provider, model, phiên bản profile) → hành động (dòng này, `flow_run_id`, `node_id`, `approval_id`) → feedback (review feedback trên `review_run_id` + `question_key`).

`GET /api/v1/ai/automation/actions/:id` trả về dòng kèm `chain` của nó. Khi job xoá review run theo thời hạn lưu trữ xoá một run, `review_run_id` thành null và dòng vẫn được giữ.

## Số liệu shadow

`GET /api/v1/ai/automation/metrics?from=&to=` (site admin, khoảng tối đa 366 ngày, mặc định 30 ngày gần nhất) báo, theo hành động, locale, provider, model, profile (khoá và phiên bản) và câu hỏi:

- **precision** trên các đề xuất trong vùng có phán quyết từ một người dùng đã đăng nhập: `accept`, hoặc override thành cùng giá trị của quyết định, là đúng; `reject` hoặc override thành giá trị khác là sai;
- **coverage**: đề xuất trong vùng trên số item đã có quyết định (đề xuất cộng các lần từ chối trả lời);
- khoảng Wilson 95%, ngưỡng đã dùng và số mẫu.

Protocol `jev-automation-v1` yêu cầu ít nhất 30 đề xuất trong vùng đã được duyệt cho mỗi split và 100 tổng cộng. Dưới mức đó một split là `insufficientSample` và `shadowRequired` vẫn là `true`. Các dòng từ một provider, model, profile hoặc câu hỏi mà ngưỡng không được đo cho bị loại (`excludedMismatch`), nên các profile trùng số phiên bản không bao giờ bị gộp chung. Số liệu không bao giờ bật gì cả; chuyển sang live là một quyết định riêng của admin được ghi trong `gate`.

## Quyền truy cập và đa tenant

- `/api/v1/ai/automation/*` là control plane: backstop control-plane và từng route đều yêu cầu site admin. Hàng chờ duyệt hiển thị một ghi chú thay cho danh sách với người không phải admin.
- Dùng chung toàn deployment: không có gì mới. Cô lập theo site: mọi dòng của `lumibase_ai_automation_actions` (`site_id`, FK cascade, có trong `rls-policies.sql`), mọi truy vấn của store, approval và review run mà nó liên kết.
- Đã kiểm bằng test: store từ chối dòng của site khác khi đọc, cập nhật và hoàn tác (DB integration), danh sách và phép join feedback theo site, và một principal của site khác không resolve được trong node.

## Giới hạn đã biết

- **Chưa có precision đo được.** Chưa có dữ liệu thật, nên mọi site vẫn ở shadow.
- **Chỉ run thủ công.** Trigger theo event và lịch không mang principal, nên các node từ chối chúng.
- **Một lần giao bị crash không được đề xuất lại.** Một dòng live được giữ chỗ trước lời gọi harness. Nếu tiến trình chết ở giữa, dòng vẫn ở `pending` và không có approval. Lần giao lại trong vòng năm phút để nguyên dòng đó; sau năm phút nó chốt dòng thành `denied` với lý do `orphaned` và không đề xuất gì, vì tiến trình đã chết có thể đã tạo một approval mà chưa kịp liên kết. Chạy lại flow để đề xuất lần nữa.
- **Chuyển trạng thái `submit_review` chỉ được đề xuất, không được thực hiện.** Người duyệt gửi item đi duyệt.
