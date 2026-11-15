# Implementation Plan

## Overview

Kế hoạch triển khai **Content Environments** theo 6 phase. Mỗi phase tự có giá trị và dừng được sau nó. Phase A (Write_Precondition) độc lập với phần còn lại và giao trước. Phase B dựng Environment + Fork + cô lập. Phase C là Schema_Promote. Phase D là Content_Promote một chiều. Phase E là Merge ba chiều + Studio UI + hoàn tác. Phase F là docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng.

## Tasks

### Phase A — Write_Precondition (độc lập)

- [ ] 1. ETag + If-Match cho item
  - [ ] 1.1 Đọc luồng `ItemService.patch` (`item-service.ts:1090`) và coalesced writes (`:2259`); chốt nguồn ETag (`updatedAt` hay cột `version` mới — design §14.7) (Req 6.1, 6.4; design §6)
  - [ ] 1.2 `ItemService.patch`/`replace` nhận `expected?: { etag }`; conditional UPDATE trong cùng câu lệnh; 0 dòng → `PRECONDITION_FAILED` (Req 6.2, 6.4; design §6)
  - [ ] 1.3 Route `items.ts`: trả `ETag` ở GET detail, đọc `If-Match` ở PATCH/PUT, map 412 (Req 6.1-6.3; design §6)
  - [ ] 1.4 Test: không header → hành vi cũ; header khớp → ghi; header lệch → 412 không ghi; hai ghi đồng thời chỉ một thắng (Req 6.2-6.4)
  - [ ] 1.5 SDK + Studio: gửi `If-Match` khi lưu item, hiển thị thông báo "item đã được người khác sửa" khi 412 (Req 6.2)

### Phase B — Environment, Fork, cô lập

- [ ] 2. Data model
  - [ ] 2.1 Thêm `environments`, `environmentLineage`, `mergeRuns` vào `packages/database/src/schema/cms.ts` (nanoid, `site_id`, index/unique theo design) (Req 1.1, 1.2; design §2)
  - [ ] 2.2 Migration **hand-written** + journal; số cấp lúc merge, cao hơn mọi nhánh đang mở; thêm RLS policy vào `rls-policies.sql` (Req 1.4, 1.5; design §2)
  - [ ] 2.3 Feature flag `environments.enabled` + settings `environments.maxPerSite` (default 3) (Req 5.4, 14.1; design §13)

- [ ] 3. EnvironmentService CRUD
  - [ ] 3.1 `apps/cms/src/services/environment-service.ts`: constructor scoped Origin; nạp cặp (Origin, Environment) từ DB; assert cùng `organizationId` (Req 11.1, 11.2; design §11)
  - [ ] 3.2 `create`: kiểm flag, limit, không lồng; transaction `provisionSite` + insert `environments(forking)`; enqueue sau commit (Req 1.3, 2.1, 2.9, 5.4; design §3.1)
  - [ ] 3.3 `list`/`get` với `originChanged` + số item đã đổi có ngưỡng `truncated` (Req 5.1; design §5)
  - [ ] 3.4 `delete`: chặn khi busy; xoá site con; audit (Req 5.2, 5.3, 12.1; design §5)
  - [ ] 3.5 Route `routes/environments.ts` mount sau auth + site-admin; từ chối API key; test route-guard (Req 5.5, 11.4, 11.5; design §11)

- [ ] 4. Fork worker
  - [ ] 4.1 Worker `environment-fork` trên `QueueProvider`, theo pha, ghi `forkCursor`, resumable (Req 2.6; design §3.1)
  - [ ] 4.2 Copy schema + roles/permissions + settings không nhạy cảm, ghi lineage `collection|field|relation` (Req 2.2, 2.4; design §3.1)
  - [ ] 4.3 Copy items lượt 1 theo `contentScope`, ghi lineage `baseHash` + `baseRevisionId`/`baseSnapshot` (Req 2.3, 2.4; design §3.2, §3.3)
  - [ ] 4.4 Lượt 2 viết lại tham chiếu theo `relations`; đánh dấu `external` (Req 2.5; design §3.2)
  - [ ] 4.5 Files: copy metadata, dùng chung storage key; sửa đường xoá file để kiểm tham chiếu còn lại (Req 3.1-3.3; design §3.4)
  - [ ] 4.6 Danh sách loại trừ: API keys, secrets, sessions, audit, revisions, agent memory, trust ledger (Req 2.8; design §3.5)
  - [ ] 4.7 Integration test trên Postgres thật: fork `all` và `collections[]`, relation m2o/m2m/m2a còn đúng, chạy lại sau lỗi không nhân bản, Origin không đổi một byte (Req 2.3-2.7)

- [ ] 5. Cô lập Side_System
  - [ ] 5.1 Copy webhooks/flows/CDC/deployments ở trạng thái disabled, không secret; intents `paused` (Req 4.1, 4.2; design §4)
  - [ ] 5.2 `isEnvironment(siteId)` cache theo request; chặn tại dispatcher của webhook/flow/notification (Req 4.1-4.3; design §4)
  - [ ] 5.3 Delivery: `X-Robots-Tag: noindex` cho site con; xác nhận cache key + search index tách theo `siteId` (Req 4.4; design §4)
  - [ ] 5.4 Test: ghi item trong Environment không bắn webhook, không chạy flow, không tạo agent run của Origin (Req 4.1-4.3)
  - [ ] 5.5 Studio: danh sách Environment, tạo/xoá, chuyển site, nhãn Environment cố định (Req 4.5, 5.1; design §11)

### Phase C — Schema_Promote

- [ ] 6. Diff theo lineage
  - [ ] 6.1 Remap manifest Environment sang không gian Origin; nhận rename qua lineage → `renameFrom` (Req 7.2; design §7)
  - [ ] 6.2 Phát hiện schema conflict bằng `baseHash` của lineage schema (Req 7.4; design §7)
  - [ ] 6.3 `promoteSchema({ dryRun })` trả Merge_Plan; apply qua `ConfigImportService(origin)`; yêu cầu `confirmRiskyChange` + `migrationPlan` cho thay đổi rủi ro (Req 7.1, 7.3, 7.5; design §7)
  - [ ] 6.4 Cập nhật lineage sau apply; audit `environment_schema_promoted` (Req 7.6, 12.1)
  - [ ] 6.5 Test: thêm field, rename field, đổi kiểu có migrationPlan chạy trên item tạo sau fork, conflict hai bên cùng sửa một field (Req 7.2-7.5)

### Phase D — Content_Promote một chiều

- [ ] 7. Phân loại + áp dụng
  - [ ] 7.1 Hàm thuần `classify(base, origin, env)` theo bảng design §8.1; so sánh ở không gian id Origin (Req 8.2; design §8.1)
  - [ ] 7.2 Viết lại tham chiếu env → origin; phát hiện `DEPENDENCY_NOT_PROMOTED` (Req 8.3, 8.6; design §8.2)
  - [ ] 7.3 Sắp thứ tự create → update → delete; xử lý vòng tham chiếu (Req 8.6; design §8.2)
  - [ ] 7.4 Schema gate `SCHEMA_NOT_PROMOTED` (Req 8.5; design §8.2)
  - [ ] 7.5 Pre-flight toàn bộ rồi ghi qua `ItemService(origin).patch` với Write_Precondition; cập nhật `baseHash`/`baseRevisionId` (Req 6.5, 8.3, 8.4, 8.7, 8.8, 10.2; design §8.2, §10.2)
  - [ ] 7.6 Khoá `merging` + `merge_runs` + resume idempotent (Req 10.1, 10.3; design §10.1, §10.2)
  - [ ] 7.7 Integration test: promote sạch, conflict bị bỏ qua không ghi đè, item mới tham chiếu item mới, editorial gate chặn, chạy lại sau lỗi (Req 8.3-8.8, 10.3)

### Phase E — Merge ba chiều, UI, hoàn tác

- [ ] 8. Thuật toán
  - [ ] 8.1 Hàm thuần `threeWay(base, origin, env, fieldDefs)` theo field và theo locale; mảng nguyên khối (Req 9.2-9.4; design §9)
  - [ ] 8.2 Property test: không bên nào đổi → base; một bên đổi → bên đó; đối xứng; áp resolution `origin`/`environment` cho kết quả đúng (Req 9.3, 9.4)
  - [ ] 8.3 Dựng Base từ `baseRevisionId`/`baseSnapshot`; fallback conflict toàn phần (Req 9.7; design §3.3)
  - [ ] 8.4 Conflict cấp item (xoá vs sửa) (Req 9.5)
  - [ ] 8.5 `merge({ dryRun, resolutions })`; 422 `UNRESOLVED_CONFLICTS`; tôn trọng `pinnedFields` (Req 9.1, 9.6, 9.8; design §9)

- [ ] 9. Hoàn tác
  - [ ] 9.1 `revertMergeRun`: revert theo `revisionId` có precondition; item `created` → soft-delete; outcome `conflict` khi Origin đã đổi (Req 10.4, 10.5; design §10.3)
  - [ ] 9.2 Provenance `revisions.sources` mang environment id + merge run id (Req 12.3; design §10.3)

- [ ] 10. Studio Merge UI
  - [ ] 10.1 Màn Merge_Plan: nhóm theo action, đếm, cờ `truncated` (Req 9.1; design §9)
  - [ ] 10.2 Khung giải quyết conflict ba cột Base / Origin / Environment, tái dùng `RevisionsDiff` (Req 9.4; design §9)
  - [ ] 10.3 Lịch sử merge run + nút hoàn tác; cảnh báo rõ Schema_Promote không hoàn tác được (Req 10.5; design §10.3)

### Phase F — Docs, Setup Impact, DoD

- [ ] 11. Docs
  - [ ] 11.1 `docs/en/api/hono-api-spec.md` + bản `docs/vi/`: các route `/environments*`, `ETag`/`If-Match`, mã lỗi mới (DoD §4, §4a)
  - [ ] 11.2 `docs/en/data-model.md` + bản `docs/vi/`: ba bảng mới (DoD §4, §4a)
  - [ ] 11.3 Trang feature `content-environments` ở cả hai locale: workflow fork → sửa → promote schema → promote/merge content → hoàn tác; giới hạn v1 (DoD §4a)
  - [ ] 11.4 Chạy `docs:i18n:parity` → `verify` → `stamp-pair --verified` → `detect`; bỏ artifact detect (CLAUDE.md "Docs i18n")
  - [ ] 11.5 CHANGELOG `[Unreleased]` + ghi chú migration

- [ ] 12. Registry & DoD
  - [ ] 12.1 **Setup Impact**: rà 6 câu hỏi, ghi dòng Registry (ID cấp lúc merge) (Req 14.2)
  - [ ] 12.2 DoD §2b multi-tenant: rà mọi query của `EnvironmentService` và worker có lọc `site_id` (Req 11.2)
  - [ ] 12.3 DoD §2d shell: xác nhận chuyển Environment không đổi contract của `apps/shell` (Req 14.3)
  - [ ] 12.4 DoD §5 tutorial impact: `If-Match` có ảnh hưởng ví dụ SDK/tutorial không
  - [ ] 12.5 `turbo run typecheck` recursive + test đích trên Postgres local (Node 24)

---

## Review gates

Một phase chỉ được mở PR khi đạt đủ exit criteria của nó, và chỉ được bắt đầu phase kế sau khi PR đó merge. Reviewer đối chiếu từng dòng; dòng nào không áp dụng phải ghi lý do trong mô tả PR, không bỏ trống.

### G0 — Duyệt spec (trước khi viết dòng code đầu tiên)

- [ ] Năm giả định ở "Implementation status" đã được kiểm chứng bằng cách đọc code; kết quả ghi lại ngay tại mục đó (đúng / sai + file:line).
- [ ] Giả định nào sai thì `design.md` đã được sửa tương ứng (đặc biệt §3.3 nếu `revisions.delta.after` không đủ dựng Base, và §6 nếu ghi item đã có kiểm tra phiên bản).
- [ ] Open question §14.4 (Base khi revision bị retention dọn) và §14.7 (nguồn ETag) đã chốt phương án — hai câu này quyết định data model nên không được để ngỏ sang Phase B.
- [ ] Open question §14.1 đã chốt con số: giới hạn item mỗi lần fork, ngân sách thời gian fork, và `environments.maxPerSite` mặc định.
- [ ] Các open question còn lại (§14.2, §14.3, §14.5, §14.6) được ghi rõ là "hoãn sau v1", có người đồng ý.
- [ ] Phạm vi v1 được xác nhận: dừng ở Phase D (promote một chiều) hay đi hết Phase E.

### Điều kiện chung cho mọi PR của feature này

- [ ] `turbo run typecheck` recursive sạch (không chỉ `-F` một package).
- [ ] Test đích của phase pass trên Postgres thật, Node 24; kết quả dán trong mô tả PR.
- [ ] Flag `environments.enabled` OFF → toàn bộ test suite hiện có không đổi kết quả (trừ Phase A).
- [ ] Mỗi task một commit; số migration và ID Setup Impact đã đối chiếu với mọi nhánh đang mở.
- [ ] Mục "Implementation status" được cập nhật: phase nào xong, deviation nào so với design và vì sao.

### GA — Write_Precondition

- [ ] Request không có `If-Match` cho kết quả như trước (test hồi quy trên route items hiện có).
- [ ] Test đồng thời: hai PATCH cùng ETag → đúng một cái 200, một cái 412, dữ liệu là của cái thắng.
- [ ] Kiểm tra nằm trong cùng câu UPDATE (reviewer đọc SQL sinh ra), không phải SELECT rồi UPDATE.
- [ ] Coalesced writes không làm precondition báo sai (có test).
- [ ] DoD §2d: bản shell desktop/mobile lưu item bình thường, xử lý được 412.

### GB — Environment, Fork, cô lập

- [ ] Fork `all` trên site mẫu: số dòng mỗi bảng ở Environment khớp Origin trong phạm vi; mọi relation m2o/o2m/m2m/m2a resolve đúng trong Environment.
- [ ] Origin không đổi sau fork: so hash toàn bộ `items.data` và `updated_at` trước/sau.
- [ ] Giết worker giữa chừng rồi chạy lại → không dòng trùng, kết thúc `ready`.
- [ ] Ghi item trong Environment → 0 webhook gửi, 0 flow run, 0 agent run, 0 email/push (đếm ở dispatcher).
- [ ] Xoá file trong Environment không xoá object storage mà Origin còn dùng; xoá cả Environment xong Origin vẫn tải được mọi file.
- [ ] Bảng loại trừ (API keys, secrets, sessions, audit, revisions, agent memory, trust ledger) có test khẳng định 0 dòng trong site con.
- [ ] Fork ở giới hạn item đã chốt hoàn tất trong ngân sách thời gian đã chốt ở G0, trên cả runtime Docker và Workers.
- [ ] Checklist bảo mật xuyên site (bên dưới) pass.

### GC — Schema_Promote

- [ ] Dry-run không ghi gì (so hash schema Origin trước/sau).
- [ ] Rename field trong Environment được nhận là rename, không phải delete + create (dữ liệu field ở Origin còn nguyên sau apply).
- [ ] Đổi kiểu có `migrationPlan` chuyển đổi đúng cả item tạo ở Origin **sau** thời điểm fork.
- [ ] Hai bên cùng sửa một field → apply bị từ chối cho tới khi có resolution.
- [ ] Thiếu `confirmRiskyChange`/`migrationPlan` cho thay đổi rủi ro → 422, không ghi.
- [ ] UI nói rõ thao tác này không hoàn tác được trước khi cho bấm apply.

### GD — Content_Promote một chiều

- [ ] Item mà Origin đã lệch khỏi Base **không bao giờ** bị ghi đè (test có chủ đích sửa Origin giữa dry-run và apply).
- [ ] Sau promote, tham chiếu trong `data` ở Origin trỏ về id Origin; không còn id của Environment nào lọt sang (quét toàn bộ data sau test).
- [ ] Item mới tham chiếu item mới, kể cả vòng, được tạo đúng.
- [ ] Editorial gate, permission theo collection và `pinnedFields` của Origin chặn đúng như một lần ghi thường.
- [ ] Giết tiến trình giữa chừng rồi chạy lại → item đã áp dụng không bị ghi lần hai, không revision trùng.
- [ ] Hai promote đồng thời trên cùng Origin → một cái `ENVIRONMENT_BUSY`.
- [ ] Checklist bảo mật xuyên site pass.

### GE — Merge ba chiều, UI, hoàn tác

- [ ] Property test của `threeWay` pass với seed ngẫu nhiên, gồm field đa ngôn ngữ.
- [ ] Còn conflict chưa giải quyết → 422, 0 item bị ghi.
- [ ] Base không dựng được → item thành conflict toàn phần, không tự merge.
- [ ] Hoàn tác một merge run đưa các item chưa bị sửa thêm về đúng trạng thái trước merge (so hash); item đã bị sửa thêm ra `conflict`, không bị đụng.
- [ ] Revision tạo bởi merge mang provenance environment id + merge run id.
- [ ] UI conflict dùng được bằng bàn phím và đúng ở cả theme sáng/tối; đã kiểm trên bản shell.

### GF — Docs, Registry

- [ ] Cặp docs EN/VI qua `parity` → `verify` → `stamp-pair --verified` → `detect` báo up-to-date; artifact detect đã bỏ.
- [ ] Dòng Setup Impact đã ghi, ID không trùng nhánh đang mở.
- [ ] CHANGELOG có ghi chú migration và hành vi mới của `ETag`/`If-Match`.

### Checklist bảo mật xuyên site (áp cho GB, GD, GE)

- [ ] Không endpoint nào nhận `siteId` thứ hai từ request; cặp (Origin, Environment) luôn nạp từ bảng `environments` theo `site_id` của context.
- [ ] Gọi promote/merge với `key` của Environment thuộc Origin khác → 404, không lộ sự tồn tại.
- [ ] Environment và Origin khác `organizationId` (dựng tay trong test) → bị từ chối ở service.
- [ ] User có quyền ở Environment nhưng không có quyền ghi ở Origin → bị từ chối từng item, không promote được gì.
- [ ] API key (kể cả key có `schema:write`) → bị từ chối ở mọi route `/environments*`.
- [ ] Mọi query trong `EnvironmentService` và fork worker có lọc `site_id`; RLS bật trong test, không chạy bằng role bypass.
- [ ] Mỗi phát hiện từ agent/sweep bảo mật được xác minh tại call site trước khi sửa.

---

## Implementation status

**Chưa bắt đầu.** Spec viết 2026-11-13. Chưa có code, migration hay docs nào cho feature này.

Giả định trong spec chưa được kiểm chứng bằng code, cần xác nhận ở task đầu của mỗi phase:

- Item write hiện là last-write-wins (không thấy `If-Match`/`expectedRevision` khi grep; chưa đọc hết `ItemService.patch`) — task 1.1.
- `revisions.delta.after` đủ để dựng lại trạng thái đầy đủ của item tại một revision — task 8.3.
- Cache key và search index đã tách hoàn toàn theo `siteId` — task 5.3.
- Webhook/flow/notification có một điểm dispatch chung để đặt chốt chặn — task 5.2.
- Bảng files có cột storage key dùng chung được giữa hai dòng — task 4.5.
