# Implementation Plan — Idempotency Keys

## Overview

Triển khai theo 5 phase: A đặt nền DB (bảng + migration viết tay + RLS), B middleware + registry route, C nối SDK/Studio, D prune worker + test toàn diện, E docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design; mỗi task = một commit riêng theo quy ước repo.

## Tasks

### Phase A — Schema & migration

- [ ] 1. Bảng `idempotency_keys`
  - [ ] 1.1 Thêm pgTable `idempotencyKeys` (nanoid PK, `site_id`, `scope`, `key`, `fingerprint`, `status`, `response_status`, `response_body`, `created_at`, `expires_at`; unique `(site_id, scope, key)`, index `expires_at`) vào `packages/database/src/schema/` file mới `idempotency.ts`, export qua `index.ts` (Req 3.1, 3.2; design §3)
  - [ ] 1.2 Viết tay migration `packages/database/drizzle/0012_idempotency_keys.sql` + entry `meta/_journal.json` (KHÔNG `drizzle-kit generate`) (design §3)
  - [ ] 1.3 Bổ sung RLS policy site-scoped cho bảng vào `packages/database/migrations/rls-policies.sql` (Req 3.3)

### Phase B — Middleware & route wiring

- [ ] 2. Middleware `idempotency.ts`
  - [ ] 2.1 Tạo `apps/cms/src/middleware/idempotency.ts`: validate header, fingerprint sha256 từ `c.req.raw.clone()`, claim bằng `INSERT … ON CONFLICT DO NOTHING RETURNING`, các nhánh MISS/replay/409/422 theo design §4; error codes `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (Req 1.1–1.5, 2.1–2.3)
  - [ ] 2.2 Persist response 2xx/4xx sau handler (`status='completed'`); DELETE row khi handler throw/5xx (Req 1.4; design §4)
  - [ ] 2.3 Registry tập trung `IDEMPOTENT_ROUTES` + gắn middleware cho: `POST /items/:collection`, `POST /items/:collection/bulk`, `POST /deployments/targets/:id/deploy`, flow-run route, `POST /uploads` (Req 5.1, 5.2)
  - [ ] 2.4 Unit test middleware: đủ 7 nhánh của bảng hành vi design §8 (Req 1, 2)

### Phase C — SDK & Studio

- [ ] 3. SDK
  - [ ] 3.1 `packages/sdk`: option `idempotencyKey` cho mutation methods; auto-gen `crypto.randomUUID()` một lần per logical call, tái sử dụng khi SDK retry; type + docs comment (Req 6.1; design §6)
  - [ ] 3.2 SDK test: retry nội bộ giữ nguyên key; hai call độc lập sinh hai key khác nhau (Req 6.1)
- [ ] 4. Studio
  - [ ] 4.1 Mutation tạo item + trigger deploy trong Studio sinh key per-submit và truyền qua SDK; double-click khi pending không tạo request key mới (Req 6.2; design §6)

### Phase D — Prune worker & test toàn diện

- [ ] 5. Prune
  - [ ] 5.1 Thêm sweep prune `expires_at < now()` batch-bounded vào scheduler tick hiện có, theo pattern `retention.ts` (Req 4.1, 4.2; design §5)
  - [ ] 5.2 Test prune: xoá đúng row hết hạn, idempotent khi chạy hai lần (Req 4.2, 4.3)
- [ ] 6. Test tích hợp & property
  - [ ] 6.1 Property test: chuỗi N retry cùng key → handler chạy đúng 1 lần, response byte-identical (design §9)
  - [ ] 6.2 DB integration race test: 2 request song song cùng key → 1 claim + 1 nhận 409 (design §9)
  - [ ] 6.3 Tenant/scope isolation test: cùng key khác site hoặc khác user → độc lập (Req 3.1, 3.2)

### Phase E — Docs, Setup Impact, DoD

- [ ] 7. Docs
  - [ ] 7.1 Viết `docs/en/features/idempotency-keys.md` + `docs/vi/features/idempotency-keys.md`: cách dùng header, bảng hành vi §8, TTL 24h, lý do Postgres-not-Redis (dual-write problem) (Req 7.1)
  - [ ] 7.2 Cập nhật `docs/en/api/hono-api-spec.md`: header, error codes 409/422, danh sách endpoint hỗ trợ (Req 7.2)
  - [ ] 7.3 Cập nhật `docs/en/data-model.md` với bảng `idempotency_keys` (Req 7.3)
  - [ ] 7.4 Ghi backlog v2 (recovery points cho multi-step external calls) vào `.kiro/steering/out-of-scope-backlog.md` (design §7)
- [ ] 8. DoD
  - [ ] 8.1 Rà soát Setup Impact Registry `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi kết quả (dự kiến `n/a`) (Req 7.4)
  - [ ] 8.2 Chạy checklist `.kiro/steering/definition-of-done.md`; `pnpm typecheck` + `pnpm -F @lumibase/cms test` xanh
