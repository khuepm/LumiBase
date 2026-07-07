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

## 2c. Route-guard security — BẮT BUỘC khi thêm/đổi route hoặc middleware

> Các lỗ hổng đã từng xảy ra đều do "quên guard" chứ không do guard sai: refactor làm rơi `adminOnly` khỏi dynamic extension route, `/api/v1/agent` không nằm trong control-plane list, thiếu kiểm tra tenant membership sau `withAuth`. Xem `docs/en/security/route-guards.md`.

- [ ] **Surface mới dưới `/api/v1` được phân loại**: content plane / Studio plane (`STUDIO_ACCESS_PATH_PREFIXES`) / control plane (`CONTROL_PLANE_PATHS`). Control-plane prefix PHẢI vào guard list — `adminOnly` per-route chỉ là lớp trong, không thay thế backstop.
- [ ] **Không thêm path vào bypass/public list** (`withAuth`, `PUBLIC_AUTH_PATHS` của `site-membership`/`studio-access`) nếu không kèm test chứng minh handler an toàn khi `auth === undefined`.
- [ ] **Route thực thi code động hoặc mutate agent state** (extensions, agent harness, flows) → control-plane, admin-only trước khi handler chạy.
- [ ] **Service request-path ủy quyền cho ItemService (hoặc ghi trực tiếp bảng content)** PHẢI mang permission context của caller: dựng qua `itemServiceForRequest(c)` / `permissionServiceForRequest(c)`, KHÔNG `itemServiceForSystem` trên đường request. Ghi raw SQL vào `items` (batch update/delete) phải tự gate `canAccess(collection, action)` + áp `whereFor()` row-scope. Đây là class lỗi "quên carry RBAC context" (đã lặp: AI `updateItem`, MCP endpoint, dependents resolve) — khoá bằng behavioural test dạng `dependents-service-rbac.test.ts` (deny → throw trước khi query/mutate).
- [ ] Tripwire test `apps/cms/src/__tests__/security-guards.wiring.test.ts` vẫn pass; nếu tái cấu trúc guard thì cập nhật assertion CÙNG với behavioural test mới, không xoá.

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

## 6. DoD evolution — RÀ SOÁT chính checklist này

> Chính DoD này lớn lên từ sự cố: mục 2b sinh sau các lần rò rỉ tenant, mục 2c sau khi `/api/v1/agent` lọt khỏi control-plane list (CHANGELOG: *"Definition of Done gains section 2c"*). Bullet "service request-path ủy quyền ItemService" trong 2c thêm sau khi audit phát hiện `DependentsService` (resolve/preflight FK dependents) ghi/xoá bản ghi collection phụ mà KHÔNG mang permission context của caller — bất kỳ thành viên tenant nào cũng set_null/reassign/delete được dữ liệu ngoài quyền (cùng class với AI `updateItem` / MCP đã vá). Nhưng đến giờ việc "học từ bug → thêm hàng rào" vẫn **ngầm định** — phụ thuộc người review có nhớ hay không. Đúng cái class lỗi 2c cảnh báo: *quên, không phải sai*. Mục này biến nó thành bước bắt buộc.
>
> Hàng rào tốt nhất là **cơ giới hóa** (test/tripwire/lint/CI chặn), rồi mới tới **checklist** (con người rà). Ưu tiên cơ giới hóa; chỉ dùng checklist khi không thể chặn tự động.

- [ ] **Bug fix — chống tái diễn cả class:** bản vá này thuộc một *class lỗi* (không chỉ một chỗ)? Ví dụ: quên guard trên một route → còn route nào khác cùng dạng? sai cô lập `siteId` ở một query → factory/helper nào khác bỏ sót? Nếu là class → thêm **tripwire/test source-scan** khoá cả class (mẫu: `security-guards.wiring.test.ts`, `item-service-rbac-context.test.ts`), KHÔNG chỉ test đúng chỗ vừa sửa.
- [ ] **Feature — mở failure-mode/attack-surface mới?** feature này tạo một *loại* rủi ro mà chưa mục DoD nào phủ (bề mặt thực thi code động mới, kênh fan-out realtime mới, đường ghi ngoài request, nơi lưu secret mới, contract phá vỡ tương thích)? Nếu có và sẽ tái xuất ở feature sau → đề xuất **mục/checklist DoD mới**, đừng chỉ xử lý một lần cho feature này.
- [ ] **Cập nhật DoD ngay trong cùng PR:** nếu hai câu trên trả lời "có", sửa file này (thêm mục / thêm dòng checklist / thêm tripwire) **cùng PR** với fix/feature, kèm blockquote nêu sự cố hoặc rủi ro đã dẫn tới hàng rào — để mục mới tự giải thích vì sao tồn tại (như 2b/2c đang làm). Ghi vào CHANGELOG nếu DoD đổi.
- [ ] **Không cần đổi:** nếu class lỗi đã có hàng rào, hoặc rủi ro là một-lần không tái diễn → không đụng DoD; ghi một dòng lý do trong mô tả PR để biết đã cân nhắc, không phải bị quên.
