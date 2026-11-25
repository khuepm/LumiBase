# Implementation Plan

## Overview

Kế hoạch triển khai **Content Environments** theo 6 phase. Mỗi phase tự có giá trị và dừng được sau nó. Phase A (Write_Precondition) độc lập với phần còn lại và giao trước. Phase B dựng Environment + Fork + cô lập. Phase C là Schema_Promote. Phase D là Content_Promote một chiều. Phase E là Merge ba chiều + Studio UI + hoàn tác. Phase F là docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng.

## Tasks

### Phase A — Write_Precondition (độc lập)

- [x] 1. ETag + If-Match cho item
  - [x] 1.1 Thêm cột `version integer NOT NULL DEFAULT 0` trên `lumibase_items` bằng migration viết tay (đã chốt, design §14.7); luồng `ItemService.patch` và coalesced writes đã đọc ở G0 — coalescing chỉ hoãn invalidation, không ảnh hưởng precondition (giả định 1 bên dưới) (Req 6.1, 6.4; design §6)
  - [x] 1.2 `ItemService.patch`/`replace` nhận `expected?: { etag }`; conditional UPDATE trong cùng câu lệnh; 0 dòng → `PRECONDITION_FAILED` (Req 6.2, 6.4; design §6). Tăng `version` ở mọi UPDATE đổi `data`/`status` liệt kê ở design §14.7
  - [x] 1.3 Route `items.ts`: trả `ETag` ở GET detail, đọc `If-Match` ở PATCH/PUT, map 412 (Req 6.1-6.3; design §6)
  - [x] 1.4 Test: không header → hành vi cũ; header khớp → ghi; header lệch → 412 không ghi; hai ghi đồng thời chỉ một thắng (Req 6.2-6.4)
  - [x] 1.5 SDK + Studio: gửi `If-Match` khi lưu item, hiển thị thông báo "item đã được người khác sửa" khi 412 (Req 6.2)

### Phase B — Environment, Fork, cô lập

- [x] 2. Data model
  - [x] 2.1 Thêm `environments`, `environmentLineage`, `mergeRuns` vào `packages/database/src/schema/cms.ts` (nanoid, `site_id`, index/unique theo design) (Req 1.1, 1.2; design §2)
  - [x] 2.2 Migration **hand-written** + journal; số cấp lúc merge, cao hơn mọi nhánh đang mở; thêm RLS policy vào `rls-policies.sql` (Req 1.4, 1.5; design §2)
  - [x] 2.3 Feature flag `environments.enabled` + settings `environments.maxPerSite` (default 3) (Req 5.4, 14.1; design §13)

- [x] 3. EnvironmentService CRUD
  - [x] 3.1 `apps/cms/src/services/environment-service.ts`: constructor scoped Origin; nạp cặp (Origin, Environment) từ DB; assert cùng `organizationId` (Req 11.1, 11.2; design §11)
  - [x] 3.2 `create`: kiểm flag, limit, không lồng; transaction `provisionSite` + insert `environments(forking)`; enqueue sau commit (Req 1.3, 2.1, 2.9, 5.4; design §3.1)
  - [x] 3.3 `list`/`get` với `originChanged` + số item đã đổi có ngưỡng `truncated` (Req 5.1; design §5)
  - [x] 3.4 `delete`: chặn khi busy; xoá site con; audit (Req 5.2, 5.3, 12.1; design §5)
  - [x] 3.5 Route `routes/environments.ts` mount sau auth + site-admin; từ chối API key; test route-guard (Req 5.5, 11.4, 11.5; design §11)

- [x] 4. Fork worker
  - [x] 4.1 Worker `environment-fork` trên `QueueProvider`, theo pha, ghi `forkCursor`, resumable (Req 2.6; design §3.1)
  - [x] 4.2 Copy schema + roles/permissions + settings không nhạy cảm, ghi lineage `collection|field|relation` (Req 2.2, 2.4; design §3.1)
  - [x] 4.3 Copy items lượt 1 theo `contentScope` (giữ id item — đã chốt, design §14.9; field mã hoá decrypt/encrypt lại qua `processCrypto`), ghi lineage `baseHash` + `baseSnapshot` cho mọi item (đã chốt, §14.4) (Req 2.3, 2.4; design §2.1, §3.2, §3.3)
  - [x] 4.4 Lượt 2 viết lại tham chiếu theo `relations` (chỉ file/folder nếu giữ id item — design §2.1); đánh dấu `external` (Req 2.5; design §3.2)
  - [x] 4.5 Files: copy metadata, dùng chung `filenameDisk`; quyết định object chỉ có ở `/media` (tiền tố theo site) — copy byte hay giới hạn v1; đường xoá dòng file hiện không xoá object nên không cần sửa (Req 3.1-3.3; design §3.4)
  - [x] 4.6 Danh sách loại trừ: API keys, secrets, sessions, audit, revisions, agent memory, trust ledger, setting `revalidation.targets`, pipeline Firebase Sync, materialized collections (Req 2.8; design §3.5)
  - [x] 4.7 Integration test trên Postgres thật: fork `all` và `collections[]`, relation m2o/m2m/m2a còn đúng, chạy lại sau lỗi không nhân bản, Origin không đổi một byte (Req 2.3-2.7)

- [x] 5. Cô lập Side_System
  - [x] 5.1 Copy webhooks/flows/CDC/deployments ở trạng thái disabled, không secret; intents `paused`; extension của Environment luôn `enabled = false` sau fork — kể cả official extension mà `finalizeSiteProvisioning` tự cài (Req 4.1, 4.2; design §4 mục 1a)
  - [x] 5.2 `isEnvironment(siteId)` cache theo request; chặn tại **từng** điểm phát ra ngoài — `dispatchItemEvent`, `CdcDispatcher`, `dispatchFirebaseSync`, `runRevalidationDispatch`, email/push — vì không có dispatcher chung (Req 4.1-4.3; design §4)
  - [x] 5.3 Delivery: `X-Robots-Tag: noindex` cho site con; xác nhận cache key + search index tách theo `siteId` (Req 4.4; design §4)
  - [x] 5.4 Test: ghi item trong Environment không bắn webhook, không chạy flow, không tạo agent run của Origin (Req 4.1-4.3)
  - [x] 5.5 Studio: danh sách Environment, tạo/xoá, chuyển site, nhãn Environment cố định (Req 4.5, 5.1; design §11)

### Phase C — Schema_Promote

- [x] 6. Diff theo lineage
  - [x] 6.1 Remap manifest Environment sang không gian Origin; nhận rename qua lineage → `renameFrom` (Req 7.2; design §7)
  - [x] 6.2 Phát hiện schema conflict bằng `baseHash` của lineage schema (Req 7.4; design §7)
  - [x] 6.3 `promoteSchema({ dryRun })` trả Merge_Plan; apply qua `ConfigImportService(origin)`; yêu cầu `confirmRiskyChange` + `migrationPlan` cho thay đổi rủi ro (Req 7.1, 7.3, 7.5; design §7)
  - [x] 6.4 Cập nhật lineage sau apply; audit `environment_schema_promoted` (Req 7.6, 12.1)
  - [x] 6.5 Test: thêm field, rename field, đổi kiểu có migrationPlan chạy trên item tạo sau fork, conflict hai bên cùng sửa một field (Req 7.2-7.5)

### Phase D — Content_Promote một chiều (điểm dừng của v1)

- [x] 7. Phân loại + áp dụng
  - [x] 7.1 Hàm thuần `classify(base, origin, env)` theo bảng design §8.1; so sánh ở không gian id Origin (Req 8.2; design §8.1)
  - [x] 7.2 Viết lại tham chiếu file/folder env → origin (item→item giữ nguyên vì cùng id — §14.9); phát hiện `DEPENDENCY_NOT_PROMOTED` (Req 8.3, 8.6; design §8.2)
  - [x] 7.3 Sắp thứ tự create → update → delete; xử lý vòng tham chiếu (Req 8.6; design §8.2)
  - [x] 7.4 Schema gate `SCHEMA_NOT_PROMOTED` (Req 8.5; design §8.2)
  - [x] 7.5 Pre-flight toàn bộ rồi ghi qua `ItemService(origin).patch` với Write_Precondition; cập nhật `baseHash`/`baseRevisionId` (Req 6.5, 8.3, 8.4, 8.7, 8.8, 10.2; design §8.2, §10.2)
  - [x] 7.6 Khoá `merging` + `merge_runs` + resume idempotent (Req 10.1, 10.3; design §10.1, §10.2)
  - [x] 7.7 Integration test: promote sạch, conflict bị bỏ qua không ghi đè, item mới tham chiếu item mới, editorial gate chặn, chạy lại sau lỗi (Req 8.3-8.8, 10.3)
  - [x] 7.8 (chuyển từ 10.1, §14.8) Studio: màn Merge_Plan chỉ đọc cho dry-run của Content_Promote — nhóm theo action, đếm, cờ `truncated` (Req 8.1, 8.8; design §9)

### Phase E — Merge ba chiều, UI, hoàn tác (v1.1 — ngoài phạm vi v1, đã chốt §14.8)

- [ ] 8. Thuật toán
  - [ ] 8.1 Hàm thuần `threeWay(base, origin, env, fieldDefs)` theo field và theo locale; mảng nguyên khối (Req 9.2-9.4; design §9)
  - [ ] 8.2 Property test: không bên nào đổi → base; một bên đổi → bên đó; đối xứng; áp resolution `origin`/`environment` cho kết quả đúng (Req 9.3, 9.4)
  - [ ] 8.3 Đọc Base theo phương án §14.4 đã chốt (khuyến nghị: luôn `baseSnapshot`, không dựng từ revision); fallback conflict toàn phần (Req 9.7; design §3.3)
  - [ ] 8.4 Conflict cấp item (xoá vs sửa) (Req 9.5)
  - [ ] 8.5 `merge({ dryRun, resolutions })`; 422 `UNRESOLVED_CONFLICTS`; tôn trọng `pinnedFields` (Req 9.1, 9.6, 9.8; design §9)

- [ ] 9. Hoàn tác
  - [ ] 9.1 `revertMergeRun`: revert theo `revisionId` có precondition; item `created` → soft-delete; outcome `conflict` khi Origin đã đổi (Req 10.4, 10.5; design §10.3)
  - [ ] 9.2 Provenance `revisions.sources` mang environment id + merge run id (Req 12.3; design §10.3)

- [ ] 10. Studio Merge UI
  - [ ] 10.2 Khung giải quyết conflict ba cột Base / Origin / Environment, tái dùng `RevisionsDiff` (Req 9.4; design §9)
  - [ ] 10.3 Lịch sử merge run + nút hoàn tác; cảnh báo rõ Schema_Promote không hoàn tác được (Req 10.5; design §10.3)

### Phase F — Docs, Setup Impact, DoD

- [x] 11. Docs
  - [x] 11.1 `docs/en/api/hono-api-spec.md` + bản `docs/vi/`: các route `/environments*`, `ETag`/`If-Match`, mã lỗi mới (DoD §4, §4a)
  - [x] 11.2 `docs/en/data-model.md` + bản `docs/vi/`: ba bảng mới (DoD §4, §4a)
  - [x] 11.3 Trang feature `content-environments` ở cả hai locale: workflow fork → sửa → promote schema → promote/merge content → hoàn tác; giới hạn v1 (DoD §4a)
  - [x] 11.4 Chạy `docs:i18n:parity` → `verify` → `stamp-pair --verified` → `detect`; bỏ artifact detect (CLAUDE.md "Docs i18n")
  - [x] 11.5 CHANGELOG `[Unreleased]` + ghi chú migration

- [ ] 12. Registry & DoD
  - [x] 12.1 **Setup Impact**: rà 6 câu hỏi, ghi dòng Registry (ID cấp lúc merge) (Req 14.2)
  - [x] 12.2 DoD §2b multi-tenant: rà mọi query của `EnvironmentService` và worker có lọc `site_id` (Req 11.2)
  - [ ] 12.3 DoD §2d shell: xác nhận chuyển Environment không đổi contract của `apps/shell` (Req 14.3)
  - [ ] 12.4 DoD §5 tutorial impact: `If-Match` có ảnh hưởng ví dụ SDK/tutorial không
  - [x] 12.5 `turbo run typecheck` recursive + test đích trên Postgres local (Node 24)

---

## Review gates

Một phase chỉ được mở PR khi đạt đủ exit criteria của nó, và chỉ được bắt đầu phase kế sau khi PR đó merge. Reviewer đối chiếu từng dòng; dòng nào không áp dụng phải ghi lý do trong mô tả PR, không bỏ trống.

### G0 — Duyệt spec (trước khi viết dòng code đầu tiên)

- [x] Năm giả định ở "Implementation status" đã được kiểm chứng bằng cách đọc code; kết quả ghi lại ngay tại mục đó (đúng / sai + file:line). *(2026-11-15, đối chiếu `origin/main` và nhánh của #811)*
- [x] Giả định nào sai thì `design.md` đã được sửa tương ứng: §3.3 (Base), §3.4 (files), §3.5 + §4 (không có dispatcher chung), §6 (precondition + coalescing), §10.3 (`revertRevision`).
- [x] Design drift về khoá item đã xử lý: design §2.1–§2.2 mô tả khoá hiện tại và `(site_id, id)` của #811, remap còn cần ở đâu, lineage, và chiến lược test theo khoá đích.
- [x] §14.4 và §14.7 đã chốt: Base luôn là `baseSnapshot` trong Lineage (field mã hoá lưu hash, `baseHash` dùng SHA-256); ETag là cột `version` mới trên `lumibase_items`. *Decided (owner, 2026-11-16).*
- [x] §14.1 đã chốt: 50 000 item mỗi fork, lô 100, ≤ 10 lô hoặc ~20 s mỗi lần chạy job, mục tiêu ≤ 15 phút tổng (cần đo ở GB), `environments.maxPerSite` = 3. *Decided (owner, 2026-11-16).*
- [x] §14.9 đã chốt: Fork giữ id item, remap schema/file/folder; lời Req 2.4, 2.5, 8.3, 8.6 đã sửa theo. Có hiệu lực khi #811 merge (dòng cuối của G0). *Decided (owner, 2026-11-16).*
- [x] §14.2, §14.3, §14.5, §14.6 hoãn sau v1. *Decided (owner, 2026-11-16).*
- [x] Phạm vi v1 = Phase A–D; Phase E (task 8–10) là v1.1; task 10.1 đã chuyển sang Phase D thành 7.8. *Decided (owner, 2026-11-16).*
- [ ] PR #811 (`0035_items_site_scoped_pk`) đã merge trước khi mở Phase B; số migration của feature này cấp cao hơn `0035`.

### Điều kiện chung cho mọi PR của feature này

- [ ] `turbo run typecheck` recursive sạch (không chỉ `-F` một package).
- [ ] Test đích của phase pass trên Postgres thật, Node 24; kết quả dán trong mô tả PR.
- [ ] Flag `environments.enabled` OFF → toàn bộ test suite hiện có không đổi kết quả (trừ Phase A).
- [ ] Mỗi task một commit; số migration và ID Setup Impact đã đối chiếu với mọi nhánh đang mở.
- [ ] Mục "Implementation status" được cập nhật: phase nào xong, deviation nào so với design và vì sao.

### GA — Write_Precondition

- [x] Request không có `If-Match` cho kết quả như trước (test hồi quy trên route items hiện có).
- [x] Test đồng thời: hai PATCH cùng ETag → đúng một cái 200, một cái 412, dữ liệu là của cái thắng.
- [x] Kiểm tra nằm trong cùng câu UPDATE (reviewer đọc SQL sinh ra), không phải SELECT rồi UPDATE.
- [x] Coalesced writes không làm precondition báo sai (có test). G0 đã thấy coalescing chỉ hoãn invalidation (`item-service.ts:2246-2280`), nên đây là test hồi quy, không phải rủi ro đã biết.
- [ ] DoD §2d: bản shell desktop/mobile lưu item bình thường, xử lý được 412.

### GB — Environment, Fork, cô lập

- [ ] Fork `all` trên site mẫu: số dòng mỗi bảng ở Environment khớp Origin trong phạm vi; mọi relation m2o/o2m/m2m/m2a resolve đúng trong Environment.
- [ ] Origin không đổi sau fork: so hash toàn bộ `items.data` và `updated_at` trước/sau.
- [ ] Canary chéo site theo design §2.2 mục 3 (sửa/xoá/publish theo lịch/retention trên item Environment cùng id → item Origin không đổi) pass trên schema có migration `0032`.
- [ ] Field mã hoá (shared và envelope) đọc được trong Environment sau fork.
- [ ] Giết worker giữa chừng rồi chạy lại → không dòng trùng, kết thúc `ready`.
- [ ] Ghi item trong Environment → 0 webhook gửi, 0 flow run, 0 agent run, 0 email/push (đếm ở dispatcher); 0 extension bật trong Environment ngay sau fork, 0 hook chạy.
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

**Phase A xong (2026-11-16). Phase B, C, D xong (2026-11-25), PR vào `epic/853-content-environments`, chờ review.** Phase E (task 8–10) là v1.1, chưa bắt đầu. Phase F: docs, CHANGELOG, Setup Impact xong; 12.3 và 12.4 còn mở (xem dưới).

### Phase B–D — những gì đã giao (2026-11-25)

- Migration `0045_content_environments` (viết tay, additive) + journal + 3 bảng trong `rls-policies.sql`. Số migration và ID Setup Impact (`360`) là tạm, cấp lại lúc merge.
- `services/environments/`: `environment-service.ts` (create/list/get/delete/retry), `fork.ts` (worker theo pha), `isolation.ts` (marker + guard), `schema-promote.ts`, `content-promote.ts`, `classify.ts`, `base.ts`, `file-refs.ts`, `lock.ts`. Route `routes/environments.ts`. Studio: Settings → Environments + `EnvironmentBanner`.
- Test trên Postgres thật (Node 22 trong môi trường này): `fork.db.integration.test.ts` (6), `schema-promote.db.integration.test.ts` (5), `content-promote.db.integration.test.ts` (8), `pure.test.ts` (property test `classify`, hash), Studio `environments-page.test.tsx` (5).

### Deviation so với design (có chủ đích)

1. **`lumibase_environments.site_id` = Origin**, site con ở `environment_site_id` (design §2 ghi ngược lại). Lý do: dưới `LUMIBASE_DB_RLS=enforce`, kết nối scoped theo Origin phải thấy dòng để list/xoá/khoá. Lineage giữ `site_id` = site con như design.
2. **Flag**: dùng release flag `content-environments` (#869, đã có sẵn trong registry, dark + siteToggle) thay cho settings `environments.enabled` (task 2.3). Route trả 404 khi tắt, đúng Req 14.1.
3. **Không dùng `QueueProvider`** cho fork (task 4.1): dùng mẫu lease + cursor + tick mỗi phút như import (#726) và locale generation (#714) — không cần thêm queue binding trên Workers, chạy được cả hai runtime.
4. **Marker `environment.origin`** (setting của site con, key `environment.*` bị settings API từ chối) cho `isEnvironmentSite` thay vì tra `lumibase_environments`: bảng đó thuộc Origin nên kết nối scoped theo site con (RLS enforce) không đọc được.
5. **Side system (Req 4.1/4.2)**: webhooks/flows copy ở trạng thái inactive, không secret/header. CDC subscriptions, deployments và intents **không copy** (thay vì copy disabled) — v1 không có giá trị dùng chúng trong environment, và không copy là an toàn hơn. Email bảo mật (khoá tài khoản, …) không bị chặn: đó là bảo mật tài khoản, không phải side effect nội dung; push agent bị chặn tới khi bật `environments.sideEffects.notifications`.
6. **Content_Promote chỉ promote `data`**; status/publish window/sort giữ của Origin (item tạo mới lấy status của environment qua editorial gate).
7. **Pre-flight (Req 10.2)**: pre-flight trước lần ghi đầu gồm schema gate, dependency gate và lập lại kế hoạch khi đã giữ khoá. Permission/validation/editorial gate chạy ở từng lần ghi qua `ItemService` của người gọi; lỗi thành outcome `failed` của item đó (nguyên tử theo item, resumable theo lần chạy — đúng §10.2, chặt hơn §10.2 không được vì `ItemService` không nhận `tx`).
8. **Đổi kiểu field (Req 7.5)**: `migrationPlan` được chuyển cho guard của `SchemaService`, nhưng `SchemaService` không thực thi plan (B213) — giá trị cũ không được chuyển đổi. Rename thì CÓ chuyển dữ liệu: `data[from]` → `data[to]` trong mọi item Origin của collection (cùng transaction, `version` tăng).
9. **Bị chặn có lý do**: đổi tên collection, đổi tên field mã hoá (AAD chứa tên field), bật/tắt mã hoá, đổi field của relation.
10. **Xoá environment đang `forking`** được phép khi không bước fork nào giữ lease (worker chết); Req 5.3 chỉ còn chặn khi lease đang giữ hoặc `merging`.
11. `status = 'merged'` không dùng (environment quay về `ready` sau promote, `mergedAt` ghi lần promote nội dung gần nhất).
12. `snapshotData` coi `null` ở top-level như vắng mặt (promote xoá field bằng cách ghi `null`).

### Còn mở (gate chưa đạt đủ)

- GB: fork 50 000 item trong ≤ 15 phút **chưa đo** (Docker và Workers); fork chỉ test với mã hoá shared-key, chưa test envelope; m2m/m2a chưa có fixture riêng (identity mapping không viết lại item→item nên rủi ro thấp); test chạy bằng role superuser — chưa chạy với RLS enforce.
- GD/GC: kiểm quyền "user có quyền ở Environment nhưng không có quyền ghi ở Origin" chưa có test riêng (đi qua `ItemService` của người gọi).
- 12.3 (shell DoD §2d): không đổi base URL/token; chưa thử trên bản desktop/mobile.
- 12.4 (tutorial impact): chưa rà.
- Gate GA còn mở từ Phase A (shell).

Phase A — những gì đã giao:

- Migration `0036_items_version` (viết tay; ban đầu là `0034`, đổi sang `0035` khi `0034_item_tree` vào main trước, rồi `0036` khi `0035_items_site_scoped_pk` (#811) vào main): `lumibase_items.version integer NOT NULL DEFAULT 0`.
- `version = version + 1` (biểu thức phía DB, `nextItemVersion()` trong `services/item-etag.ts`) ở: `ItemService.patch` (và `replace`, `bulk` update, `revertRevision` đi qua nó), `softDelete`, `cryptoShred`, `releasePin`, `EditorialService` transition, ba UPDATE của `scheduler-worker` (publish, unpublish, retention archive), `dependents-service` set_null/reassign, và (sau khi merge #749 tree collections) `move` của chính item được di chuyển cùng mọi node bị xoá theo cascade. Không tăng: worker envelope/rewrap (chỉ mã hoá lại), rebase `path` của con cháu và đánh số lại `sort` của anh em khi di chuyển — đó là hiệu ứng cấu trúc, tăng ở đó sẽ làm `If-Match` của người đang sửa một item khác trong cây thất bại vô cớ.
- `ItemService.patch/replace(…, { expectedVersions })`: kiểm sớm sau SELECT rồi kiểm lại trong cùng `UPDATE … WHERE version = $v`; không khớp → `PRECONDITION_FAILED` 412, transaction rollback, không ghi gì.
- Route: `ETag` ở GET detail (qua out-param `ItemDetailMeta`, nên vẫn có khi dùng `fields=`) và ở PATCH/PUT thành công; `If-Match` parse theo RFC 9110 (tag yếu không khớp, `*` = không điều kiện). CORS: allow `If-Match`, expose `ETag`.
- SDK `items(name).patch/replace(id, input, { ifMatch })`, `ItemRow.version`. Studio item editor ghim version lúc nạp bản nháp, gửi làm `If-Match`, cập nhật sau khi lưu, và hiện banner riêng khi 412 kèm nút tải bản mới nhất.

Deviation so với design §6: tham số service là `expectedVersions: number[]` thay vì `expected: { etag }`, vì `If-Match` có thể liệt kê nhiều tag; route chịu trách nhiệm parse header.

Chưa làm trong Phase A (gate GA còn mở): kiểm trên bản shell desktop/mobile (DoD §2d) — chưa chạy được ở môi trường này; thay đổi CORS là điều kiện cần cho shell nhưng chưa được thử thật.

Phát hiện ngoài phạm vi (DoD §7): `envelope-migration-worker` và `rewrap-worker` đọc `data`, mã hoá lại, rồi ghi đè `data` không điều kiện. Một `PATCH` rơi vào giữa hai bước đó bị mất. Giờ đã có cột `version`, sửa được bằng `AND version = <version đã đọc>` trong UPDATE của hai worker; chưa sửa ở đây.

### Kiểm chứng giả định (G0, 2026-11-15)

Đối chiếu trên `origin/main`; chỗ nào nhánh của PR #811 (`feature/friendly-dijkstra-dupuli`) khác thì ghi rõ. Đường dẫn tương đối từ `apps/cms/src/` trừ khi ghi khác.

1. **Item write là last-write-wins, không có precondition dùng được cho optimistic concurrency — ĐÚNG.**
   `ItemService.patch` (`services/item-service.ts:1090`) đọc dòng bằng `SELECT` riêng (`:1110-1122`), gộp `{ ...currentData, ...patch.data }` trong bộ nhớ (`:1146-1148`), rồi `UPDATE … SET data = <bản gộp>` với `WHERE` chỉ gồm `site_id`, `collection_id`, `id`, `deleted_at IS NULL` và permission clause (`:1237-1245`) — không có điều kiện phiên bản. Route PATCH/PUT (`routes/items.ts:285-311`) không đọc header nào; grep `If-Match`/`expectedRevision` trong `apps/cms/src` chỉ thấy `If-None-Match` của delivery/media (`routes/media.ts:325`, `services/delivery-cache.ts:106`). Hệ quả nặng hơn giả định: hai PATCH đồng thời sửa **field khác nhau** vẫn mất một bên. `replace` chỉ gọi `patch` (`:1320-1322`). Coalesced writes chỉ hoãn materialized refresh + cache invalidation (`:2246-2280`), không hoãn UPDATE → không cản precondition. Không có cột phiên bản; `updated_at` lấy từ `new Date()` của app (`:1235`). #811 không đổi phần này. Design §6, §14.7 đã sửa.
2. **`revisions.delta.after` đủ dựng lại trạng thái đầy đủ của item tại một revision — ĐÚNG MỘT PHẦN, không dùng được làm merge base.**
   Đúng: `after` là toàn bộ `data` sau ghi, không phải diff (`:1054` create, `:1252` patch, `:1596` bulk create), và `revertRevision` dùng nó làm snapshot (`:1674-1675`). Sai ở năm điểm: (a) chỉ có `data`, không `status`/`sort`/publish window; (b) field mã hoá là ciphertext (`after: encryptedFinal`, `:1252`), envelope sinh DEK mới mỗi lần ghi (`:2097-2099`) và chỉ `items.dek_wrapped` hiện tại được giữ (`:1230`) → revision cũ không giải được; (c) có đường ghi `data` không tạo revision: `services/dependents-service.ts:272-277`, `services/envelope-migration-worker.ts:122-125`, `:141-144`, `services/rewrap-worker.ts:114-117`; (d) revision `staged` nằm chung bảng (`services/veto-service.ts:163-177`), phải lọc `staged = false`; (e) không có job dọn revision (`services/review-run-retention.ts:44` chỉ xoá `reviewRuns`), revision chỉ mất theo cascade khi item bị hard-delete (`packages/database/src/schema/cms.ts:261-263`; #811 giữ cascade qua FK composite `lumibase_revisions_item_fk`). Thêm: `revertRevision` không khôi phục đúng vì `replace` là merge, và đưa ciphertext vào `patch` như plaintext. Design §3.3, §10.3, §14.4 đã sửa.
3. **Cache key và search index đã tách hoàn toàn theo `siteId` — ĐÚNG.**
   Search index `${siteId}__${collection}` (`packages/runtime/src/interfaces/search.ts:52-54`), mọi call site đi qua nó (`services/item-service.ts:1920`, `:1946`, `services/content-indexing-worker.ts:72`, `:86`, `routes/search.ts:134`, `:195`); tag cache `items:${siteId}:${collection}` và `deliver:${siteId}` (`services/content-invalidation.ts:20-26`); compiled schema theo site (`services/schema-service.ts:1142`, `:1162`); delivery `deliver:${siteId}:…` (`services/delivery-cache.ts:132-134`). Grep mọi `cache.get/set/delete` có template key không chứa site chỉ thấy `git:oauth:${state}` và `site-domain:${sub}` (không phải dữ liệu nội dung). Lưu ý: bảng vật lý của materialized collection đặt tên theo id dòng (`services/materialize-service.ts:128`) — không copy dòng đó (design §3.5). `X-Robots-Tag` chưa tồn tại, task 5.3 phải thêm.
4. **Webhook/flow/notification có một điểm dispatch chung — SAI.**
   `ItemService.patch` gọi riêng từng kênh (`:1285-1298`): flows qua `dispatchItemEvent` (`services/flow-dispatch.ts:87-111`), webhooks qua outbox CDC `writeCdcEvent` (`:764`) → `CdcDispatcher` (`modules/cdc/change-feed/dispatcher.ts:158`, sender `:481`, khởi tạo ở `serve.ts:350`, `cloudflare-cron-parity.ts:90`, `modules/cdc/change-feed/routes.ts:215`), Firebase Sync (`:2036-2053`), ISR revalidation từ setting `revalidation.targets` (`:2281-2294`, `services/content-invalidation.ts:98-110`), extension hooks (`:707`). Notification là kênh riêng (`modules/notifications/dispatcher.ts:329`, `services/notification-service.ts:40`). Mọi kênh đọc cấu hình theo `siteId`, nên lớp chặn chính là không copy/disable cấu hình; `isEnvironment` là lớp thứ hai ở năm điểm. Design §3.5, §4 đã sửa.
5. **Bảng files có cột storage key dùng chung được giữa hai dòng — ĐÚNG MỘT PHẦN.**
   `lumibase_files.filename_disk` (`packages/database/src/schema/platform.ts:50`) là `text NOT NULL`, không unique, không FK → hai dòng ở hai site trỏ cùng object được; object upload qua presigned `/files` nằm ở key không tiền tố site (`routes/files.ts:188`, `:238`). Nhưng: thư viện `/media` dùng tiền tố `sites/${siteId}/media/` (`routes/media.ts:89-95`, GET `:350`, DELETE `:500`) nên object chỉ có ở `/media` không chia sẻ được; và `DELETE /files/:id` không xoá object (`routes/files.ts:161-174`) — không có "đường xoá file" nào cần sửa như design cũ viết. Design §3.4 đã sửa.

### Design drift do PR #811

Trên `main`, `lumibase_items` có `PRIMARY KEY (id)` toàn instance (`packages/database/src/schema/cms.ts:23`, `:187`). #811 đổi sang `PRIMARY KEY (site_id, id)` (`packages/database/drizzle/0035_items_site_scoped_pk.sql`) với FK composite cùng site từ `revisions`, `release_items`, `content_reviews`. Lý do "id toàn cục nên phải remap" chỉ còn đúng cho schema/file/folder; với item, Fork giữ id (design §2.1, §14.9 — Decided 2026-11-16). Ghi chú cho #811 (không thuộc PR này): comment trong `schema/cms.ts` của nhánh đó vẫn ghi "migration 0029" trong khi file là `0032`.
