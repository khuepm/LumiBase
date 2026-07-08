# Setup Impact — git-integration

> Rà soát theo `.kiro/steering/definition-of-done.md` (mục "Setup impact"). Single source of truth của registry nằm ở `.kiro/specs/admin-setup-wizard/setup-impact.md`; file này ghi chi tiết phần trả lời 6 câu hỏi cho feature `git-integration` và đồng bộ một dòng vào registry chung.

## Trả lời 6 câu hỏi (cập nhật sau khi implement Phase A–F)

1. **Seed mặc định khi khởi tạo?** — KHÔNG. Các bảng `git_*` rỗng khi khởi tạo; integration tạo theo nhu cầu per-site (giống clickhouse-cdc #7 và firebase-sync #16). Agent role `git-sync` được thêm vào `ROLE_LIBRARY` và **seed lazily** qua `AgentRoleService.ensureSeeded()` (KHÔNG nằm trong setup transaction) → không cần seed lúc setup.
2. **Feature flag / settings key operator cần biết?** — KHÔNG có settings key DB mới. Preview là **opt-in per-integration** qua `git_integrations.sync_config.preview === true` (không phải settings global). Yêu cầu env **`ENCRYPTION_KEY`** (đã tồn tại) để quản lý token; OAuth/App qua env `GITHUB_*`/`GITLAB_*` (mới, tuỳ chọn — chỉ cần khi dùng OAuth/App). `LUMIBASE_PUBLIC_URL` (tuỳ chọn) cho webhook/preview URL.
3. **Policy/grant mặc định trong DB?** — Grant `git-sync` (L1 PROPOSE cho `items:write`) được seed **khi tạo integration đầu tiên** (`ensureGitSyncAutonomyBaseline`, idempotent, không override grant operator đặt) — KHÔNG trong setup transaction. Resolver fallback cũng L1 cho dangerous nên instance chưa có grant vẫn an toàn.
4. **Bước UI mới trong Setup Wizard?** — KHÔNG. Kết nối repo cấu hình sau setup ở Studio → Settings → Integrations → Git repositories (giống email #18, site-settings #12).
5. **Capability flag mới trong `GET /api/v1/setup/capabilities`?** — KHÔNG. Chưa thêm; UI dựa trên lỗi `ENCRYPTION_NOT_CONFIGURED`/`OAUTH_NOT_CONFIGURED` trả về từ API.
6. **Instance đã setup từ trước có cần backfill?** — KHÔNG. Migration `0007_git_integration` (bảng `lumibase_git_*` theo ADR-010) chỉ `CREATE TABLE IF NOT EXISTS` (additive, idempotent) + thêm bảng vào `rls-policies.sql`; instance cũ nhận bảng rỗng → no-op. Role/grant seed lazy/on-connect nên không cần backfill.

## Kết luận

Trạng thái: **in-progress** (Phase A–F đã implement; D–G phần còn lại + verify provider thật là follow-up). Setup impact: chủ yếu **n/a** — không seed/flag/wizard/capability/backfill lúc setup; chỉ có env tuỳ chọn (GITHUB_*/GITLAB_*/LUMIBASE_PUBLIC_URL) và grant `git-sync` seed on-connect. Đã cập nhật dòng Registry chung tại `.kiro/specs/admin-setup-wizard/setup-impact.md` (#30).
