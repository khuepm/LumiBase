# Implementation Plan

## Overview

Kế hoạch triển khai **Git Integration (GitHub / GitLab)** gồm 6 phase tuần tự (A→F) theo kiến trúc trong design.md. Phase A đặt nền (schema + provider abstraction + token encryption); Phase B làm kết nối & xác thực + UI Studio; Phase C làm webhook + PR/CI dashboard + log viewer; Phase D làm preview environment; Phase E làm status check ngược + provenance + notification; Phase F làm GitOps + autonomy. **MVP = Phase A–D.** Mỗi task gắn ref tới requirement và section thiết kế. Theo DoD, có thêm task Setup-impact và Docs.

## Tasks

### Phase A — Foundation (schema, provider abstraction, token encryption)

- [ ] 1. Schema + migration
  - [ ] 1.1 Tạo `packages/database/src/schema/git-integration.ts` với 6 bảng `git_integrations`, `git_pull_requests`, `git_ci_runs`, `git_webhook_events`, `git_preview_envs`, `git_provenance` (id `nanoid()`, `site_id` cascade, timestamps, unique/index như design §3); export từ `packages/database/src/schema/index.ts` (Req 1, 5, 6, 9, 10, 14; design §3)
  - [ ] 1.2 Sinh migration Drizzle (`pnpm -F @lumibase/database db:generate`); đảm bảo idempotent (`CREATE TABLE IF NOT EXISTS`) (Req 14.3; design §3)
  - [ ] 1.3 Thêm tất cả bảng mới vào `packages/database/src/schema/rls-policies.sql` để cách ly tenant tầng DB (Req 14.2; design §3)
  - [ ] 1.4 Thêm Zod schema chia sẻ ở `packages/shared/src/schemas` cho `GitIntegration`, `PullRequest`, `CiRun`, `WebhookEvent` (Req 3, 5; design §4)

- [ ] 2. Provider abstraction
  - [ ] 2.1 Định nghĩa interface `GitProvider` + types (`RepoRef`, `PullRequest`, `CheckRun`, `CiRun`, `CommitStatus`) ở `apps/cms/src/modules/git-integration/providers/types.ts` (Req 3.1; design §5)
  - [ ] 2.2 Cài đặt `GitHubProvider` (`providers/github.ts`) dùng `runtime.fetch`, App token refresh + PAT (Req 3.2, 3.5; design §5)
  - [ ] 2.3 Cài đặt `GitLabProvider` (`providers/gitlab.ts`) cùng hợp đồng (Req 3.2, 3.5; design §5)
  - [ ] 2.4 Factory `getProvider(integration)` resolve theo `provider`+`authMethod`; phương thức không hỗ trợ → mã `PROVIDER_UNSUPPORTED` (Req 3.3, 3.4; design §5)
  - [ ] 2.5 Test hợp đồng dùng chung cho cả hai adapter (cùng invariant shape) (Req 3.2; design §16)

- [ ] 3. Token encryption wiring
  - [ ] 3.1 Helper mã hoá/giải mã token + Webhook_Secret qua `CryptoService`, AAD `{ siteId, integrationId }` (Req 2.4, 15; design §7)
  - [ ] 3.2 Masking token/secret trong log/audit tái dùng `modules/audit/path-mask.ts` (Req 2.5, 15.2; design §7, §12)
  - [ ] 3.3 `validateProductionConfig` kiểm khoá mã hoá; thiếu → integration `error`, không lưu plaintext (Req 15.4; design §7)
  - [ ] 3.4 Property test token round-trip + AAD tamper (Req 15; design §16)

### Phase B — Connect & Auth + Studio UI

- [ ] 4. GitIntegrationService + routes CRUD
  - [ ] 4.1 `service.ts` (`GitIntegrationService`) với `create/list/get/update/delete`, luôn scope `site_id`; reject trùng `(site_id, provider, repo)` 409 (Req 1; design §6)
  - [ ] 4.2 `routes.ts` mount `/api/v1/integrations/git/*` trong sub-app `api` (tenant/auth/rls); response `{ data, meta? }`/`{ errors }` (Req 1, 14; design §4)
  - [ ] 4.3 OAuth flow `GET /oauth/:provider/authorize` + `GET /oauth/:provider/callback` đổi code→token, lưu mã hoá (Req 2.1, 2.3; design §4)
  - [ ] 4.4 App connect: lưu `installationId`, lấy/gia hạn Installation_Token (Req 2.1, 2.2; design §6)
  - [ ] 4.5 `POST /:id/rotate-secret` xoay Webhook_Secret/token, giữ liên tục (Req 15.1, 15.3; design §7)
  - [ ] 4.6 Audit connect/disconnect/rotate qua `modules/audit/logger.ts` (Req 9.2; design §12)
  - [ ] 4.7 Integration test CRUD + tenant isolation (Req 1.4, 14.1; design §16)

- [ ] 5. Studio settings page
  - [ ] 5.1 Tạo `apps/studio/src/modules/settings/git-integrations-page.tsx` (model theo `webhooks-page.tsx`): list + modal create/edit + delete, `useQuery`/`useMutation` (Req 1, 5; design §9)
  - [ ] 5.2 Nút Authorize (OAuth/App) + hiển thị trạng thái kết nối + scope đã cấp (Req 2.7; design §9)
  - [ ] 5.3 Đăng ký route `settings/integrations/git` trong `apps/studio/src/router.tsx` (lazy + `withSuspense`) + mục nav nhóm Integrations trong `modules/settings/layout.tsx` (design §9)
  - [ ] 5.4 i18n keys `locales/{en,vi}` cho trang mới (design §9)

### Phase C — Webhook & PR/CI dashboard + log viewer

- [ ] 6. Webhook ingest + verify
  - [ ] 6.1 `webhook/verify.ts` xác minh GitHub `X-Hub-Signature-256` (HMAC-SHA256, constant-time) + GitLab `X-Gitlab-Token` (tái dùng pattern `notifications/webhook-channel.ts`) (Req 4.2, 4.3, 4.4; design §8)
  - [ ] 6.2 `webhook/handler.ts` endpoint công khai `POST /webhook/:provider`: verify → phân giải `site_id`/`integrationId` theo repo+secret → ghi `git_webhook_events` (idempotent `(provider, delivery_id)`) (Req 4.1, 4.5, 4.7, 9.1; design §8)
  - [ ] 6.3 `webhook/processor.ts` xử lý async: cập nhật `git_pull_requests`/`git_ci_runs`; ghi `error` cho phép replay idempotent (Req 4.6, 9.3; design §8)
  - [ ] 6.4 Property test webhook verify + idempotency replay (Req 4.5; design §16)

- [ ] 7. PR dashboard
  - [ ] 7.1 `GET /:id/pull-requests` (paginated) + `POST /:id/pull-requests/refresh` kéo từ provider (Req 5.1, 5.3, 5.5; design §4)
  - [ ] 7.2 Studio PR list component: CI badge, link provider + Preview_Env (Req 5.4; design §9)

- [ ] 8. CI status & log viewer
  - [ ] 8.1 `GET /:id/pull-requests/:number/ci` timeline run/job (Req 6.1; design §4)
  - [ ] 8.2 `ci-log-store.ts` (`CiLogStore`) kéo log qua `getJobLogs`, lưu blob runtime, ghi `logRef`; đọc ưu tiên blob đã lưu (Req 6.2, 6.3, 6.5; design §10)
  - [ ] 8.3 `GET /:id/ci-runs/:runId/logs` trả log (Req 6.2; design §4)
  - [ ] 8.4 Studio log viewer: timeline job + highlight lỗi (Req 6.4; design §9)

### Phase D — Preview environments

- [ ] 9. PreviewEnvManager
  - [ ] 9.1 `preview.ts` tạo ephemeral `site_id` phái sinh (branch-scoped) khi PR mở; lưu `git_preview_envs` pending→ready; set `previewUrl` (Req 8.1; design §11)
  - [ ] 9.2 Cập nhật preview khi PR push (head mới) → `status=updating` (Req 8.2; design §11)
  - [ ] 9.3 Huỷ preview khi PR đóng/merge → `destroyed`, giải phóng tài nguyên, idempotent (Req 8.3; design §11)
  - [ ] 9.4 Gắn `previewUrl` vào PR + (tuỳ chọn) post comment/deployment status (Req 8.4; design §11)
  - [ ] 9.5 `expiresAt` + dọn dẹp theo policy; cách ly dữ liệu preview ↔ production (Req 8.5, 8.6; design §11)
  - [ ] 9.6 Property test preview lifecycle (đúng một preview sống; close idempotent) (Req 8; design §16)

### Phase E — Status check ngược + Provenance + Notification

- [ ] 10. Content/schema validation + status check ngược
  - [ ] 10.1 `POST /:id/pull-requests/:number/validate` chạy validation nội dung/schema theo cấu hình site (Req 7.1, 7.4; design §6)
  - [ ] 10.2 Post `lumibase/content-validation` về provider qua `postCommitStatus`; thiếu quyền → cảnh báo, không sập (Req 7.2, 7.3; design §5)

- [ ] 11. Provenance
  - [ ] 11.1 `provenance.ts` ghi liên kết `commitSha`/`prNumber` ↔ `itemId`/`collection` khi thay đổi bắt nguồn từ Git (Req 10.1; design §6)
  - [ ] 11.2 API truy vấn provenance theo item/collection (scope site) (Req 10.2, 10.3; design §4)

- [ ] 12. Notification & incident
  - [ ] 12.1 CI `failure` → notifications (`modules/notifications`) theo cấu hình site, tôn trọng suppression/consent (Req 11.1, 11.3; design §13)
  - [ ] 12.2 Bất thường lặp lại → tạo `agent_incident` (Req 11.2; design §13)

### Phase F — GitOps & Autonomy

- [ ] 13. GitOps reconcile + drift
  - [ ] 13.1 `gitops.ts` đọc file khai báo (YAML/JSON) qua `getFileContents`, map sang `content_intents` (Req 12.1, 12.2; design §14)
  - [ ] 13.2 Drift detection → tạo `content_drifts` + `agent_goal` theo reconciler hiện có (Req 12.3; design §14)
  - [ ] 13.3 Thao tác `schema:write`/delete qua HITL (`ai_approvals`) (Req 12.4, 13.3; design §15)

- [ ] 14. Agent role `git-sync` + autonomy
  - [ ] 14.1 Đăng ký role `git-sync` với capability phân loại rủi ro (`git:read` safe, `git:write`/`schema:write` dangerous) (Req 13.1; design §15)
  - [ ] 14.2 Autonomy L0–L4 qua `agent_autonomy_grants` + `AutonomyService`; hạ mức khi veto/incident (Req 13.2, 13.4; design §15)

### Phase G — Setup impact & Docs (DoD)

- [ ] 15. Setup impact
  - [ ] 15.1 Hoàn tất `.kiro/specs/git-integration/setup-impact.md` (6 câu hỏi) + thêm dòng Registry trong `.kiro/specs/admin-setup-wizard/setup-impact.md` (CLAUDE.md DoD)
  - [ ] 15.2 Nếu cần: capability flag `/api/v1/setup/capabilities`, settings key bật module, backfill migration idempotent cho instance cũ

- [ ] 16. Docs
  - [ ] 16.1 Cập nhật `docs/en/api/hono-api-spec.md` cho endpoint `/integrations/git/*`
  - [ ] 16.2 Cập nhật `docs/en/data-model.md` cho schema mới
  - [ ] 16.3 CHANGELOG entry + upgrade steps nếu cần backfill
  - [ ] 16.4 Cập nhật `docs/en/roadmap/git-integration.md` đánh dấu phase hoàn thành

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
