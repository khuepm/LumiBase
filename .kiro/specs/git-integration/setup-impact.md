# Setup Impact — git-integration

> Rà soát theo `.kiro/steering/definition-of-done.md` (mục "Setup impact"). Single source of truth của registry nằm ở `.kiro/specs/admin-setup-wizard/setup-impact.md`; file này ghi chi tiết phần trả lời 6 câu hỏi cho feature `git-integration` và đồng bộ một dòng vào registry chung.

## Trả lời 6 câu hỏi

1. **Seed mặc định khi khởi tạo?** — KHÔNG. Các bảng `git_*` rỗng khi khởi tạo; integration tạo theo nhu cầu per-site (giống clickhouse-cdc #7 và firebase-sync #16). Agent role `git-sync` (Phase F) thêm vào role library — nếu role library được seed trong setup transaction (xem content-os #1), cân nhắc thêm `git-sync` vào danh sách seed; nếu lazy `ensureSeeded()` thì không cần.
2. **Feature flag / settings key operator cần biết?** — CÓ (tuỳ chọn). Đề xuất settings key bật module integration ở mức site (mặc định OFF) hoặc env bật/tắt webhook endpoint công khai. Operator cần biết để bật. Chốt khi implement Phase B.
3. **Policy/grant mặc định trong DB?** — CÓ ở Phase F. `agent_autonomy_grants` cho `git-sync` nên seed ở mức an toàn nhất (L1 PROPOSE) như baseline của content-os #3, để write/`schema:write` luôn vào HITL khi chưa có grant cao hơn.
4. **Bước UI mới trong Setup Wizard?** — KHÔNG bắt buộc. Kết nối repo cấu hình sau setup ở Studio → Settings → Integrations / Git (giống email #18, site-settings #12). Không thêm bước wizard.
5. **Capability flag mới trong `GET /api/v1/setup/capabilities`?** — TUỲ CHỌN. Có thể thêm capability probe "git integration available" (kiểm khoá mã hoá + cấu hình App) để Studio ẩn/hiện UI. Chưa bắt buộc cho MVP.
6. **Instance đã setup từ trước có cần backfill?** — KHÔNG bắt buộc. Migration chỉ `CREATE TABLE IF NOT EXISTS` (additive, idempotent) + thêm bảng vào `rls-policies.sql`; instance cũ nhận bảng rỗng → no-op. Nếu Phase F seed `git-sync` autonomy grant trong setup tx, instance cũ dùng fallback resolver L1 (không cần backfill, giống #3).

## Kết luận

Trạng thái: **pending** (spec mới, chưa implement). Khi implement, cập nhật trạng thái và chốt câu 2/3/5 theo quyết định cuối. Đã thêm dòng vào registry chung tại `.kiro/specs/admin-setup-wizard/setup-impact.md`.
