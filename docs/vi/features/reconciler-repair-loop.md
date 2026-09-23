---
version: 3
sourceLang: en
lastUpdated: 2026-09-23T12:16:23.556Z
translatedFrom: en
sourceHash: 028b26a85a1c849b
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-23T12:16:23.556Z
codeVerifiedHash: 028b26a85a1c849b
codeVerifiedClaims: 2
---

# Vòng sửa của reconciler

Một content intent khai báo các quy tắc; `DriftService` ghi lại vi phạm của những quy tắc đó thành drift; `ReconcilerService` biến drift đang mở thành agent goal. Trang này mô tả bước đưa một goal đi tới nội dung đã sửa và đã xuất bản: dispatch → bản nháp → người phê duyệt → xuất bản → đánh giá lại có xác minh.

Một tình huống được nối dây trọn vẹn: một field dịch được nhưng thiếu một locale.

## Vì sao có phần này

Trước đây tạo goal là điểm cuối của chuỗi. Dòng goal được thêm vào, drift chuyển sang `assigned` kèm `goalId`, và không có gì thực thi nó — không có cron task, queue consumer hay route nào biến một reconciler goal thành một run.

Điều đó tệ hơn là không làm gì. Việc gán goal cố ý bỏ qua drift đã mang `goalId`, nên một goal không thể thực thi đã **khoá** drift của nó khỏi mọi chu kỳ sau. Site tích lại drift ở trạng thái assigned, không còn trông như việc cần làm, và không bao giờ được sửa.

## Vòng lặp

Mỗi lượt dispatch đẩy một goal tiến đúng tối đa một bước. Bước kế tiếp được suy ra từ trạng thái quan sát được — phase của goal, run mới nhất của nó, nhánh bản nháp còn tồn tại hay không, và trạng thái của drift — nên lượt chạy an toàn khi lặp lại, an toàn khi tiếp tục sau một lần crash, và không bị ảnh hưởng bởi việc queue giao trùng job.

| Phase | Skill | Tác động | Cổng kiểm soát |
|---|---|---|---|
| draft | `repairTranslation` | Ghi bản dịch đề xuất vào một nhánh version có tên | Cổng write/autonomy: L0 từ chối ở chế độ shadow, L1 park chờ phê duyệt, L2+ thực thi |
| promote | `promoteVersion` | Áp nhánh đó vào main qua item API | Được phân loại nguy hiểm — luôn park chờ người phê duyệt |
| verify | — | Quét lại intent | Chỉ hoàn tất nếu vi phạm đã biến mất |

Nội dung đã xuất bản thay đổi đúng một lần trong chuỗi này, ở bước promote, sau khi một người phê duyệt.

Bản nháp dùng bản chụp item sau khi sinh bản dịch, giữ lại chỉnh sửa trong lúc provider chạy, kể cả bản dịch ngôn ngữ đích do người dùng nhập. Nếu văn bản nguồn thay đổi trong lúc sinh bản dịch, bản nháp bị bỏ và run thất bại với `SOURCE_CHANGED`; cần người vận hành xem xét để phục hồi, không tự động thử lại.

Khoá của nhánh bản nháp là tiền định (`drift-repair:<drift fingerprint>`), và đó là điều làm vòng lặp idempotent: một job draft bị giao trùng sẽ thấy nhánh đã có rồi trả về mà không gọi lại model, và không thể tạo nhánh trùng.

## Trạng thái lỗi và trạng thái dừng

Vòng lặp không bao giờ tự retry. Một run thất bại hoặc bị huỷ sẽ block goal kèm lý do, vì nguyên nhân thường gặp nhất là có người từ chối phê duyệt, và dispatch lại chính là hỏi lại người đã nói không.

`status` chuyển thành `blocked` và `metadata.blockedReason` ghi lại điều nào đã xảy ra:

| Lý do | Ý nghĩa |
|---|---|
| `RUN_FAILED` / `RUN_CANCELLED` | Run của phase không thành công — phê duyệt bị từ chối, provider lỗi, hoặc bị từ chối ở mức shadow |
| `NO_REPAIR_SKILL` | Rule type của drift chưa có đường sửa nào được nối dây (hiện chỉ có `translations`) |
| `DRAFT_MISSING` | Một run draft báo thành công nhưng không để lại nhánh nào |
| `PROMOTE_INCOMPLETE` | Một promote báo thành công nhưng nhánh vẫn còn đó |
| `VERIFY_FAILED` | Nội dung đã xuất bản mà vi phạm vẫn còn |
| `ENQUEUE_FAILED` | Queue từ chối job; dòng run được chốt lại thay vì bị treo chờ mãi |
| `DRIFT_MISSING` | Dòng drift đã biến mất, nên không còn gì để xác minh kết quả sửa |

Hai tình huống cố ý **không** phải block, vì bản thân goal không có vấn đề mà thứ quanh nó đang tạm thời không sẵn sàng:

- **Site bị freeze** (kill switch) không đẩy gì và để nguyên các goal.
- **Intent bị pause hoặc ở trạng thái error** — kể cả khi circuit breaker vừa nhảy — sẽ dừng dispatch cho các goal của nó.
- **Runtime không có queue adapter** báo `queueUnavailable` và để goal vẫn dispatch được, nên thêm queue về sau không cần unblock tay.

Goal `blocked` xuất hiện trong Studio → Mission Control kèm lý do, và xử lý nó là quyết định của con người.

## Governance đi xuyên qua queue

Một reconciler run không có principal là người: intent khai báo quy tắc chính là thẩm quyền. Vì vậy payload của job mang theo envelope governance, và worker thực thi nó ở thời điểm nhận job chứ không tin bất cứ thứ gì chụp lại lúc enqueue:

| Field | Mục đích |
|---|---|
| `siteId` | Phạm vi tenant; một dispatcher chỉ thấy goal của site mình |
| `intentId` | Phạm vi write budget, và intent mà trạng thái của nó chặn dispatch |
| `goalId` / `driftFingerprint` | Nối run với đúng vi phạm mà nó sửa |
| `autonomyCap` | Trần của intent; resolver lấy `min(cap, grant)` |
| `agentRole` | Biên capability, được đọc lại từ role library lúc nhận job |
| `origin: 'reconciler'` | Cho phép backpressure chỉ pause công việc của reconciler |

Capability **không** được chụp vào payload. Chúng được resolve khi job được nhận, từ agent role ghi trên goal (drift `translations` route tới `translator`). Vô hiệu hoá role đó sẽ dừng cả công việc đã nằm trong queue; run thất bại với `capabilities_denied` và không ghi gì.

Freeze theo role và autonomy grant dùng định danh agent đã lưu trên run. Khi thực thi approval, hệ thống kiểm tra lại định danh đó: freeze `translator` sau khi promotion chờ duyệt sẽ chặn xuất bản và giữ run ở trạng thái chờ duyệt. Sau khi gỡ freeze, có thể quyết định lại cùng approval. Quy tắc này cũng áp dụng cho approval cũ có dòng legacy vẫn mang tên agent mặc định.

## Đa tenant

| Tài nguyên | Phạm vi |
|---|---|
| Goal, run, drift, content version, item | Cô lập theo `site_id` ở mọi lần đọc và ghi |
| Khoá nhánh bản nháp | Suy ra từ drift fingerprint, mà fingerprint bắt đầu bằng intent id |
| Lượt dispatch | Dựng theo từng site; cron tick tìm site từ các goal rồi chạy một lượt cho mỗi site |
| Role library của agent | Theo site (dòng `agent_roles` được seed cho từng tenant) |

Đã verify với hai site trong `g3-repair-loop.db.integration.test.ts`: dispatch cho site A không tạo run, không tạo bản nháp và không đổi nội dung nào của site B.

## Runtime được hỗ trợ

Dispatch chạy trên runtime **Node/Docker**, do một cron tick có leader lock chạy mỗi phút. Cái lock là quan trọng: hai process cùng dispatch một goal sẽ tạo hai run cho một drift.

Trên **Cloudflare Workers**, queue `agent-runs` không có consumer export, nên các run bất đồng bộ — gồm cả vòng lặp này — không thực thi ở đó. Đây là giới hạn có sẵn của việc chạy agent bất đồng bộ, không phải của vòng lặp này. Hãy dùng endpoint thủ công bên dưới, hoặc chạy bản Docker, cho tới khi có queue consumer cho Workers.

## Kích hoạt một chu kỳ

`POST /api/v1/intents/:id/scan` chạy cả chu kỳ cho một intent và trả về đủ ba giai đoạn:

```json
{
  "data": {
    "scan": { "scanned": 1, "opened": 1, "reopened": 0, "resolved": 0, "completed": true, "cursor": null },
    "reconcile": { "goalsCreated": 1, "deferred": 0, "breakerTripped": false },
    "dispatch": {
      "dispatched": 1,
      "completed": 0,
      "skipped": 0,
      "blocked": 0,
      "outcomes": [{ "goalId": "gol_…", "action": "dispatch_draft", "runId": "run_…" }]
    }
  }
}
```

Vì mỗi lượt chỉ tiến một bước, đưa một lần sửa tới đích cần vài lượt: một lượt để tạo bản nháp, một lượt để yêu cầu promote, và một lượt để verify sau khi phê duyệt được cấp. Cron tick tự làm việc này; gọi endpoint nhiều lần cũng cho kết quả tương tự theo yêu cầu.

## Mở rộng sang rule type khác

`translations` là rule type duy nhất có đường sửa. Thêm một loại khác nghĩa là cung cấp tham số sửa cho drift của loại đó cùng một skill ghi bản nháp thay vì ghi trực tiếp nội dung live. Cho tới lúc đó, goal của các rule type khác sẽ block với `NO_REPAIR_SKILL` — được nói ra thay vì bị bỏ qua âm thầm, nhờ vậy drift không ngồi ở trạng thái assigned dưới một goal mà không gì sẽ đẩy tiếp.

## Liên quan

- [Agent Harness Layer](./agent-harness-layer.md) — vòng đời run, các mức autonomy, phê duyệt, kill switch
- [Tham chiếu API](../api/hono-api-spec.md) — endpoint intent và agent
