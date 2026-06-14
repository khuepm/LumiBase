# Setup Impact Registry

> **Đây là nơi duy nhất (single source of truth) theo dõi việc admin setup có theo kịp các tính năng mới hay không.**
>
> Mọi feature spec mới (trong `.kiro/specs/<feature>/`) khi hoàn thành PHẢI rà soát mục "Cách dùng registry" bên dưới và thêm dòng vào bảng nếu feature có yêu cầu khởi tạo. Quy tắc này được ép qua DoD chung tại `.kiro/steering/definition-of-done.md` (mục "Setup impact").

## Cách dùng registry

Khi một feature mới (hoặc thay đổi lớn) được merge, trả lời các câu hỏi sau. Nếu BẤT KỲ câu nào là "có" → thêm một dòng vào bảng Registry, tạo task trong `tasks.md` của spec này (Phase G trở đi), và cập nhật `requirements.md`/`design.md` nếu hành vi setup thay đổi:

1. Feature có bảng/row cần **seed mặc định** khi instance khởi tạo không? (vd: role library, default settings row)
2. Feature có **feature flag / settings key** mà operator cần biết tồn tại để bật không?
3. Feature có **policy/grant mặc định** mà nên là dữ liệu trong DB thay vì fallback hardcode không?
4. Feature có cần **bước UI mới** trong Setup Wizard (Studio) không?
5. Feature có cần **capability flag** mới trong `GET /api/v1/setup/capabilities` không?
6. Instance **đã setup từ trước** có cần migration/backfill để có cùng trạng thái với instance setup mới không?

Sau khi cập nhật registry và spec, cập nhật docs tương ứng:
- `docs/en/agent-setup/prompt.md` (nếu hành vi setup thay đổi)
- `docs/en/api/hono-api-spec.md` (nếu endpoint `/api/v1/setup/*` thay đổi)
- CHANGELOG mục upgrade steps (nếu cần backfill)

## Registry

Trạng thái: `pending` (chưa làm) · `in-progress` · `done` (setup + backfill + docs xong) · `n/a` (đã xem xét, không cần)

| # | Feature spec | Phiên bản | Yêu cầu với setup | Trạng thái | Task | Ghi chú |
|---|--------------|-----------|-------------------|------------|------|---------|
| 1 | content-os | v0.5.0 | Seed agent role library (7 roles) trong setup transaction thay vì lazy `ensureSeeded()` khi `list()` | done | tasks.md G.1 | Done 2026-06-13: seed trong setup tx (bước 8b). Instance cũ: lazy `ensureSeeded()` vẫn là fallback — không cần backfill |
| 2 | content-os | v0.5.0 | Tạo row `contentOs` flags mặc định (all false) trong `settings` | done | tasks.md G.2 | Done 2026-06-13: insert trong setup tx (bước 8c). Instance cũ: row vắng vẫn đọc all-OFF — không cần backfill |
| 3 | content-os | v0.5.0 | Baseline autonomy grants kèm `evidence: { source: 'setup_bootstrap' }` | done | tasks.md G.3 | Done 2026-06-13: L1 (PROPOSE) cho mọi (role, capability) seed — L1 là mức duy nhất không bao giờ NÂNG quyền dangerous skill dùng chung capability (grant áp cho cả hai context safe/dangerous). CỐ Ý không backfill instance cũ (sẽ siết safe từ L2 xuống L1) |
| 4 | content-os | v0.5.0 | Seed default constitution draft khi setup | done | tasks.md G.4 | Done 2026-06-13: seed "Baseline Constitution v1" status `draft` (bước 9c) — draft không có tác động runtime; template `BASELINE_CONSTITUTION_TEMPLATE` (3 rules, tất cả `blocking: false` — report-only kể cả khi activate). Không cần bước UI wizard. Instance cũ: không backfill, operator tạo qua Mission Control |
| 5 | admin-setup-wizard | v0.4.x | Persist lockout policy vào `settings` (hiện chỉ nằm trong audit metadata) | done | tasks.md G.5 | Done 2026-06-13: chốt open-question-8 — row `login_security_policy` dưới site `__default__`; reader (`loadLockoutPolicyFromSettings`) lookup theo key bất kể siteId nên không prejudge multi-tenancy |
| 6 | ai-first-cms-engine | v0.3.x | Đã rà soát: `ai_approvals` không cần seed; HITL hoạt động không cần config setup | n/a | — | Rà soát 2026-06-13 |
| 7 | clickhouse-cdc | v0.4.x | Đã rà soát: CDC pipeline registry cấu hình qua env/API riêng, không thuộc setup wizard | n/a | — | Rà soát 2026-06-13 |
| 8 | content-os-ui | v0.5.x | Đã rà soát (gồm task 15 rollout switchboard + phase 3 tasks 16-20 agents/intent-lifecycle/planner/evaluate/promotion-check): UI-only trên endpoint + settings row sẵn có — không yêu cầu khởi tạo mới | n/a | — | Rà soát 2026-06-13 |
| 9 | studio-ops-ui | v0.5.x | Đã rà soát: UI-only trên `/materialize`, `/tm`, `/marketplace/publish` sẵn có — không seed, không flag, không bước wizard mới | n/a | — | Rà soát 2026-06-13 |
| 10 | admin-setup-wizard | v0.6.x | Seed RBAC role `Administrator` (`adminAccess=true`) và bind bootstrap admin qua `user_roles` trong setup transaction | done | — | Done 2026-06-14: bước 9a trong setup tx, `systemKey='administrator'` idempotent qua `roles_site_system_key_unique`. Trước fix, bootstrap user không có role nào → PermissionService resolve `admin=false` → mọi schema/items request 403 ("Failed to load collections"). Thoả requirements.md Req 3. **Cần backfill** instance đã setup trước v0.6.x — xem Lưu ý backfill |
| 11 | admin-setup-wizard | v0.6.x | Đã rà soát: Studio standalone (Cloudflare Pages) gọi `GET /setup/state` cross-origin. Fix là deploy/connectivity (`VITE_API_URL` + `CORS_ALLOWED_ORIGINS`), không seed/flag/policy/bước wizard/capability/backfill DB | n/a | — | Rà soát 2026-06-14: studio mặc định same-origin nên `fetchSetupState` fail trên studio.lumibase.dev → "Couldn't reach the server". Sửa bằng base URL build-time (`getApiBaseUrl`) + CORS; không có trạng thái khởi tạo trong DB |
| 12 | site-settings | v0.6.x | Mở rộng bảng `sites` (identity/branding/theme/customCss) + endpoint `GET/PATCH /api/v1/site` + Studio → Settings → Site. Setup ghi `displayTitle/siteUrl/defaultLanguage` thẳng vào `sites` (bước 8a) | done | — | Done 2026-06-14. (1) Không seed riêng: row `sites` đã do setup tạo, cột mới có default. (2) Không feature-flag. (4) Không bước UI wizard mới (config sau setup); setup chỉ persist identity sẵn thu thập vào `sites`. (6) Migration `0028_site_configuration` idempotent (`ADD COLUMN IF NOT EXISTS`), cột nullable/có default → instance cũ KHÔNG cần backfill; identity cũ vẫn đọc được từ key `project_configuration`. Per-user theme override là enhancement sau |
| 13 | admin-setup-wizard | v0.6.x | Đã rà soát: thêm field `loginStallMs` (Directus `LOGIN_STALL_TIME` parity, default 500ms) vào Lockout_Policy — stall response cho 2 nhánh `INVALID_CREDENTIALS` trong `/auth/login`. Không seed/flag/bước wizard/capability/backfill mới | n/a | — | Rà soát 2026-06-15. (1)(3) Không seed/row riêng: field sống trong policy, `parseLockoutPolicy` fill default 500ms, fallback `STANDARD_LOCKOUT_POLICY` cũng có 500ms. (2) Dùng settings key `login_security_policy` sẵn có (gap #5), không phải key mới. (4) CỐ Ý chưa thêm bước UI wizard — admin chỉnh qua security settings API; Studio form schema chỉ khai báo field optional để policy mang sẵn `loginStallMs` không bị strip khi round-trip. (5) Không capability mới. (6) KHÔNG cần backfill: instance cũ thiếu field → codec fill 500ms khi đọc; thiếu row → fallback preset. Bounds `[0, 5000]` ms, `0` = tắt |

## Lưu ý backfill

Các gap #1–#3 ảnh hưởng cả instance **đã setup** — fix không chỉ nằm trong setup wizard mà cần kèm migration/backfill idempotent (`onConflictDoNothing`) hoặc giữ lazy-init làm fallback song song.

Gap #10 ảnh hưởng instance **đã setup trước v0.6.x**: bootstrap admin của họ không có RBAC role nên sẽ bị 403 trên mọi schema/items request. Backfill idempotent cần: tạo role `Administrator` (`adminAccess=true`, `systemKey='administrator'`) cho mỗi site đã có bootstrap user, rồi insert `user_roles` cho user `is_bootstrap=true` (dùng `onConflictDoNothing` để an toàn khi chạy lại).
