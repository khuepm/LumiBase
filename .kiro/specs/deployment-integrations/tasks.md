# Implementation Plan — Deployment Integrations (Vercel / Netlify)

> Trace: mỗi task ghi requirement liên quan (Req n). Tuân non-negotiable rules `CLAUDE.md` (nanoid, siteId, runtime abstraction, HITL, response format, TS strict).
>
> **Trạng thái:** triển khai xong (2026-06-25). Recursive typecheck pass (15/15 packages); full CMS suite 1452 passed / 3 skipped; 32 unit test riêng cho deployment.

## Phase A — Data model & nền tảng

- [x] 1. Schema bảng mới (Req 1.1, 3.1, 9.1)
  - [x] 1.1 `packages/database/src/schema/deployments.ts`: `deploymentTargets`, `deployments` + index theo design §3.1/§3.2. IDs `nanoid()`, mọi bảng có `siteId`.
  - [x] 1.2 Export ở barrel `packages/database/src/schema/index.ts`.
  - [x] 1.3 Migration **viết tay** `0032_deployment_integrations.sql` (CREATE TABLE IF NOT EXISTS + FK/index idempotent) + journal entry idx 32 + RLS list.
  - [x] 1.4 Zod schemas `packages/shared/src/schemas/deployment.ts` (create/update target + trigger) + export ở index.

- [x] 2. Token vault (Req 1.2, 1.3)
  - [x] 2.1 `services/deployment/token-vault.ts`: `encryptToken`/`decryptToken` dùng `runtime.keys` (AES-GCM, WebCrypto subtle), tái dùng envelope codec — chạy CF Workers + Node.
  - [x] 2.2 Unit test round-trip + decrypt bằng retired key (rotation) + AAD mismatch + reject legacy.

## Phase B — Provider adapters

- [x] 3. Interface + registry (Req 1.4, 2, 3.2, 4, 7)
  - [x] 3.1 `providers/provider.ts`: `DeploymentProvider` + `registerProvider`/`getProvider` + `TERMINAL_STATUSES`.
  - [x] 3.2 Status mapping per Provider (design §3.3) + unit test (`mapVercelStatus`/`mapNetlifyStatus`).
- [x] 4. Vercel adapter (Req 2, 3, 4, 7) — `providers/vercel.ts` (REST v13 deployments, v9 project verify, v3 events log) qua `guardedFetch` (SSRF + timeout 30s).
- [x] 5. Netlify adapter (Req 2, 3, 4, 7) — `providers/netlify.ts` (site builds/deploys + log).

## Phase C — Service & API

- [x] 6. DeploymentService (Req 1, 2, 3, 4, 9)
  - [x] 6.1 `services/deployment/deployment-service.ts`: createTarget (verify+encrypt), trigger (decrypt→provider→insert), syncDeployment, fetchLogs, applyWebhookRef. Mọi query filter `siteId`.
  - [ ] 6.2 Rate-limit: hiện gate bằng `status='active'` + admin; rate-limit cứng theo target để TODO (Req 9.5) — chưa chặn lạm dụng nặng. **Open**.
  - [x] 6.3 Mask secret trong log/excerpt (`maskLog`, cap 16KB) (Req 4.4).
- [x] 7. Routes (Req 1.6, 2, 3.3, 4.1, 3.5) — `routes/deployments.ts` (admin router + inbound webhook router); đăng ký vào `index.ts` (`/api/v1/deployments`) + webhook mount public + `withTenant`/`withDb`.
- [x] 8. Audit (Req 2.4, 6.4) — `auditLog` cho target.created/updated/deleted + deploy.triggered (mask secret, never-throw).

## Phase D — Đồng bộ trạng thái

- [x] 9. Status poller (Req 3.4, 3.6, 9.4)
  - [x] 9.1 `services/deployment/status-poller.ts`: `DEPLOYMENT_POLL_QUEUE`, `registerStatusPoller` (queue.process), `sweepPending`/`sweepAllSites`; conditional UPDATE chỉ flip `queued|building` (idempotent); set `completedAt`; lỗi từng cái không vỡ sweep. Đăng ký cron 30s trong `serve.ts`.
  - [x] 9.2 Fallback `POST /:id/refresh` đồng bộ (Req 3.5).
  - [ ] 9.3 Idempotency được bảo đảm bằng `inArray(status, ['queued','building'])` guard; unit test idempotent end-to-end qua DB để TODO (cần Postgres). Pure-logic đã cover qua mapping + webhook tests. **Partial**.

## Phase E — Flows & AI Skills

- [x] 10. Flow operation (Req 5)
  - [x] 10.1 `registerHandler('deploy:trigger')` trong `flow-service.ts`, dùng `DeploymentService.trigger`; `db/siteId/keys/runId` từ `ctx.env` (flow run route truyền `runtime.keys` + `runId`). `triggerSource='auto'`.
  - [x] 10.2 `deploy:status` handler để flow phân nhánh.
  - [x] 10.3 Debounce/coalescing `coalesceWindowMs` (Req 5.4) — done 2026-07-06: `DeploymentService.trigger` nhận `coalesceWindowMs`; trigger không-manual trong cửa sổ tái dùng deployment gần nhất (không-error) thay vì build mới, audit `deployment.coalesced`. Deviation: cấu hình trên node `deploy:trigger` (options) thay vì cột target — không cần migration. Test: trigger-coalesce.test.ts (3)
  - [x] 10.4 Node trong palette Flow editor Studio — done 2026-07-06: palette giờ load từ `GET /flows/operations` (registry) nên `deploy:trigger`/`deploy:status` tự xuất hiện, kèm form config `targetId` + `coalesceWindowMs`
- [x] 11. AI Skills (Req 6)
  - [x] 11.1 4 skill trong cả `packages/ai-skills/src/skills.ts` (declarative, cho MCP/LLM tool-list) và `ai-harness.ts` `buildCoreSkills` (executable, wired `DeploymentService` qua `db/siteId/keys`).
  - [x] 11.2 `triggerDeployment` (`deployments:write`) → `ToolRegistryService.coreTool` phân loại `dangerous` → `before_execute` (HITL). `triggerSource='agent'`. Harness construction sites (ai.ts/mcp.ts/agent-run-worker) truyền `runtime.keys`.
  - [x] 11.3 Test risk classification (`deploy-skill-risk.test.ts`) + cập nhật property tests (risk/approval) để khớp rule mới.

## Phase F — Inbound webhook (tùy chọn)

- [x] 12. Inbound webhook (Req 7)
  - [x] 12.1 `POST /api/v1/deployments/webhook/:provider`: verify chữ ký (401 nếu sai) → parse → `applyWebhookRef` (match `providerDeploymentId`, idempotent với poller).
  - [x] 12.2 Test reject chữ ký sai + parse Vercel/Netlify event (`webhook-parse.test.ts`).
  - [ ] Lưu ý: `verifyWebhook` hiện là presence + secret guard (reject thiếu chữ ký). HMAC/JWS đầy đủ để TODO (design §4 ghi rõ). **Partial**.

## Phase G — Studio UI

- [x] 13. Deployments UI (Req 8) — gộp vào một trang Settings thay vì module riêng (đơn giản hơn, đúng pattern settings).
  - [x] 13.1 `modules/settings/deployments-page.tsx`: list targets + recent deployments table, badge trạng thái (lucide), "Deploy now", refresh/log.
  - [x] 13.2 Detail/log: `LogsDialog` (status, errorMessage, logExcerpt/full log).
  - [x] 13.3 `CreateTargetDialog`: connect target, token chỉ-ghi (password input, không hiển thị lại).
  - [x] 13.4 Poll nhẹ client (`refetchInterval` khi có deployment `building`).
  - [x] 13.5 Nav: thêm route (plain + admin-path) trong `router.tsx` + mục "Deployments" trong settings layout. SDK resource `client.deployments.*` trong `rest/legacy.ts` + types.

## Phase H — RBAC, Setup Impact & Definition of Done

- [x] 14. RBAC capability (Req 9.3, Setup Impact #3)
  - [x] 14.1 Capabilities `deployments:read`/`deployments:write` khai báo trên các AI skill. `triggerDeployment` `dangerous` → HITL.
  - [x] 14.2 KHÔNG cần migration cấp capability: role `administrator` (`adminAccess: true`) + `checkCapabilities` wildcard → admin tự có `deployments:*`.
- [x] 15. Setup Impact Registry (DoD §2) — thêm dòng #21 `deployment-integrations` (n/a: capability mới qua wildcard, migration bảng mới, không seed/backfill) vào `admin-setup-wizard/setup-impact.md`. Wizard không đổi → không task mới ở `admin-setup-wizard/tasks.md`.
- [x] 16. Docs (DoD §4)
  - [x] 16.1 `docs/en/api/hono-api-spec.md`: section 7b endpoints deployment.
  - [x] 16.2 `docs/en/data-model.md`: section 11c + bảng schema-file.
  - [x] 16.3 `docs/en/features/agent-harness-layer.md`: 4 skill + rule DANGEROUS cập nhật `deployments:write`.
  - [x] 16.4 CHANGELOG: entry `[Unreleased]` + upgrade note (migration 0032, capability qua wildcard).
- [x] 17. Verify (DoD §1)
  - [x] 17.1 `pnpm typecheck` recursive pass (15/15 packages).
  - [x] 17.2 `pnpm -F @lumibase/cms test`: 1452 passed / 3 skipped; 32 unit cho deployment; SDK 14 passed.
  - [x] 17.3 Non-negotiable rules đã rà (nanoid, siteId filter mọi query, runtime abstraction `c.get('runtime').keys`, HITL, response format, TS strict, không `any` lan).

## Việc còn mở (Open / TODO cho vòng sau)

- Rate-limit cứng theo target (Req 9.5 — 6.2).
- HMAC/JWS verify đầy đủ cho inbound webhook (12 — hiện presence guard).
- DB-integration test cho poller idempotency end-to-end (9.3 — cần Postgres).
- Xác nhận endpoint Vercel/Netlify API theo phiên bản tại thời điểm chạy thật (design §11 TODO).
