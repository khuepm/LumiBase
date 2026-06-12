# Implementation Plan: Content OS UI (Mission Control v2)

## Overview

UI-only, không endpoint mới. Thứ tự: nguồn dữ liệu chung → khung điều hướng → từng màn → bề mặt ngoài Mission Control → chất lượng. Mỗi task tự ship được; test theo convention `mission-control.test.tsx`.

## Tasks

- [x] 1. Nguồn dữ liệu inbox dùng chung
  - [x] 1.1 `use-inbox.ts`: chuyển `buildEntries` từ `inbox.tsx` sang, thêm `id = <kind>:<sourceId>` cho mỗi entry; hook `useInboxData()` trả `{ entries, counts, isLoading }` với queryKey giữ nguyên v1; counts gồm total/approvals/staged/incidents/intentErrors/nearestAutoCommitAt
    - _Requirements: 3.5, 2.1, 6.1, 6.3_
  - [x] 1.2 Refactor `inbox.tsx` (`ExceptionInbox`) dùng `useInboxData()`, thêm props `limit?` và `onOpenEntry?`; key theo entry id thay index; hành vi inline action giữ nguyên (test v1 pass)
    - _Requirements: 3.6, 2.3, 7.2_
  - [x] 1.3 Unit test `use-inbox`: thứ tự urgency, id ổn định, counts
    - **Validates: Requirements 3.5, 6.1**

- [x] 2. Layout + routes
  - [x] 2.1 `layout.tsx` (`MissionControlLayout`): header (title, nút Kill switch mở modal chứa `KillSwitchPanel`, nút Compose intent mở `IntentComposer`), sub-nav Link với aria-current từ URL, hỗ trợ Admin_Base
    - _Requirements: 1.2, 1.3, 7.4_
  - [x] 2.2 Đăng ký routes trong `router.tsx`: dashboard/inbox/intents/intents-$id/trust/constitution × 2 biến thể Admin_Base; gỡ tab navigation cũ trong `index-page.tsx`
    - _Requirements: 1.1, 7.5_

- [x] 3. Dashboard
  - [x] 3.1 Viết lại `index-page.tsx` thành DashboardPage: 5 stat cards từ `useInboxData().counts` + intents + kill-switch query; card click điều hướng theo Req 2.2
    - _Requirements: 2.1, 2.2_
  - [x] 3.2 Tách `slo-table.tsx` từ `slo-health.tsx` (bảng nhận data qua props, row link được); dashboard nhúng `ExceptionInbox limit={5}` + SLO table + link "Open inbox"/"All intents"; inbox-zero state
    - _Requirements: 2.3, 2.4, 2.5_

- [x] 4. Inbox split-pane + Field_Diff
  - [x] 4.1 `staged-diff.tsx` (`StagedDiff`): fetch item hiện hành qua SDK, render `RevisionsDiff` (before=item.data, after=shallow-merge patch); fallback patch-only "added" + notice khi fetch lỗi; header provenance (agentRole, countdown, link item editor)
    - _Requirements: 3.2, 3.3, 3.4_
  - [x] 4.2 `inbox-page.tsx` (`InboxPage`): split-pane list/detail; chọn entry ↔ search param `entry`; detail per kind (veto→StagedDiff + reason input + nút Veto; approval→approve/reject; incident→chi tiết; intent_error→resume); deep-link Req 1.4
    - _Requirements: 3.1, 3.4, 1.4_
  - [x] 4.3 Component tests: StagedDiff (diff + fallback), InboxPage (chọn entry, veto kèm reason)
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 5. Provenance trên content editor
  - [x] 5.1 Mở rộng `RevisionRow` (SDK types) với các trường provenance optional
    - _Requirements: 4.1, 7.1_
  - [x] 5.2 `provenance-badge.tsx` (content module): badge human/agent + tooltip chi tiết; `revisions-panel.tsx` hiển thị badge per revision + khối Provenance cho revision agent được chọn
    - _Requirements: 4.2, 4.3_
  - [x] 5.3 `item-detail.tsx`: badge provenance của revision mới nhất ở header
    - _Requirements: 4.4_
  - [x] 5.4 Component test: badge agent + khối provenance render đúng trường có giá trị
    - **Validates: Requirements 4.2, 4.3**

- [x] 6. Trang Intents
  - [x] 6.1 `intents-page.tsx`: bảng SLO health (tái dùng `slo-table.tsx`), row link đến detail; gỡ tab SLO cũ
    - _Requirements: 5.1, 7.5_
  - [x] 6.2 `intent-detail.tsx`: meta + nhãn autonomy L0–L4 + budget + rule cards + drift list (link item editor) + Pause (kill-switch scope `intent`) / Resume; not-found khi id lạ
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  - [x] 6.3 Component test: pause/resume gọi đúng API; not-found
    - **Validates: Requirements 5.4, 5.5**

- [x] 7. AppShell exception badge
  - [x] 7.1 Badge count trên icon Mission Control trong `app-shell.tsx`: tổng từ counts, ẩn khi 0/lỗi, "9+" khi >9, poll 60s chung query cache
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 8. Chất lượng & hồi quy
  - [x] 8.1 Test v1 (`mission-control.test.tsx`) pass sau refactor; cập nhật import nếu file đổi chỗ
    - _Requirements: 7.2_
  - [x] 8.2 `pnpm typecheck` + studio test suite xanh; rà soát không còn dead code điều hướng cũ
    - _Requirements: 7.3, 7.5_

- [x] 9. Enrich `GET /agent/staged` (gap phát hiện sau khi ship UI: raw approvals thiếu collection/itemId/patch)
  - [x] 9.1 `VetoService.listPending`: join revisions (subjectId) + collections, trả thêm `approvalId/collection/itemId/patch/agentRole`; staging mất → field null; mọi join scope siteId
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 9.2 Service test: shape enrich + staging mất
    - **Validates: Requirements 8.1, 8.2, 8.4**

- [x] 10. Seed demo Content OS
  - [x] 10.1 `packages/database/scripts/seed-content-os-demo.ts` + npm script `seed:content-os-demo`: collection+items demo, 2 intents (active có drifts, error), staged revision + veto approval trong window, incidents, autonomy grants, constitution active, revisions provenance agent — id prefix `cosdemo_`, upsert re-run an toàn
    - _Requirements: 9.1, 9.2, 9.3_

- [ ] 11. Icon convention + Activity feed
  - [ ] 11.1 `components/fill-icon.tsx` (`FillIcon`): lucide với `fill="currentColor"` — dùng cho mọi surface mới
    - _Requirements: 13.1_
  - [ ] 11.2 `api.ts` thêm fetchers `runs()`/`goals()`; `activity-feed.tsx` (12 run mới nhất, badge status, join goal title, fallback goal id rút gọn); nhúng vào cột phải dashboard; component test
    - _Requirements: 10.1, 10.2, 10.3_

- [ ] 12. Intent Composer v2 — rule cards
  - [ ] 12.1 Sửa `compileIntent` gửi `{description, collection}` đúng contract; collection picker từ schema API (fallback nhập tay)
    - _Requirements: 11.1_
  - [ ] 12.2 Viết lại `intent-composer.tsx`: rule cards 6 loại (editor tham số per loại, Add rule, xoá), metadata form (name/schedule/autonomyCap/budget), warnings, raw JSON toggle 2 chiều; confirm gửi object có rules array
    - _Requirements: 11.2-11.6_
  - [ ] 12.3 Cập nhật test v1 composer theo contract mới + test mới: compile đúng payload, sửa tham số card, confirm payload
    - **Validates: Requirements 11.1, 11.2, 11.6**

- [ ] 13. Goal tree
  - [ ] 13.1 `goals-page.tsx`: cây từ `parentGoalId` (mồ côi thành root), node có role/status/origin badge + run mới nhất + link intent; routes ×2 + mục "Goals" trong sub-nav; component test (nesting, orphan, link intent)
    - _Requirements: 12.1-12.4_
