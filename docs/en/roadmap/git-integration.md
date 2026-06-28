# Git Integration Roadmap (GitHub / GitLab)

> **Scope:** Cho phép một instance LumiBase production kết nối tới repository GitHub/GitLab **theo từng site/tenant** — kết nối repo qua UI, theo dõi PR + CI, hiển thị & lưu log, tạo preview environment tự động, và đặt nền cho Config-as-Code + Earned autonomy.
>
> **Spec đầy đủ:** [`.kiro/specs/git-integration/`](../../../.kiro/specs/git-integration/) — `requirements.md` · `design.md` · `tasks.md` · `setup-impact.md`.

## Mục tiêu

1. **Kết nối repo per-tenant** — admin của một site kết nối một hoặc nhiều repo, xác thực qua **GitHub App / GitLab App** (installation token) hoặc **OAuth / PAT**.
2. **PR dashboard + CI log** — khi có PR/MR: hiển thị trạng thái, kết quả CI, reviewers, khả năng merge; kéo & lưu log CI để xem lại; đường dẫn tới trang preview.
3. **Preview environment tự tạo** — mỗi PR sinh một site preview tạm thời (ephemeral) ngay trong LumiBase, tự dọn khi PR đóng/merge.
4. **Config-as-Code & Earned autonomy** — đồng bộ schema/intent hai chiều với repo; agent `git-sync` thao tác theo mức autonomy được cấp (L0–L4) với HITL cho thao tác nguy hiểm.

## Nguyên tắc kiến trúc

- **Provider abstraction:** interface `GitProvider` chung; adapter `GitHubProvider` / `GitLabProvider`. Business logic không phụ thuộc provider cụ thể.
- **Tái dùng hạ tầng sẵn có:** webhook HMAC ([`modules/notifications/webhook-channel.ts`](../../../apps/cms/src/modules/notifications/webhook-channel.ts)), mã hoá token (`CryptoService` + `encryption_keys`), audit + masking, intent/reconciler (`content_intents`), autonomy (`AutonomyService`), deployment lifecycle của CDC cho preview.
- **Non-negotiable:** mọi bảng có `site_id` + RLS; ID `nanoid()`/`uuidv7()`; runtime abstraction; HITL cho `schema:write`/delete; response `{ data, meta? }` / `{ errors }`.

## Phase Breakdown

> Trạng thái: ⬜ chưa làm · 🟦 đang làm · ✅ xong. **MVP = Phase A–D.**

### Phase A — Foundation ⬜
- Schema `packages/database/src/schema/git-integration.ts` (6 bảng `git_*`) + migration + RLS.
- Interface `GitProvider` + adapter GitHub/GitLab + factory.
- Token encryption wiring (`CryptoService`, AAD `{ siteId, integrationId }`).

### Phase B — Connect & Auth ⬜
- `GitIntegrationService` + routes CRUD `/api/v1/integrations/git/*`.
- OAuth flow + App connect (installation token refresh) + rotate secret.
- Studio: trang **Settings → Integrations / Git** (model theo `webhooks-page.tsx`), nút Authorize, hiển thị scope.

### Phase C — Webhook & PR/CI ⬜
- Webhook endpoint công khai `POST /webhook/:provider` + verify chữ ký (GitHub HMAC-SHA256 / GitLab token) + idempotency.
- `git_webhook_events` log + async processor cập nhật PR/CI cache.
- PR dashboard + CI status & log viewer (kéo + lưu log, highlight lỗi).

### Phase D — Preview Environments ⬜
- `PreviewEnvManager`: tạo ephemeral site theo PR, cập nhật khi push, huỷ khi đóng/merge, `expiresAt`, cách ly dữ liệu.
- Gắn `previewUrl` vào PR + (tuỳ chọn) comment/deployment status.

### Phase E — Status Check ngược + Provenance + Notification ⬜
- Validation nội dung/schema trong PR → post `lumibase/content-validation` về provider.
- Provenance map `commit_sha`/`pr_number` ↔ `item_id`/`collection`.
- Notification khi CI fail; `agent_incident` khi bất thường lặp lại.

### Phase F — GitOps & Autonomy ⬜
- `GitOpsReconciler`: đọc file khai báo (YAML/JSON) → `content_intents`; drift → `content_drifts` + `agent_goal`.
- Agent role `git-sync` + autonomy L0–L4; HITL (`ai_approvals`) cho `schema:write`/delete.

## Kịch bản kết hợp với GitHub/GitLab log

Ngoài dashboard + log viewer cốt lõi, các kịch bản xoay quanh log/sự kiện Git:

- **CI run timeline per PR** — dựng timeline từng job (queued → in_progress → completed) kèm thời lượng; highlight dòng lỗi.
- **Log ingestion + lưu trữ** — kéo log về, lưu để xem lại kể cả khi provider đã xoá.
- **Log → audit trail** — mọi webhook ghi vào `git_webhook_events` + nối audit để truy vết "PR nào đổi content gì".
- **Status check ngược** — LumiBase validate rồi post check run kèm summary về provider.
- **Log-driven alerting / anomaly** — CI fail liên tục → notifications/incident; tái dùng `modules/anomaly` cho build-time bất thường.
- **Provenance map** — trả lời "commit này tác động field nào, ai merge".
- **Agent đọc log auto-fix** — autonomy L1+: agent đọc log fail, đề xuất PR sửa (gate HITL).
- **Unified activity feed** — trộn log Git (PR/commit/CI) + sự kiện CMS (publish/agent run) theo `site_id`.
- **Webhook replay** — log lưu payload thô → replay idempotent khi xử lý lỗi.

## Liên quan

- Setup impact: [`.kiro/specs/git-integration/setup-impact.md`](../../../.kiro/specs/git-integration/setup-impact.md) + registry chung trong `admin-setup-wizard/setup-impact.md` (#30).
- Definition of Done: [`.kiro/steering/definition-of-done.md`](../../../.kiro/steering/definition-of-done.md).
