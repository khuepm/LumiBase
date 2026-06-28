# Implementation Plan

## Overview

Kế hoạch triển khai **Git Integration (GitHub / GitLab)** gồm 6 phase tuần tự (A→F) theo kiến trúc trong design.md. Phase A đặt nền (schema + provider abstraction + token encryption); Phase B làm kết nối & xác thực + UI Studio; Phase C làm webhook + PR/CI dashboard + log viewer; Phase D làm preview environment; Phase E làm status check ngược + provenance + notification; Phase F làm GitOps + autonomy. **MVP = Phase A–D.** Mỗi task gắn ref tới requirement và section thiết kế. Theo DoD, có thêm task Setup-impact và Docs.

> **Trạng thái triển khai:** Phase **A–F đã hoàn thành** + **G (setup-impact, docs)** (module `apps/cms/src/modules/git-integration/`, schema + migration `0038`, Studio `Settings → Integrations → Git repositories`, unit tests). **Follow-up** (chưa làm): schema apply qua HITL harness (13.3), notification dispatcher đầy đủ (12.1), vòng lặp thực thi agent `git-sync` (14.3), auto-trigger GitOps khi merge `main`, YAML config. Luồng OAuth/webhook/preview với provider thật + apply migration cần verify trên môi trường có Postgres + GitHub/GitLab.

## Tasks

### Phase A — Foundation (schema, provider abstraction, token encryption)

- [x] 1. Schema + migration
  - [x] 1.1 Tạo `packages/database/src/schema/git-integration.ts` với 6 bảng `git_integrations`, `git_pull_requests`, `git_ci_runs`, `git_webhook_events`, `git_preview_envs`, `git_provenance` (id `nanoid()`, `site_id` cascade, timestamps, unique/index như design §3); export từ `packages/database/src/schema/index.ts` (Req 1, 5, 6, 9, 10, 14; design §3)
  - [x] 1.2 Sinh migration Drizzle (viết tay `0038_git_integration.sql`, idempotent `CREATE TABLE IF NOT EXISTS`) (Req 14.3; design §3)
  - [x] 1.3 Thêm tất cả bảng mới vào `packages/database/migrations/rls-policies.sql` để cách ly tenant tầng DB (Req 14.2; design §3)
  - [x] 1.4 Thêm Zod schema + resource types chia sẻ ở `packages/shared/src/schemas/git-integration.ts` (Req 3, 5; design §4)

- [x] 2. Provider abstraction
  - [x] 2.1 Định nghĩa interface `GitProvider` + types (`RepoRef`, `PullRequest`, `CheckRun`, `CiRun`, `CommitStatus`) ở `apps/cms/src/modules/git-integration/providers/types.ts` (Req 3.1; design §5)
  - [x] 2.2 Cài đặt `GitHubProvider` (`providers/github.ts`) + App token minting (`app-token.ts`) + PAT (Req 3.2, 3.5; design §5)
  - [x] 2.3 Cài đặt `GitLabProvider` (`providers/gitlab.ts`) cùng hợp đồng (Req 3.2, 3.5; design §5)
  - [x] 2.4 Factory `getProvider(integration, deps)` resolve theo `provider`+`authMethod`; phương thức không hỗ trợ → mã `PROVIDER_UNSUPPORTED` (Req 3.3, 3.4; design §5)
  - [x] 2.5 Test hợp đồng dùng chung cho cả hai adapter (cùng invariant shape) (Req 3.2; design §16)

- [x] 3. Token encryption wiring
  - [x] 3.1 Helper mã hoá/giải mã token + Webhook_Secret qua `CryptoService`, AAD `{ siteId, integrationId }` (`crypto.ts`) (Req 2.4, 15; design §7)
  - [x] 3.2 Masking token (`maskToken`); audit không ghi giá trị nhạy cảm (Req 2.5, 15.2; design §7, §12)
  - [ ] 3.3 `validateProductionConfig` kiểm khoá mã hoá; hiện routes trả `ENCRYPTION_NOT_CONFIGURED` khi thiếu `ENCRYPTION_KEY` (Req 15.4; design §7)
  - [x] 3.4 Property test token round-trip + AAD tamper (Req 15; design §16)

### Phase B — Connect & Auth + Studio UI

- [x] 4. GitIntegrationService + routes CRUD
  - [x] 4.1 `service.ts` (`GitIntegrationService`) với `create/list/get/update/delete`, luôn scope `site_id`; reject trùng `(site_id, provider, repo)` 409 (Req 1; design §6)
  - [x] 4.2 `routes.ts` mount `/api/v1/integrations/git/*` trong sub-app `api` (tenant/auth/rls) + `requireSiteAdmin`; response `{ data, meta? }`/`{ errors }` (Req 1, 14; design §4)
  - [x] 4.3 OAuth flow `GET /:id/oauth/authorize` (authenticated) + public `GET /oauth/:provider/callback` đổi code→token, lưu mã hoá (Req 2.1, 2.3; design §4)
  - [x] 4.4 App connect: lưu `installationId`, mint Installation_Token theo nhu cầu (Req 2.1, 2.2; design §6)
  - [x] 4.5 `POST /:id/rotate-secret` xoay Webhook_Secret, giữ liên tục (Req 15.1, 15.3; design §7)
  - [x] 4.6 Audit connect/disconnect/rotate qua `modules/audit/logger.ts` (Req 9.2; design §12)
  - [ ] 4.7 Integration test CRUD + tenant isolation (cần Postgres — verify trên staging) (Req 1.4, 14.1; design §16)

- [x] 5. Studio settings page
  - [x] 5.1 Tạo `apps/studio/src/modules/settings/git-integrations-page.tsx`: list + modal create + delete + PR drawer, `useQuery`/`useMutation` (Req 1, 5; design §9)
  - [x] 5.2 Nút Authorize (OAuth) + hiển thị trạng thái kết nối + webhook URL (Req 2.7; design §9)
  - [x] 5.3 Đăng ký route `settings/integrations/git` trong `apps/studio/src/router.tsx` (lazy + `withSuspense`, cả admin-path tree) + mục nav nhóm Integrations trong `modules/settings/layout.tsx` (design §9)
  - [x] 5.4 i18n qua `t('key','fallback')` (Studio nạp translations từ API, không có file locale tĩnh) (design §9)

### Phase C — Webhook & PR/CI dashboard + log viewer

- [x] 6. Webhook ingest + verify
  - [x] 6.1 `webhook/verify.ts` + `webhook/constant-time.ts` xác minh GitHub `X-Hub-Signature-256` (HMAC-SHA256, constant-time) + GitLab `X-Gitlab-Token` (tái dùng `hmacSha256Hex` của `notifications/webhook-channel.ts`) (Req 4.2, 4.3, 4.4; design §8)
  - [x] 6.2 `webhook/handler.ts` endpoint công khai `POST /webhook/:provider/:siteId/:integrationId`: scope RLS theo site → verify chữ ký → ghi `git_webhook_events` (idempotent `(provider, delivery_id)`) (Req 4.1, 4.5, 4.7, 9.1; design §8)
  - [x] 6.3 `webhook/processor.ts` cập nhật `git_pull_requests`/`git_ci_runs` (upsert idempotent); ghi `error` cho phép replay (Req 4.6, 9.3; design §8)
  - [x] 6.4 Unit test webhook verify (chữ ký hợp lệ/sai/constant-time); idempotency qua unique `(provider, delivery_id)` + `onConflictDoNothing` (Req 4.5; design §16)

- [x] 7. PR dashboard
  - [x] 7.1 `GET /:id/pull-requests` + `POST /:id/pull-requests/refresh` kéo từ provider (upsert cache) (Req 5.1, 5.3, 5.5; design §4)
  - [x] 7.2 Studio PR drawer: CI badge, link Preview_Env, nút xem log (Req 5.4; design §9)

- [x] 8. CI status & log viewer
  - [x] 8.1 `GET /:id/pull-requests/:number/ci` trả CI runs (Req 6.1; design §4)
  - [x] 8.2 `ci-log-store.ts` kéo log qua `getJobLogs`, lưu `runtime.storage` blob, ghi `logRef`; đọc ưu tiên blob đã lưu (Req 6.2, 6.3, 6.5; design §10)
  - [x] 8.3 `GET /:id/ci-runs/:runId/logs` trả log (Req 6.2; design §4)
  - [x] 8.4 Studio log viewer (pre/mono panel trong PR drawer) (Req 6.4; design §9)

### Phase D — Preview environments

- [x] 9. PreviewEnvManager
  - [x] 9.1 `preview.ts` tạo ephemeral `site_id` phái sinh (`${base}__pr-${n}`) khi PR mở; copy collections/fields/items/pages; lưu `git_preview_envs` pending→ready; set `previewUrl` (Req 8.1; design §11)
  - [x] 9.2 Cập nhật preview khi PR push (head mới) → `status=updating`, purge + copy lại (Req 8.2; design §11)
  - [x] 9.3 Huỷ preview khi PR đóng/merge → `destroyed`, cascade-delete ephemeral site, idempotent (Req 8.3; design §11)
  - [x] 9.4 Gắn `previewUrl` vào PR (phục vụ qua `/api/v1/deliver/page/:site_id/:slug`) (Req 8.4; design §11)
  - [x] 9.5 `expiresAt` + `cleanupExpired`; cách ly dữ liệu preview ↔ production (Req 8.5, 8.6; design §11)
  - [x] 9.6 Unit test `ephemeralSiteId` + `remapIds` (Req 8; design §16)

### Phase E — Status check ngược + Provenance + Notification

- [x] 10. Content/schema validation + status check ngược
  - [x] 10.1 `POST /:id/pull-requests/:number/validate` validate `lumibase/intents.json` ở PR head (Req 7.1, 7.4; design §6)
  - [x] 10.2 Post `lumibase/content-validation` về provider qua `postCommitStatus`; thiếu quyền → cảnh báo, không sập (Req 7.2, 7.3; design §5)

- [x] 11. Provenance
  - [x] 11.1 `provenance.ts` ghi liên kết `commitSha`/`prNumber` ↔ `itemId`/`collection` (changeType content/schema/intent) (Req 10.1; design §6)
  - [x] 11.2 `GET /:id/provenance?collection=&itemId=` (scope site) (Req 10.2, 10.3; design §4)

- [x] 12. Notification & incident
  - [x] 12.2 CI `failure` → `agent_incident` (role `git-sync`, không demote) + audit `git_ci_failed` (Req 11.2; design §13)
  - [ ] 12.1 Notification qua `modules/notifications` (dispatcher payload security-shaped) — **follow-up**; hiện dùng incident + audit (Req 11.1, 11.3; design §13)

### Phase F — GitOps & Autonomy

- [x] 13. GitOps reconcile + drift
  - [x] 13.1 `gitops.ts` đọc `lumibase/intents.json` (JSON) qua `getFileContents`, upsert `content_intents` qua `IntentService` (Req 12.1, 12.2; design §14)
  - [x] 13.2 Drift scan + reconcile (`DriftService.scanIntent` + `ReconcilerService.reconcileIntent` → `content_drifts` + `agent_goal`) (Req 12.3; design §14)
  - [ ] 13.3 Schema (collections/fields) apply qua HITL (`ai_approvals`) — **follow-up** (YAML config cũng follow-up; đợt này JSON intents) (Req 12.4, 13.3; design §15)

- [x] 14. Agent role `git-sync` + autonomy
  - [x] 14.1 Đăng ký role `git-sync` trong `ROLE_LIBRARY` (`items:read/write`, `schema:read`; goal vẫn planner-only) (Req 13.1; design §15)
  - [x] 14.2 Autonomy baseline L1 (`ensureGitSyncAutonomyBaseline`, seed on-connect) qua `AutonomyService.setGrant`; demote khi incident có capability (Req 13.2, 13.4; design §15)
  - [ ] 14.3 Vòng lặp thực thi agent `git-sync` qua harness — **follow-up**

### Phase G — Setup impact & Docs (DoD)

- [x] 15. Setup impact
  - [x] 15.1 Cập nhật `.kiro/specs/git-integration/setup-impact.md` (6 câu hỏi) + dòng Registry #30 trong `admin-setup-wizard/setup-impact.md` → `n/a` (CLAUDE.md DoD)
  - [x] 15.2 Không cần capability flag / settings key / backfill (migration additive; role/grant seed lazy/on-connect)

- [x] 16. Docs
  - [x] 16.1 `docs/en/api/hono-api-spec.md` §12c cho endpoint `/integrations/git/*`
  - [x] 16.2 `docs/en/data-model.md` §11c cho 6 bảng `git_*`
  - [x] 16.3 CHANGELOG entry (migration additive, no backfill)
  - [x] 16.4 `docs/en/roadmap/git-integration.md` đánh dấu phase A–F

## Task Dependency Graph

Mũi tên `A → B` nghĩa là task `B` phụ thuộc task `A` đã xong.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "depends_on": [] },
    { "wave": 2, "tasks": ["2", "3"], "depends_on": ["1"] },
    { "wave": 3, "tasks": ["4"], "depends_on": ["2", "3"] },
    { "wave": 4, "tasks": ["5", "6"], "depends_on": ["4"] },
    { "wave": 5, "tasks": ["7", "8"], "depends_on": ["6"] },
    { "wave": 6, "tasks": ["9"], "depends_on": ["7"] },
    { "wave": 7, "tasks": ["10", "11", "12"], "depends_on": ["7", "8"] },
    { "wave": 8, "tasks": ["13", "14"], "depends_on": ["10", "11"] },
    { "wave": 9, "tasks": ["15", "16"], "depends_on": ["9", "12", "14"] }
  ]
}
```
