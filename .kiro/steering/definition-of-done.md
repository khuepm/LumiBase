# LumiBase — Definition of Done (mọi feature)

Checklist bắt buộc trước khi đánh dấu một feature spec là hoàn thành. Áp dụng cho mọi spec trong `.kiro/specs/`.

## 1. Code & test

- [ ] `pnpm typecheck` pass toàn bộ workspace
- [ ] `pnpm test` pass; feature có unit test cho logic chính
- [ ] Tuân thủ non-negotiable rules trong `CLAUDE.md` (nanoid/uuidv7, `site_id`, runtime abstraction, HITL, response format)

## 2. Setup impact — BẮT BUỘC RÀ SOÁT

> Đây là bước hay bị bỏ sót nhất. Admin setup wizard đã từng tụt hậu nhiều phiên bản so với tính năng mới.

- [ ] Trả lời 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` (mục "Cách dùng registry")
- [ ] Nếu có yêu cầu khởi tạo: thêm dòng vào bảng Registry + task vào `admin-setup-wizard/tasks.md`
- [ ] Nếu không: vẫn thêm dòng `n/a` kèm ngày rà soát — để biết feature đã được xem xét, không phải bị quên
- [ ] Instance đã setup từ trước có cần backfill không? Nếu có → migration idempotent + upgrade note trong CHANGELOG

## 2b. Multi-tenant — BẮT BUỘC KIỂM TRA

> LumiBase đa tenant theo mặc định (non-negotiable rule #2). Một feature "chạy được" trên một site CHƯA chứng minh nó cô lập đúng giữa các tenant. Đây là nơi rò rỉ dữ liệu chéo và "dùng chung nhầm" hay lọt qua.

Với MỌI feature đụng tới dữ liệu, hàng đợi, cache, realtime, background job, file/asset, hoặc tài nguyên ngoài:

- [ ] **Phân loại tài nguyên**: ghi rõ cái gì **dùng chung toàn deployment** (vd: VAPID key, KEK env, SMTP transport) và cái gì **cô lập theo tenant** (mọi bảng có `site_id`, index search, DO/queue key, cache key). Tài nguyên dùng chung phải có lý do (định danh server, không phải dữ liệu tenant) — nếu là dữ liệu tenant thì PHẢI cô lập.
- [ ] **Mọi query mang `site_id`**: đọc/ghi/đếm/xoá đều `where(eq(table.siteId, siteId))`; bảng mới được thêm vào `rls-policies.sql` (`site_isolation`).
- [ ] **Khoá hạ tầng có tiền tố tenant**: cache key, search index name, Durable Object name, queue dedup key, lock key — đều chứa `siteId`. Không có khoá "trần" dùng chung giữa tenant.
- [ ] **Định danh/secret dùng chung không lộ dữ liệu tenant**: endpoint trả tài nguyên dùng chung (vd public key) phải tenant-agnostic; fan-out/gửi đi phải lọc theo `siteId`.
- [ ] **Two-site smoke test**: với site A và site B, thao tác trên A KHÔNG xuất hiện/ảnh hưởng B (list, count, realtime broadcast, notification, search, file). Ghi lại cách đã kiểm (test tự động ưu tiên; nếu thủ công thì nêu các bước).
- [ ] **Background/cron/queue context**: job chạy ngoài request vẫn resolve đúng `siteId` từ payload (không "rò" site của request gần nhất, không quét toàn bộ tenant ngoài ý muốn).
- [ ] **Tài liệu**: mục Multi-tenancy trong `docs/en/features/<feature>.md` nêu rõ shared-vs-isolated + cách verify (xem `push-notifications.md` làm mẫu).

## 3. Spec hygiene

- [ ] `requirements.md`, `design.md`, `tasks.md` của spec phản ánh đúng trạng thái cuối (task done được tick, quyết định mở được chốt hoặc ghi rõ TODO có owner)

## 4. Docs

- [ ] `docs/en/api/hono-api-spec.md` cập nhật nếu API thay đổi
- [ ] `docs/en/data-model.md` cập nhật nếu schema thay đổi
- [ ] `docs/en/agent-setup/prompt.md` cập nhật nếu hành vi setup/bootstrap thay đổi
- [ ] CHANGELOG có entry, kèm upgrade steps nếu cần backfill
- [ ] `README.md` cập nhật thông tin phiên bản mới ở mục **Release policy**: dòng `Current release`, ngày phát hành, lệnh `LUMIBASE_VERSION=...`, phạm vi migration (nếu có)
  - ⚠️ **Cập nhật vừa đủ — giữ di sản bản 0.5.0:** chỉ chỉnh số phiên bản / ngày / migration / điểm mới của bản hiện tại. KHÔNG viết lại narrative "Content OS" của 0.5.0, KHÔNG xoá mô tả các trụ cột đã ship ở 0.5.0 (intents/SLO, control loop reconciliation, trust ledger L0–L4, veto window, four-scope kill switch, tenant constitution, provenance-first revisions, multi-agent newsroom, Studio Mission Control). 0.5.0 là mốc nền — phiên bản mới bổ sung lên trên, không thay thế.
