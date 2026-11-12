# Implementation Plan

## Overview

Kế hoạch triển khai **Content Environments** theo 6 phase. Mỗi phase tự có giá trị và dừng được sau nó. Phase A (Write_Precondition) độc lập với phần còn lại và giao trước. Phase B dựng Environment + Fork + cô lập. Phase C là Schema_Promote. Phase D là Content_Promote một chiều. Phase E là Merge ba chiều + Studio UI + hoàn tác. Phase F là docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng.

## Tasks

### Phase A — Write_Precondition (độc lập)

- [ ] 1. ETag + If-Match cho item
  - [ ] 1.1 Đọc luồng `ItemService.patch` (`item-service.ts:943`) và coalesced writes (`:2110`); chốt nguồn ETag (`updatedAt` hay cột `version` mới — design §14.7) (Req 6.1, 6.4; design §6)
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

## Implementation status

**Chưa bắt đầu.** Spec viết 2026-11-13. Chưa có code, migration hay docs nào cho feature này.

Giả định trong spec chưa được kiểm chứng bằng code, cần xác nhận ở task đầu của mỗi phase:

- Item write hiện là last-write-wins (không thấy `If-Match`/`expectedRevision` khi grep; chưa đọc hết `ItemService.patch`) — task 1.1.
- `revisions.delta.after` đủ để dựng lại trạng thái đầy đủ của item tại một revision — task 8.3.
- Cache key và search index đã tách hoàn toàn theo `siteId` — task 5.3.
- Webhook/flow/notification có một điểm dispatch chung để đặt chốt chặn — task 5.2.
- Bảng files có cột storage key dùng chung được giữa hai dòng — task 4.5.
