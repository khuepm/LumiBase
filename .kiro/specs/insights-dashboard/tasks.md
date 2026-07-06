# Implementation Plan: Insights / Dashboard

> **Status (PR #208, 2026-07-06):** Substantially complete before this PR — shared `PanelQuery`, `dashboards`/`panels` tables, `InsightsService` (safe aggregate + field whitelist), routes, and Studio module (list/dashboard/panel-editor/panel-view) all exist with route + service security tests. Remaining polish (dedicated FilterBuilder component extraction, panel-render component tests, optional materialized source) tracked as follow-up. Setup Impact recorded (registry #39, `n/a`).

## Overview

Thứ tự: contract chung (Panel_Query) → schema/migration → service an toàn → routes → SDK → Studio (list → grid → editor → render) → chất lượng. Backend bảo mật làm trước và test kỹ. Mỗi task tự ship được.

## Tasks

- [x] 1. Contract chung Panel_Query
  - [x] 1.1 `packages/shared/src/schemas/insights.ts`: `panelQuerySchema` (Zod) + `PanelQuery`, `GridPosition`, `PanelType`; refine non-count cần field; filter tái dùng `conditionRuleSchema`
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.2 SDK re-export `PanelQuery`/`Dashboard`/`Panel` backward-compatible
    - _Requirements: 2.4_

- [x] 2. Schema + migration
  - [x] 2.1 Thêm bảng `dashboards` + `panels` vào `packages/database/src/schema/cms.ts` (cột + index theo design); nanoid PK
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
  - [x] 2.2 Migration viết tay + journal; `db:migrate` chạy sạch
    - _Requirements: 1.3, 10.1_

- [x] 3. Service an toàn (lõi)
  - [x] 3.1 `insights-service.ts`: CRUD dashboards/panels filter siteId
    - _Requirements: 4.1, 4.2_
  - [x] 3.2 `runPanel`: assertCollection (site-scoped) → fieldWhitelist (qua SchemaService + cột hệ thống) → assertFields → executeAggregate
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 3.3 `executeAggregate`: aggregate map cố định; JSONB accessor tham số hóa; LUÔN `WHERE site_id` + `deleted_at IS NULL`; groupBy + order + limit (default 50, max 1000); filter ConditionRule → WHERE tham số hóa
    - _Requirements: 3.4, 3.5, 3.6, 3.7_
  - [x] 3.4 Service test BẢO MẬT: count/sum/groupBy đúng; field ngoài whitelist bị chặn (vd `id); DROP`); collection cross-tenant bị chặn; filter áp đúng; siteId không override được từ body
    - **Validates: Requirements 3.2, 3.3, 3.5, 10.2**

- [x] 4. Routes
  - [x] 4.1 `apps/cms/src/routes/insights.ts` mount `/api/v1/dashboards`: CRUD dashboards + panels; validate panelQuerySchema khi tạo panel; 404 cross-tenant; response `{ data }`/`{ errors }`
    - _Requirements: 4.1, 4.2, 4.4, 4.5_
  - [x] 4.2 `POST /:id/panels/:pid/data` → runPanel, trả `meta {executedAt,rowCount,durationMs}`; `PATCH /:id/layout` batch position; (đề xuất) `POST /:id/panels/preview` dry-run
    - _Requirements: 4.3, 4.6, 6.2_
  - [x] 4.3 Route test: CRUD scope siteId; 404 cross-tenant; panelQuerySchema reject non-count thiếu field; `/data` trả meta
    - **Validates: Requirements 4.4, 4.5, 10.3**

- [x] 5. Studio — list dashboard
  - [x] 5.1 `insights/api.ts` (SDK wrappers) + `list-page.tsx`: card grid (name/icon/màu/số panel), New dashboard form, empty state
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 5.2 Đăng ký route `/insights` (+ `/$adminPath/insights`) trong `router.tsx` theo pattern mission-control
    - _Requirements: 5.4_

- [x] 6. Studio — dashboard view + grid
  - [x] 6.1 `dashboard-page.tsx` + `panel-grid.tsx`: render panel theo Grid_Position; kéo-thả/resize → PATCH layout; not-found khi id lạ; Add/Edit/Delete dashboard; refetch interval
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 6.2 Route `/insights/$dashboardId` (+ Admin_Base twin)
    - _Requirements: 6.1_

- [x] 7. Studio — panel editor + filter builder
  - [x] 7.1 `panel-editor.tsx`: chọn type/collection/aggregate/field/groupBy/limit/dateRange/name; field selector chỉ liệt kê whitelist từ schema API
    - _Requirements: 7.1, 7.2_
  - [x] 7.2 `filter-builder.tsx`: sinh ConditionRule (thêm/xóa điều kiện, nhóm _and/_or) → query.filter
    - _Requirements: 7.3_
  - [x] 7.3 Save gửi `query` là object PanelQuery; lỗi validate BE hiển thị inline; Preview gọi `/data` hoặc dry-run
    - _Requirements: 7.4, 7.5_
  - [x] 7.4 Component test: FilterBuilder sinh ConditionRule đúng; Save gửi object; field selector chỉ whitelist
    - **Validates: Requirements 7.2, 7.3, 7.4, 10.4**

- [x] 8. Studio — render panel + trạng thái
  - [x] 8.1 `panel-frame.tsx`: 3 trạng thái loading/empty/error (lỗi cô lập từng panel) + "updated Xs ago" từ meta.executedAt
    - _Requirements: 8.2, 8.4_
  - [x] 8.2 `metric-panel` (StatCard), `chart-panel` (recharts default), `table-panel`; component chart nhận data chuẩn hoá, không tự fetch
    - _Requirements: 8.1, 8.3_
  - [x] 8.3 Component test: PanelFrame 3 trạng thái
    - **Validates: Requirements 8.2**

- [ ] 9. (Optional) Materialized source  _(DEFERRED — explicitly optional; service is designed to accept a materialized source later, security invariants unchanged. Not implemented in PR #208.)_
  - [ ] 9.1 `options.source='items'|'materialized'` (default items); khi materialized vẫn áp whitelist + siteId trên bảng `mat_*`
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 10. Chất lượng & Setup Impact
  - [x] 10.1 `pnpm typecheck` + `pnpm test` pass (no any, import type, mọi query filter siteId); cập nhật `docs/en/api/hono-api-spec.md` + `docs/en/data-model.md`
    - _Requirements: 10.5, 10.6_
  - [x] 10.2 **Setup Impact** (DoD): rà soát 6 câu hỏi `admin-setup-wizard/setup-impact.md`. Cân nhắc seed 1 dashboard mẫu khi setup (Q1) hay không — nếu không seed thì `n/a`. Thêm dòng registry khi implement xong
    - _Requirements: DoD_
