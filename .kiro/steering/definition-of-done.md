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

## 3. Spec hygiene

- [ ] `requirements.md`, `design.md`, `tasks.md` của spec phản ánh đúng trạng thái cuối (task done được tick, quyết định mở được chốt hoặc ghi rõ TODO có owner)

## 4. Docs

- [ ] `docs/en/api/hono-api-spec.md` cập nhật nếu API thay đổi
- [ ] `docs/en/data-model.md` cập nhật nếu schema thay đổi
- [ ] `docs/en/agent-setup/prompt.md` cập nhật nếu hành vi setup/bootstrap thay đổi
- [ ] CHANGELOG có entry, kèm upgrade steps nếu cần backfill
- [ ] `README.md` cập nhật thông tin phiên bản mới ở mục **Release policy**: dòng `Current release`, ngày phát hành, lệnh `LUMIBASE_VERSION=...`, phạm vi migration (nếu có)
  - ⚠️ **Cập nhật vừa đủ — giữ di sản bản 0.5.0:** chỉ chỉnh số phiên bản / ngày / migration / điểm mới của bản hiện tại. KHÔNG viết lại narrative "Content OS" của 0.5.0, KHÔNG xoá mô tả các trụ cột đã ship ở 0.5.0 (intents/SLO, control loop reconciliation, trust ledger L0–L4, veto window, four-scope kill switch, tenant constitution, provenance-first revisions, multi-agent newsroom, Studio Mission Control). 0.5.0 là mốc nền — phiên bản mới bổ sung lên trên, không thay thế.

## 5. Tutorial impact — RÀ SOÁT khi đổi API/SDK/luồng setup

> Tutorial trong `docs/{en,vi}/tutorials/` được **pin theo version tối thiểu**, KHÔNG clone lại theo từng release. Mục tiêu: tránh phải viết lại tutorial mỗi bản nếu không có thay đổi thực sự (vd 0.9 → 0.15 mà các contract còn nguyên thì giữ y như cũ).

Với mỗi tutorial hiện có, rà mục **"Compatibility / Tương thích"** ở cuối file (liệt kê các contract nó phụ thuộc) và đối chiếu với feature của bạn:

- [ ] Feature này có **thay đổi/loại bỏ một contract** mà tutorial đang dựa vào không? (endpoint path, request/response shape, header `X-Lumi-Site`, default site id, query param `filter`/`sort`, chữ ký `@lumibase/sdk`, biến môi trường, lệnh CLI)
- [ ] **Nếu CÓ:** cập nhật **đúng tutorial bị ảnh hưởng** — sửa contract + bump bảng version (thêm dòng `phiên-bản-mới → latest` ở **trên cùng**, hạ dòng cũ xuống), cập nhật comment `verified_on` (và `applies_to_min` nếu là breaking), rồi verify lại bằng tay. KHÔNG tạo bản sao tutorial mới theo version.
- [ ] **Nếu KHÔNG:** không cần đụng tutorial — contract giữ nguyên thì badge version tối thiểu vẫn đúng cho bản mới.
- [ ] Tính năng đủ lớn cần hướng dẫn tận tay (frontend mới, luồng auth mới, SDK surface mới) → cân nhắc **thêm tutorial mới** vào `docs/{en,vi}/tutorials/`, đăng ký vào `apps/docs/docs.config.json` (sidebar + navbar) và link từ `docs/{en,vi}/README.md`.
