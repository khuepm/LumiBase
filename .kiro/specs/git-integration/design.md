# Design Document — Git Integration (GitHub / GitLab)

## Overview

Tài liệu thiết kế cho **Git Integration** trong LumiBase: kết nối một instance LumiBase production tới repository GitHub/GitLab theo từng site, theo dõi PR + CI, hiển thị & lưu log, tạo preview environment tự động, và đặt nền cho Config-as-Code + Earned autonomy. Tính năng được xây như một module tự chứa `apps/cms/src/modules/git-integration/` cộng một schema mới `packages/database/src/schema/git-integration.ts`, một trang Studio mới, và tái dùng tối đa hạ tầng sẵn có (webhook HMAC, mã hoá token, audit, intent/reconciler, autonomy, deployment lifecycle của CDC). Mọi requirement được trace tới component cụ thể (xem §2).

## Architecture

## 1. Tổng quan kiến trúc

Tính năng chia thành ba lớp: **Studio (React)** — UI kết nối repo, PR dashboard, log viewer; **CMS (Hono on CF Workers / Node)** — toàn bộ business logic, provider adapter, webhook verify, preview lifecycle; **Storage (Postgres + Drizzle + runtime blob/cache)** — persistence cho integration, PR/CI cache, webhook event, preview, provenance. Provider được trừu tượng hoá qua interface `GitProvider`; mọi I/O mạng/cache đi qua `c.get('runtime')`.

```
┌────────────────────────────── Browser ──────────────────────────────┐
│  Studio SPA  (apps/studio)                                          │
│  ┌────────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │ Settings →         │  │ PR Dashboard    │  │ CI Log Viewer   │   │
│  │ Integrations / Git │  │ (per integration)│  │ (per PR/run)    │   │
│  └─────────┬──────────┘  └────────┬────────┘  └────────┬────────┘   │
│            │ TanStack Query / SDK (X-Lumi-Site + Bearer)            │
└────────────┼─────────────────────┼────────────────────┼──────────── ┘
             ▼                     ▼                    ▼
┌──────────────────────────── CMS (Hono) ─────────────────────────────┐
│  logger → runtime → cors → tenant → auth → db → rls → routes        │
│                                                                     │
│  /api/v1/integrations/git/*            → GitIntegrationService      │
│  /api/v1/integrations/git/webhook/:provider (PUBLIC, signed)        │
│      → WebhookVerifier → Webhook_Event log → async processor       │
│                                                                     │
│  GitProvider (interface)  ── GitHubProvider / GitLabProvider       │
│  PreviewEnvManager  •  CiLogStore  •  ProvenanceService            │
│  GitOpsReconciler (→ content_intents/drifts)  •  git-sync agent    │
└─────────┬───────────────────────┬──────────────────┬────────────────┘
          ▼                       ▼                  ▼
   Postgres (Drizzle)     runtime.cache /      GitHub / GitLab API
   ───────────────────    runtime blob (logs)  (REST + App tokens)
   git_integrations · git_pull_requests
   git_ci_runs · git_webhook_events
   git_preview_envs · git_provenance
```

Ba luồng request chính:

**Luồng A — Kết nối repo:** Studio gọi `POST /api/v1/integrations/git` (hoặc OAuth `GET /authorize` → `GET /callback`). CMS lấy Installation_Token (App) hoặc nhận PAT/OAuth token, mã hoá token + sinh Webhook_Secret bằng `CryptoService`, lưu `git_integrations` (status `connected`), và đăng ký webhook ở provider (App tự đăng ký). Token KHÔNG bao giờ trả lại client.

**Luồng B — Webhook PR/CI vào:** Provider gửi `POST /api/v1/integrations/git/webhook/:provider`. `WebhookVerifier` xác minh chữ ký (GitHub HMAC-SHA256 / GitLab token) constant-time, phân giải `site_id`/`integrationId` theo repo+secret, ghi `git_webhook_events` (`processed=false`, idempotent theo delivery id), rồi processor bất đồng bộ cập nhật `git_pull_requests`/`git_ci_runs`, kích `PreviewEnvManager` và (tuỳ chọn) notifications/status check.

**Luồng C — Status check ngược & GitOps reconcile:** Khi PR mở/cập nhật, validation nội dung/schema chạy theo cấu hình site; kết quả post về provider qua `GitProvider.postCommitStatus` (`lumibase/content-validation`). Khi merge nhánh chính, `GitOpsReconciler` đọc file khai báo qua `getFileContents`, reconcile vào DB qua `content_intents`; sai khác tạo `content_drift` + `agent_goal`, agent `git-sync` xử lý theo Autonomy_Level (HITL cho `schema:write`/delete).

## 2. Tham chiếu requirements ↔ thiết kế (Traceability Matrix)

| Req | Tiêu đề ngắn | Section thiết kế chính |
|-----|--------------|------------------------|
| 1 | Kết nối repo theo tenant | §3 (`git_integrations`), §4 (CRUD), §6 (GitIntegrationService) |
| 2 | Xác thực App + PAT/OAuth | §4 (OAuth/callback), §6 (token lifecycle), §7 (encryption) |
| 3 | Trừu tượng GitProvider | §5 (interface + adapter) |
| 4 | Webhook verify | §4 (endpoint), §8 (WebhookVerifier, idempotency) |
| 5 | PR dashboard | §3 (`git_pull_requests`), §4 (list PR), §9 (Studio) |
| 6 | CI status & log viewer | §3 (`git_ci_runs`), §4 (CI/logs), §10 (CiLogStore), §9 (UI) |
| 7 | Status check ngược | §4 (validate), §6 (validation), §5 (`postCommitStatus`) |
| 8 | Preview environment | §3 (`git_preview_envs`), §11 (PreviewEnvManager) |
| 9 | Webhook event log & audit | §3 (`git_webhook_events`), §8 (log + replay), §12 (audit) |
| 10 | Provenance | §3 (`git_provenance`), §6 (ProvenanceService) |
| 11 | Notification & incident | §13 (notifications/incident) |
| 12 | GitOps & drift | §14 (GitOpsReconciler) |
| 13 | Agent `git-sync` L0–L4 | §15 (autonomy & HITL) |
| 14 | Multi-tenancy & RLS | §3 (site_id + RLS), §6 (scope) |
| 15 | Bảo mật token | §7 (encryption, rotation, mask), §12 (audit mask) |

## Components and Interfaces

## 3. Mô hình dữ liệu (Data Model)

Schema mới `packages/database/src/schema/git-integration.ts`. Mọi bảng dùng helper `id()` = `nanoid()`, có `site_id` references `sites.id` (`onDelete: 'cascade'`), `created_at`/`updated_at`. Drizzle phác thảo (tên cột là minh hoạ, chốt khi implement):

```typescript
// git_integrations — một kết nối repo theo site
export const gitIntegrations = pgTable('git_integrations', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),               // 'github' | 'gitlab'
  repoFullName: text('repo_full_name').notNull(),     // 'org/repo'
  displayName: text('display_name').notNull(),
  authMethod: text('auth_method').notNull(),          // 'app' | 'pat'
  installationId: text('installation_id'),            // App only
  encryptedToken: text('encrypted_token'),            // PAT/OAuth — CryptoService ciphertext
  encryptionKeyId: text('encryption_key_id'),         // ref encryption_keys.keyId
  webhookSecretEnc: text('webhook_secret_enc'),       // ciphertext
  status: text('status').default('disconnected').notNull(), // connected|error|disconnected
  statusReason: text('status_reason'),
  scopes: jsonb('scopes').default([]).notNull(),
  syncConfig: jsonb('sync_config').default({}).notNull(),    // validation/gitops/preview policy
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => ({
  siteRepoUnique: uniqueIndex('git_integrations_site_repo_unique')
    .on(t.siteId, t.provider, t.repoFullName),
}));

// git_pull_requests — cache PR theo integration
export const gitPullRequests = pgTable('git_pull_requests', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').notNull().references(() => gitIntegrations.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),                     // open|closed|merged
  ciStatus: text('ci_status').default('unknown').notNull(),
  mergeable: boolean('mergeable'),
  headSha: text('head_sha').notNull(),
  author: text('author'),
  previewUrl: text('preview_url'),
  raw: jsonb('raw').default({}).notNull(),
  updatedAt: updatedAt(), createdAt: createdAt(),
}, (t) => ({
  integrationNumberUnique: uniqueIndex('git_prs_integration_number_unique')
    .on(t.integrationId, t.number),
  siteStateIdx: index('git_prs_site_state_idx').on(t.siteId, t.state),
}));

// git_ci_runs — run + job + tham chiếu log
export const gitCiRuns = pgTable('git_ci_runs', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').notNull().references(() => gitIntegrations.id, { onDelete: 'cascade' }),
  prId: text('pr_id').references(() => gitPullRequests.id, { onDelete: 'cascade' }),
  providerRunId: text('provider_run_id').notNull(),
  status: text('status').notNull(),                   // queued|in_progress|success|failure|cancelled
  jobs: jsonb('jobs').default([]).notNull(),          // [{ name, status, startedAt, completedAt, durationMs }]
  durationMs: integer('duration_ms'),
  logRef: text('log_ref'),                            // runtime blob key (lưu log)
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => ({
  integrationRunUnique: uniqueIndex('git_ci_runs_integration_run_unique')
    .on(t.integrationId, t.providerRunId),
}));

// git_webhook_events — nhật ký sự kiện thô (replay-able)
export const gitWebhookEvents = pgTable('git_webhook_events', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').references(() => gitIntegrations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  deliveryId: text('delivery_id'),                    // idempotency key từ provider
  event: text('event').notNull(),
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false).notNull(),
  processedAt: timestamp('processed_at'),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => ({
  deliveryUnique: uniqueIndex('git_webhook_delivery_unique').on(t.provider, t.deliveryId),
  siteProcessedIdx: index('git_webhook_site_processed_idx').on(t.siteId, t.processed),
}));

// git_preview_envs — ephemeral site theo PR
export const gitPreviewEnvs = pgTable('git_preview_envs', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').notNull().references(() => gitIntegrations.id, { onDelete: 'cascade' }),
  prId: text('pr_id').notNull().references(() => gitPullRequests.id, { onDelete: 'cascade' }),
  ephemeralSiteId: text('ephemeral_site_id').notNull(),
  status: text('status').default('pending').notNull(), // pending|ready|updating|destroyed|error
  url: text('url'),
  expiresAt: timestamp('expires_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => ({
  prUnique: uniqueIndex('git_preview_pr_unique').on(t.prId),
}));

// git_provenance — liên kết commit/PR ↔ content/schema
export const gitProvenance = pgTable('git_provenance', {
  id: id(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').references(() => gitIntegrations.id, { onDelete: 'cascade' }),
  commitSha: text('commit_sha').notNull(),
  prNumber: integer('pr_number'),
  collection: text('collection'),
  itemId: text('item_id'),
  changeType: text('change_type').notNull(),          // content|schema|intent
  createdAt: createdAt(),
}, (t) => ({
  siteItemIdx: index('git_provenance_site_item_idx').on(t.siteId, t.collection, t.itemId),
}));
```

**Mã hoá:** token + Webhook_Secret mã hoá qua `CryptoService` (`apps/cms/src/services/crypto-service.ts`) + `encryption_keys` (`schema/regulated.ts`), AAD gắn `{ siteId, integrationId }`. Tham chiếu thêm `modules/cdc/registry/encryption.ts` cho biến thể AES-GCM độc lập nếu cần.

**RLS:** thêm tất cả bảng mới vào `rls-policies.sql` để cách ly tenant ở tầng DB. Đăng ký export ở `packages/database/src/schema/index.ts`.

## 4. API Contracts

Mount dưới sub-app `api` (đã có chuỗi middleware tenant/auth/db/rls), prefix `/api/v1/integrations/git`. Response theo `{ data, meta? }` / `{ errors: [{ code, message? }] }`.

- `GET    /integrations/git` — list integration của site.
- `POST   /integrations/git` — tạo integration (PAT/manual) hoặc khởi tạo App connect.
- `GET    /integrations/git/oauth/:provider/authorize` — redirect tới provider OAuth.
- `GET    /integrations/git/oauth/:provider/callback` — nhận code, đổi token, lưu mã hoá.
- `GET    /integrations/git/:id` · `PATCH /integrations/git/:id` · `DELETE /integrations/git/:id`.
- `POST   /integrations/git/:id/rotate-secret` — xoay Webhook_Secret/token.
- `GET    /integrations/git/:id/pull-requests` — list PR (paginated).
- `POST   /integrations/git/:id/pull-requests/refresh` — refresh thủ công từ provider.
- `GET    /integrations/git/:id/pull-requests/:number/ci` — timeline CI.
- `GET    /integrations/git/:id/ci-runs/:runId/logs` — log (kéo + lưu).
- `POST   /integrations/git/:id/pull-requests/:number/validate` — chạy validation + post status.
- `POST   /integrations/git/webhook/:provider` — **PUBLIC**, signed; không qua auth thường.

## 5. Provider abstraction (GitProvider)

`apps/cms/src/modules/git-integration/providers/types.ts` định nghĩa:

```typescript
export interface GitProvider {
  listPullRequests(repo: RepoRef, opts?: ListOpts): Promise<PullRequest[]>;
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequest>;
  listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRun[]>;
  getCiRun(repo: RepoRef, runId: string): Promise<CiRun>;
  getJobLogs(repo: RepoRef, runId: string, jobId?: string): Promise<string>;
  postCommitStatus(repo: RepoRef, sha: string, status: CommitStatus): Promise<void>;
  getFileContents(repo: RepoRef, path: string, ref?: string): Promise<string | null>;
  verifyWebhook(req: WebhookVerifyInput): Promise<WebhookVerifyResult>;
}
```

Adapter `github.ts` và `gitlab.ts` cài đặt cùng hợp đồng; tạo qua factory `getProvider(integration)` resolve theo `provider` + `authMethod` (App token refresh vs PAT). Mọi I/O dùng `runtime.fetch`/`runtime.cache`. Phương thức không hỗ trợ → ném lỗi mã `PROVIDER_UNSUPPORTED`.

## 6. Backend (CMS) — module layout

```
apps/cms/src/modules/git-integration/
  providers/  types.ts · github.ts · gitlab.ts · factory.ts
  webhook/    verify.ts · handler.ts · processor.ts
  service.ts          ← GitIntegrationService (CRUD, scope site, token lifecycle)
  preview.ts          ← PreviewEnvManager
  ci-log-store.ts     ← CiLogStore (kéo + lưu blob qua runtime)
  provenance.ts       ← ProvenanceService
  gitops.ts           ← GitOpsReconciler
  routes.ts           ← API mỏng, delegate service
  __tests__/
```

`GitIntegrationService` luôn nhận `siteId` từ context và lọc mọi query theo site. Validation nội dung/schema (Req 7) tái dùng các Zod schema ở `packages/shared/src/schemas` và service hiện có.

## 7. Bảo mật token & mã hoá

- Token/secret mã hoá at-rest (`CryptoService`), AAD `{ siteId, integrationId }`; giải mã thất bại → lỗi rõ ràng, không fallback im lặng.
- Rotation: `rotate-secret` ghi ciphertext mới, giữ liên tục; App token tự refresh.
- Mask: mọi log/audit dùng masking (`modules/audit/path-mask.ts`), không bao giờ in token.
- Least-privilege: chỉ xin scope đọc PR/CI + ghi commit status; hiển thị scope đã cấp trong UI.
- `validateProductionConfig` kiểm khoá mã hoá khả dụng; thiếu → integration `error`, không lưu plaintext.

## 8. Webhook verify & event log

- Tái dùng pattern HMAC-SHA256 (Web Crypto, constant-time compare) ở `apps/cms/src/modules/notifications/webhook-channel.ts`.
- GitHub: verify `X-Hub-Signature-256` = `sha256=<hmac(secret, body)>`. GitLab: so khớp `X-Gitlab-Token` constant-time.
- Idempotency: unique `(provider, delivery_id)`; sự kiện trùng → bỏ qua.
- Lưu `git_webhook_events` trước, xử lý async (processor) → cập nhật PR/CI, preview, notify. Lỗi xử lý ghi `error`, cho phép replay idempotent.

## 9. Frontend (Studio)

- Trang mới `apps/studio/src/modules/settings/git-integrations-page.tsx`, model theo `webhooks-page.tsx` (list + modal create/edit + delete, `useQuery`/`useMutation`, hỗ trợ Cmd/Ctrl+S).
- Nút **Authorize** mở OAuth/App connect; hiển thị trạng thái kết nối + scope.
- PR dashboard component: list PR với CI badge, link provider + Preview_Env.
- CI log viewer: timeline job + log có highlight lỗi.
- Đăng ký route trong `apps/studio/src/router.tsx` (`settings/integrations/git`, lazy-load, `withSuspense`) và thêm mục nav nhóm "Integrations" trong `apps/studio/src/modules/settings/layout.tsx`.
- Data fetching qua SDK client (`apps/studio/src/lib/api.ts`) tự gắn `X-Lumi-Site` + Bearer.

## 10. CI Log Store

`CiLogStore` kéo log qua `GitProvider.getJobLogs`, nén và lưu vào runtime blob (hoặc bảng nếu nhỏ), ghi `git_ci_runs.logRef`. Đọc lại ưu tiên blob đã lưu; nếu chưa có thì kéo từ provider rồi lưu. Provider lỗi/token hết hạn → trả mã lỗi, giữ dữ liệu cũ.

## 11. Preview environment

`PreviewEnvManager` tham chiếu pattern lifecycle/rollback của CDC (`schema/cdc.ts` `cdcDeployments.steps`, `modules/cdc/ai-flow/deployment-orchestrator.ts`, `rollback-manager.ts`):

- PR mở → tạo ephemeral `site_id` phái sinh (branch-scoped), seed nội dung, lưu `git_preview_envs` (`status` pending→ready), set `previewUrl`, gắn vào PR và (tuỳ chọn) post deployment status/comment.
- PR push → `status=updating`, cập nhật nội dung head mới.
- PR đóng/merge → `status=destroyed`, giải phóng ephemeral site + blob, idempotent.
- `expiresAt`: env quá hạn mà PR còn mở → refresh hoặc dọn theo policy. Dữ liệu preview cách ly hoàn toàn với production của site gốc.

## 12. Audit & masking

Ghi audit cho connect/disconnect, post status, tạo/huỷ preview, rotate secret qua `modules/audit/logger.ts`; mọi giá trị nhạy cảm mask qua `path-mask.ts`. ID audit dùng `uuidv7()`.

## 13. Notification & incident

CI `failure` → `modules/notifications` (email/webhook channel) theo cấu hình site, tôn trọng suppression/consent. Bất thường lặp lại → tạo `agent_incident` (`schema/content-os.ts`) để hệ autonomy ghi nhận. Notification không chứa token/secret.

## 14. GitOps & Drift

`GitOpsReconciler` đọc file khai báo (YAML/JSON) qua `getFileContents`, map sang `content_intents` (`schema/content-os.ts`), reconcile vào DB theo pipeline reconciler hiện có. Sai khác → `content_drifts` + `agent_goal`. Mọi thao tác `schema:write`/delete đi qua HITL (`ai_approvals`).

## 15. Autonomy & HITL

Agent role `git-sync` (đăng ký trong agent role library) với capability phân loại rủi ro (`git:read` safe, `git:write`/`schema:write` dangerous). Autonomy điều khiển qua `agent_autonomy_grants` (L0 shadow → L4 autopilot) và `AutonomyService` (`apps/cms/src/services/autonomy-service.ts`). `ai-harness.ts` gate HITL: capability `schema:write` hoặc skill `delete*` → tạo `ai_approvals` trước khi thực thi bất kể mức. Veto/eval-fail/incident → hạ mức theo trust ledger.

## 16. Property-Based Testing

- **Webhook verify:** với mọi `(secret, body)`, chữ ký hợp lệ → accept; sửa 1 byte body/secret → reject (constant-time, không leak qua timing).
- **Idempotency:** replay cùng `delivery_id` N lần → không tạo trùng PR/CI/preview record.
- **Provider adapter contract:** GitHubProvider và GitLabProvider thoả cùng tập invariant (shape PullRequest/CiRun đồng nhất) qua bộ test dùng chung.
- **Preview lifecycle:** chuỗi event (open → push* → close) bất kỳ → đúng một preview sống tại một thời điểm; close → destroyed idempotent.
- **Tenant isolation:** mọi truy vấn với `siteId` ngẫu nhiên chỉ trả record cùng site.
- **Token round-trip:** `decrypt(encrypt(token)) === token`; sửa AAD/ciphertext → ném `DecryptionError`.
