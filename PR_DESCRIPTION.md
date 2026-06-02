## Summary

Triển khai hệ thống **ClickHouse CDC** cho LumiBase: replication real-time từ PostgreSQL sang ClickHouse cho workload OLAP/analytics, kèm Redis cache auto-invalidation, Studio management UI, AI-powered deployment flows và health monitoring.

Hệ thống hỗ trợ 3 chiến lược connector sau một interface chung (`CdcConnector`):

- **Debezium + Kafka** — high-throughput, đọc WAL, publish theo Kafka topic partition theo tên bảng.
- **ClickHouse Materialized Engine** — replication trực tiếp qua PostgreSQL replication slot, không cần message bus.
- **Airbyte** — CDC qua API, hỗ trợ full-refresh + incremental, lập lịch sync.

Các thành phần chính: Pipeline Registry (config + encrypted connection params), Cache Invalidator (INSERT→SET / UPDATE→SET / DELETE→DEL, dedup UPDATE trong cửa sổ 1s, bounded queue 10k event), Health Monitor (metrics 30s, lag threshold alert, recovery notification), AI Flow Engine (config generator + deployment orchestrator + rollback manager), CDC API routes (`/api/v1/cdc/*`), và Studio CDC Panel (list / wizard / detail). Bao gồm cả replication-slot cleanup khi xoá pipeline (`pg_drop_replication_slot`) để tránh giữ WAL vô hạn.

## Loại thay đổi

- [x] `feat` — Tính năng mới
- [ ] `fix` — Sửa bug
- [ ] `refactor` — Cải thiện code, không thay đổi hành vi
- [ ] `chore` — Công việc bảo trì (deps, CI, config)
- [x] `docs` — Cập nhật tài liệu
- [ ] `perf` — Cải thiện hiệu năng
- [x] `test` — Thêm / sửa test
- [ ] `security` — Vá lỗ hổng bảo mật

## Phase / Feature liên quan

Spec `clickhouse-cdc` — toàn bộ Task 1–17 (registry, 3 connectors, cache invalidator, health monitor, AI flow engine, API routes, Studio panel, docs, và spec revision corrections).

---

## ✅ Definition of Done (DoD)

> **Tất cả mục bên dưới phải được tích ✅ trước khi merge.**

### Code Quality

- [x] Không có TypeScript error (`pnpm typecheck` pass ✅) — *đã chạy full workspace: 11/11 tasks successful.*
- [x] Tất cả tests pass (`pnpm test` — 0 failures) — *đã chạy full workspace: 6/6 tasks successful; CMS 77 files / 883 tests, Docs 22 files / 143 tests, Runtime 2 files / 54 tests, Studio/Database pass.*
- [x] Không có lint error (`pnpm lint` / ESLint clean) — *đã chạy full workspace: 5/5 lint tasks successful.*
- [x] Self-review: đọc lại diff line-by-line trước khi request review

### Architecture & Docs

- [x] Cập nhật `architecture.md` nếu có thay đổi cấu trúc hệ thống — *thêm `docs/en/cdc/architecture.md` (system diagram + deployment topology).*
- [x] Cập nhật `apps/cms/openapi.yaml` cho **mọi** endpoint mới / thay đổi — *đã bổ sung schema + 13 endpoint `/api/v1/cdc/*`; YAML parse OK.*
- [x] Cập nhật `packages/sdk` types tương ứng với API changes — *đã thêm CDC resource/request/response types và REST helpers trong `packages/sdk`.*
- [x] Cập nhật docs trong `docs/en/` nếu thay đổi ảnh hưởng người dùng — *thêm bộ `docs/en/cdc/` (setup 3 approach, env vars, troubleshooting, deployment guides).*

### Testing

- [x] Viết unit test cho logic mới — *connectors, env-validator, rollback-manager, routes, registry, encryption.*
- [x] Viết integration test cho các endpoint / service — *`cdc-routes.test.ts`, `cdc-deployment-orchestrator.test.ts`.*
- [x] Với logic phức tạp / boundary conditions: có property-based test (fast-check) — *Properties 1–22 đều có test (≥100 iterations).*
- [x] Test thủ công trên Docker runtime (`docker compose up`) — *đã chạy `docker compose up -d` với host port override để tránh port local bị chiếm; Postgres/Redis/MinIO/MeiliSearch healthy, CMS started, `/api/v1/utils/health` trả 200; đã `docker compose down` sau test.*

### Runtime Compatibility

- [x] Route / service hoạt động trên **Cloudflare Workers** runtime — *scope đã ghi rõ: Workers host CDC API/control-plane + cache invalidation edge components; stateful connectors không chạy trong isolate.*
- [x] Route / service hoạt động trên **Node.js / Docker** runtime — *đã smoke-test Docker runtime với compose; full stateful stack chạy trên docker_compose / managed services.*
- [x] Nếu dùng API chỉ có trên một runtime: đã gate bằng feature flag và ghi chú trong `docs/en/features/runtime-abstraction.md` — *đã thêm mục CDC runtime split; deployment target explicit `docker_compose` / `cloudflare_workers`.*

### Security

- [x] Không có secret / credential hardcoded trong code — *connection params được mã hoá (`registry/encryption.ts`).*
- [x] Input validation: tất cả payload đầu vào được validate (Zod / schema) — *`packages/shared/src/schemas/cdc.ts` (PipelineCreateSchema, SyncScheduleSchema, MonitorConfigSchema, EnvVarSchema).*
- [x] Multi-tenant isolation: query có `WHERE siteId = ?` (không leak data cross-tenant) — *mọi truy vấn trong `pipeline-registry.ts` đều filter theo `siteId`.*
- [x] Với SCIM / OAuth: token không được log hoặc lưu plaintext — *connection params encrypt-at-rest; không log giá trị nhạy cảm.*

### Database / Migrations

- [x] Migration file có trong `packages/database/drizzle/` nếu có schema change — *đã generate `packages/database/drizzle/0009_abnormal_joshua_kane.sql` + snapshot/journal.*
- [x] Migration có thể chạy lại nhiều lần (idempotent) hoặc có guard `IF NOT EXISTS` — *tables/indexes dùng `IF NOT EXISTS`; FK constraints có `duplicate_object` guard.*
- [x] Rollback plan được ghi chú trong PR description nếu migration phức tạp — *xem mục Rollback Plan bên dưới.*

### Conventional Commits

- [x] Commit messages theo format `type(scope): description`
  - `feat: add CDC API routes under /api/v1/cdc (task 12.1)`
  - `test: add AI Flow Engine property tests (Properties 17, 18, 19, task 11.5)`
  - `docs: create CDC architecture and setup documentation (task 15.1)`

---

## Screenshots / Recordings

<!-- Studio CDC Panel (pipeline list / wizard / detail) — gắn ảnh nếu cần review UI. -->

## Rollback Plan

- CDC là module độc lập mount dưới `/api/v1/cdc/`; revert PR sẽ gỡ toàn bộ route và module mà không ảnh hưởng core CMS.
- Sau khi generate migration cho 3 bảng `cdc_*`: rollback bằng cách drop `cdc_pipelines`, `cdc_pipeline_health`, `cdc_deployments` (theo thứ tự FK). Các bảng chỉ chứa data CDC, không ảnh hưởng dữ liệu hiện hữu.
- Khi xoá pipeline đang chạy: connector `destroy()` sẽ release/drop PostgreSQL replication slot (`pg_drop_replication_slot`) trước khi xoá record — đảm bảo không còn slot orphan giữ WAL.

## Notes for Reviewers

- **Đã xử lý các gap trước merge:** OpenAPI CDC endpoints, SDK CDC types/helpers, migration Drizzle, typecheck/lint/test, Docker runtime smoke test.
- Test suite full workspace đã pass; riêng CDC suite vẫn bao phủ đầy đủ 22 correctness properties bằng property-based tests.
- Deployment được scope theo target: `docker_compose`/managed-services host full stateful stack; `cloudflare_workers` chỉ host edge components (CDC API + Cache_Invalidator).
