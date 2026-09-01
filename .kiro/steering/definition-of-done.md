# LumiBase — Definition of Done (mọi feature)

Checklist bắt buộc trước khi đánh dấu một feature spec là hoàn thành. Áp dụng cho mọi spec trong `.kiro/specs/`.

> DoD này ở cấp **feature**. Điều kiện thoát cho một **release major** (v1.0.0 trở đi) nằm ở `v1-release-criteria.md` cùng thư mục — đó là nơi gom security audit, scope freeze, quality gate, upgrade-path và semver policy cho cả bản phát hành.

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
- [ ] **Số thứ tự dòng Registry là DUY NHẤT** — nay được **cơ giới hóa**: `pnpm registry:check` (`scripts/check-registry-numbering.mjs`) chặn trùng số trong CI (§6). Đừng chỉ lấy "số kế tiếp" — nhánh song song hay chọn trùng (đã xảy ra: hàng loạt dòng #20/#21/#22…/#38). Nếu check báo trùng, cấp số mới lớn hơn max hiện có; giữ số ở dòng được các dòng khác **trích dẫn theo số** để cross-reference không gãy.
- [ ] **Số migration không đụng `main`**: rebase/merge `main` trước, rồi `ls packages/database/drizzle/*.sql | tail` để lấy số kế tiếp thật. Migration sửa/thêm cột hay index PHẢI idempotent (`IF NOT EXISTS`/`duplicate_object` guard); nếu tạo **unique index/constraint** trên bảng có sẵn dữ liệu → ghi rõ điều kiện FAIL (vd dữ liệu trùng) + bước de-dup trong header migration **và** CHANGELOG (không phải mọi "thêm index" đều là backfill-free).

## 2b. Multi-tenant — BẮT BUỘC KIỂM TRA

> LumiBase đa tenant theo mặc định (non-negotiable rule #2). Một feature "chạy được" trên một site CHƯA chứng minh nó cô lập đúng giữa các tenant. Đây là nơi rò rỉ dữ liệu chéo và "dùng chung nhầm" hay lọt qua.

Với MỌI feature đụng tới dữ liệu, hàng đợi, cache, realtime, background job, file/asset, hoặc tài nguyên ngoài:

- [ ] **Phân loại tài nguyên**: ghi rõ cái gì **dùng chung toàn deployment** (vd: VAPID key, KEK env, SMTP transport) và cái gì **cô lập theo tenant** (mọi bảng có `site_id`, index search, DO/queue key, cache key). Tài nguyên dùng chung phải có lý do (định danh server, không phải dữ liệu tenant) — nếu là dữ liệu tenant thì PHẢI cô lập.
- [ ] **Mọi query mang `site_id`**: đọc/ghi/đếm/xoá đều `where(eq(table.siteId, siteId))`; bảng mới được thêm vào `rls-policies.sql` (`site_isolation`).
- [ ] **Khoá hạ tầng có tiền tố tenant**: cache key, search index name, Durable Object name, queue dedup key, lock key — đều chứa `siteId`. Không có khoá "trần" dùng chung giữa tenant.
- [ ] **Ghi dữ liệu được cache theo tag**: feature có đường ghi làm dữ liệu tenant được cache (theo tag hoặc version pointer) → PHẢI gọi `invalidateByTag` / `bumpVersion` / `forgetNegative` tương ứng sau commit **và** có test hành vi chứng minh entry cũ không còn được phục vụ (không chỉ unit test hàm invalidate).

  > Sinh sau sự cố high-load-cache-readiness: `PermissionService.invalidate()` là dead code — đổi quyền chỉ có hiệu lực sau TTL 60s; CDC `CacheInvalidator` viết nhưng không wire. Cơ giới hóa bằng integration test (vd `permission-cache-revocation.integration.test.ts`, Properties P6/P9) — test hành vi fail nếu ai tháo lời gọi bump/purge sau mutation.
- [ ] **Định danh/secret dùng chung không lộ dữ liệu tenant**: endpoint trả tài nguyên dùng chung (vd public key) phải tenant-agnostic; fan-out/gửi đi phải lọc theo `siteId`.
- [ ] **Two-site smoke test**: với site A và site B, thao tác trên A KHÔNG xuất hiện/ảnh hưởng B (list, count, realtime broadcast, notification, search, file). Ghi lại cách đã kiểm (test tự động ưu tiên; nếu thủ công thì nêu các bước).
- [ ] **Background/cron/queue context**: job chạy ngoài request vẫn resolve đúng `siteId` từ payload (không "rò" site của request gần nhất, không quét toàn bộ tenant ngoài ý muốn).
- [ ] **Parity runtime provider giữa request path và worker**: worker/cron/queue chạy **cùng service** với request path phải nhận **đủ** provider mà service đó cần (`keys`, `cache`, `search`, `queue`, `storage`) — deps của worker thiếu một provider thì cả một họ tính năng **fail closed âm thầm**, chỉ trên đường async. Đã xảy ra: `AgentRunWorkerDeps` không có `KeyProvider` ⇒ mọi deployment skill trả `DEPLOYMENTS_NOT_CONFIGURED` khi chạy qua queue (và hoá ra cả 4 call site `new AISecureHarness` đều thiếu). Cùng class "quên, không phải sai" như §2c — khoá bằng source-scan tripwire (mẫu: `apps/cms/src/__tests__/ai-harness-keys-context.test.ts`), đừng chỉ sửa call site vừa phát hiện.
- [ ] **Tài liệu**: mục Multi-tenancy trong `docs/en/features/<feature>.md` nêu rõ shared-vs-isolated + cách verify (xem `push-notifications.md` làm mẫu).

## 2c. Route-guard security — BẮT BUỘC khi thêm/đổi route hoặc middleware

> Các lỗ hổng đã từng xảy ra đều do "quên guard" chứ không do guard sai: refactor làm rơi `adminOnly` khỏi dynamic extension route, `/api/v1/agent` không nằm trong control-plane list, thiếu kiểm tra tenant membership sau `withAuth`. Xem `docs/en/security/route-guards.md`.

- [ ] **Surface mới dưới `/api/v1` được phân loại**: content plane / Studio plane (`STUDIO_ACCESS_PATH_PREFIXES`) / control plane (`CONTROL_PLANE_PATHS`). Control-plane prefix PHẢI vào guard list — `adminOnly` per-route chỉ là lớp trong, không thay thế backstop.
- [ ] **Không thêm path vào bypass/public list** (`withAuth`, `PUBLIC_AUTH_PATHS` của `site-membership`/`studio-access`) nếu không kèm test chứng minh handler an toàn khi `auth === undefined`.
- [ ] **Route thực thi code động hoặc mutate agent state** (extensions, agent harness, flows) → control-plane, admin-only trước khi handler chạy.
- [ ] **Service request-path ủy quyền cho ItemService (hoặc ghi trực tiếp bảng content)** PHẢI mang permission context của caller: dựng qua `itemServiceForRequest(c)` / `permissionServiceForRequest(c)`, KHÔNG `itemServiceForSystem` trên đường request. Ghi raw SQL vào `items` (batch update/delete) phải tự gate `canAccess(collection, action)` + áp `whereFor()` row-scope. Đây là class lỗi "quên carry RBAC context" (đã lặp: AI `updateItem`, MCP endpoint, dependents resolve) — khoá bằng behavioural test dạng `dependents-service-rbac.test.ts` (deny → throw trước khi query/mutate).
- [ ] Tripwire test `apps/cms/src/__tests__/security-guards.wiring.test.ts` vẫn pass; nếu tái cấu trúc guard thì cập nhật assertion CÙNG với behavioural test mới, không xoá.

## 2d. Desktop/mobile shell impact — RÀ SOÁT khi đổi Studio SPA hoặc auth/CORS

> `apps/shell` (Tauri 2) chỉ **bọc** Studio SPA, nên nó phụ thuộc một số **contract** của Studio/CMS. Một thay đổi ở nơi khác có thể làm **hỏng bản desktop/mobile mà KHÔNG hỏng bản trình duyệt** — đúng class "quên, không phải sai" mà 2c cảnh báo, chỉ khác là failure chỉ lộ khi chạy trong shell. Danh sách contract đầy đủ + hệ quả nằm ở bảng "Contracts future work must not break" trong `apps/shell/README.md`.

Với feature đụng tới auth/token, base URL API, build output của Studio, dev server, hoặc thêm endpoint mà SPA gọi:

- [ ] **Token**: mọi lưu/đọc session token đi qua `apps/studio/src/lib/token-store.ts` (hoặc accessor trong `api.ts`) — KHÔNG ghi thẳng `localStorage` (C1). Ghi thẳng sẽ bỏ qua OS keychain của shell.
- [ ] **API base**: luôn resolve qua `getApiBaseUrl()`; KHÔNG hardcode `/api` same-origin hay đọc `import.meta.env.VITE_API_URL` trực tiếp (C2).
- [ ] **Gọi API phải mang bearer**: mọi `fetch` tới `/api/v1/*` từ Studio đi qua `getApiClient()` hoặc tự kèm `Authorization: Bearer ${getActiveToken()}`. `withAuth` **chỉ** đọc header `authorization` — không có nhánh cookie — nên `credentials: 'same-origin'` một mình luôn trả **401**, và component test mock `fetch` sẽ không phát hiện. Đã xảy ra: trang Settings → Security của `user-totp-2fa` load 401 rồi rơi về `Status: Disabled` trong khi user thật đang bật 2FA — báo sai trạng thái bảo mật; cùng class còn `encryption-page.tsx`, `security-audit-tab.tsx`, `/api/v1/translations` (backlog B26). Kèm theo: query trạng thái bảo mật lỗi thì KHÔNG fallback sang giá trị nghe như chắc chắn — render lỗi tường minh.
- [ ] **Cross-origin auth/CORS**: luồng auth mới chạy được ở chế độ bundled (`tauri://localhost`) — hỗ trợ token-in-body chứ không chỉ cookie same-origin; endpoint mới SPA gọi phải CORS-reachable (C6). Đổi endpoint `/health` phải giữ public/no-auth (C7).
- [ ] **Build/dev contract**: đổi `build.outDir`/`base` (C3) hoặc port dev 2026 (C4) của Studio → cập nhật `apps/shell/src-tauri/tauri.conf.json` cùng lúc.
- [ ] **Webview compat**: API trình duyệt mới phải degrade gracefully trên WKWebView/WebView2/WebKitGTK (C5).
- [ ] **Không ảnh hưởng**: nếu feature không đụng các contract trên → không cần làm gì, nhưng câu hỏi phải được hỏi (ghi một dòng trong mô tả PR). `pnpm -F @lumibase/shell exec tauri` + workflow `shell-check.yml` (cargo check desktop + android) là hàng rào cơ giới một phần.


## 2e. Dependency & override hygiene — RÀ SOÁT khi bump version hoặc sửa `overrides`

> Sinh sau ca `vite`: `pnpm.overrides.vite` đứng ở `^7.3.5` trong khi `apps/studio` và `apps/docs` đều khai `^8.1.3`. Override của pnpm áp **cả cho direct dependency**, nên override thắng và lockfile importer ghi `specifier: ^7.3.5 → 7.3.6` — hai app build bằng Vite 7 suốt thời gian manifest tuyên bố Vite 8, và mọi phát biểu "đã lên Vite 8" trong khoảng đó đều sai. Không gate nào nói ra: `settings:check` chỉ so hai bản khai override với **nhau**, và chúng khớp nhau hoàn hảo — chúng chỉ cùng sai so với manifest. Cùng class "quên, không phải sai" như §2c, chỉ khác là failure nằm ở tầng resolution nên không thấy trong diff.

- [ ] **Bump một package đang có `overrides` → nâng override cùng lúc.** Override thắng manifest, nên chỉ sửa manifest là cú bump hình thức. Cơ giới hoá bằng `pnpm drift:check` (`scripts/check-override-drift.mjs`): fail khi range override không giao với range khai trực tiếp. Nếu nó nổ, sửa một trong hai bên — **đừng** làm nó im.
- [ ] **Sửa `overrides`/`patchedDependencies`/`auditConfig` → sửa ở CẢ HAI chỗ**: `package.json` (pnpm 9 đọc) và `pnpm-workspace.yaml` (pnpm 10+ đọc). Khoá bằng `pnpm settings:check`.
- [ ] **Verify "đã có hiệu lực" bằng lockfile, không bằng manifest.** Đọc `version:` ở importer của package liên quan trong `pnpm-lock.yaml`. Manifest chỉ nói ý định; lockfile nói thực tế.
- [ ] **Bump major đổi `exports` map (uuid 12+, các package ESM-hoá) → verify bằng build thật**, không chỉ typecheck. Resolution của bundler mới là chỗ vỡ, và `tsc` không thấy nó. Nhớ chọn đúng target: cùng một dependency có thể chỉ vào một trong hai bundle (uuid chỉ vào build Node vì `audit/worker.ts` không được đăng ký ở đường Cloudflare — xem B10).
- [ ] **Bump toolchain (vite/eslint/vitest/node) → đối chiếu `engines.node` của nó với `engines.node` của repo và `.nvmrc`.** Sàn khai báo phải thoả giao của mọi toolchain đang cài. Đã xảy ra: `>=22` nhận 22.0–22.12, dải làm vỡ cả vite 8 (`>=22.12.0`) và eslint 10 (`^22.13.0`).
- [ ] **Một thư viện test, một major.** Đừng để workspace mang hai major của cùng một thư viện test (đã xảy ra với `fast-check` 3/4 và `@testing-library/jest-dom` 6/7) — drift kiểu này chỉ càng đắt khi để lâu.
- [ ] **Peer thoả "tình cờ" không tính là thoả.** Nếu peer chỉ đúng vì lockfile happen-to-resolve một bản cao hơn range khai báo (ca `@dnd-kit/core ^6.1.0` với peer `^6.3.0` của sortable 10), nâng range khai báo lên. Một lần dedupe là vỡ.

## 3. Spec hygiene

- [ ] `requirements.md`, `design.md`, `tasks.md` của spec phản ánh đúng trạng thái cuối (task done được tick, quyết định mở được chốt hoặc ghi rõ TODO có owner)

## 4. Docs

- [ ] `docs/en/api/hono-api-spec.md` cập nhật nếu API thay đổi
- [ ] `docs/en/data-model.md` cập nhật nếu schema thay đổi
- [ ] `docs/en/agent-setup/prompt.md` cập nhật nếu hành vi setup/bootstrap / quy ước agent thay đổi (kèm bản VI — xem §4a)
- [ ] CHANGELOG có entry, kèm upgrade steps nếu cần backfill
- [ ] `README.md` cập nhật thông tin phiên bản mới ở mục **Release policy**: dòng `Current release`, ngày phát hành, lệnh `LUMIBASE_VERSION=...`, phạm vi migration (nếu có)
  - ⚠️ **Cập nhật vừa đủ — giữ di sản bản 0.5.0:** chỉ chỉnh số phiên bản / ngày / migration / điểm mới của bản hiện tại. KHÔNG viết lại narrative "Content OS" của 0.5.0, KHÔNG xoá mô tả các trụ cột đã ship ở 0.5.0 (intents/SLO, control loop reconciliation, trust ledger L0–L4, veto window, four-scope kill switch, tenant constitution, provenance-first revisions, multi-agent newsroom, Studio Mission Control). 0.5.0 là mốc nền — phiên bản mới bổ sung lên trên, không thay thế.

### 4a. Docs song ngữ (EN ↔ VI) — BẮT BUỘC khi đụng `docs/en/` hoặc `docs/vi/`

> Hàng rào này sinh vì dễ "sửa một locale rồi quên locale kia" — reviewer tưởng doc đã
> xong trong khi nửa kia vẫn cũ (cùng class *quên, không phải sai* như §2c).
>
> **Đã xảy ra hai lần, cả hai đều lọt tới `main`:** (1) `docs/vi/agent-setup/prompt.md`
> thiếu hoàn toàn quy tắc `withDeprecation` mà bản EN có từ 0.24.x — nghĩa là agent nào
> đọc bản VI cũng không biết luật đó, trên đúng file mà §4 xếp vào release surface;
> (2) một backlog **60 cặp** lệch tích lại tới 0.25.0, trong đó 3 cặp bản VI thực chất
> là tiếng Anh. Đóng backlog đó ở 0.26.0 mất một đợt dịch riêng. Rẻ hơn nhiều nếu mỗi
> PR tự giữ parity.
>
> Cơ giới hoá hiện có (chạy được nhưng **advisory**): `pnpm docs:i18n:detect` báo cặp
> lệch, `pnpm docs:i18n:parity` so cấu trúc, `pnpm docs:i18n:verify` so claim với code.
> Workflow `docs-i18n-sync.yml` gọi `check-parity` với `|| true` nên **không chặn CI** —
> vì vậy checklist dưới đây là hàng rào thật, đừng trông vào CI đỏ.
>
> **Tiêu chí thừa còn hơn thiếu:** phân vân file có cần sync → sync; phân vân có cần
> stamp → stamp.

Với **mọi** PR chạm file dưới `docs/en/` **hoặc** `docs/vi/` (kể cả agent-setup,
security audit, tutorial, API spec, feature guide):

- [ ] **Đồng thời cả hai locale trong cùng PR:** sửa `docs/en/<rel>` thì **phải** cập nhật
      `docs/vi/<rel>` (và ngược lại) trong **cùng commit/PR** — không để "VI follow-up
      sau". Nội dung tương đương 1-1: cùng mục, cùng ví dụ/code block, cùng claim kỹ
      thuật; chỉ khác ngôn ngữ prose.
- [ ] **Xác định chiều dịch bằng `detect`, đừng đoán:** một số cặp là **VI-source** với
      bản EN là bản dịch. Đọc `sourceLocale`/`targetLocale` trong
      `docs/.i18n/last-report.json`. Sửa sai chiều là ghi đè lên bản gốc do người viết.
- [ ] **Không sửa phía nguồn để làm parity xanh.** Nguồn là sự thật; chỉ sửa nguồn khi
      chính nó sai về mặt kỹ thuật — và khi đó tách thành thay đổi riêng, đừng gộp vào
      commit dịch.
- [ ] **Stamp lại provenance** sau khi nội dung khớp (đừng viết front matter tay):
      ```bash
      pnpm docs:i18n:verify                                            # claim vs source tree
      node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified    # bump cả hai locale
      pnpm docs:i18n:detect                                            # cặp phải up-to-date
      ```
      `--verified` từ chối stamp khi còn claim stale. File không có claim nào tool test
      được (`unverifiable`) → stamp **không** kèm `--verified` và ghi rõ đã review tay
      trong mô tả PR. `docs/.i18n/last-report.json` + `docs/i18n-sync-log.md` là artifact
      máy sinh **có git-track**: commit bản refresh là đúng, nhưng đừng sửa tay.
- [ ] **File mới chỉ có một locale:** tạo luôn counterpart ở locale kia trong cùng PR
      (dịch đủ), rồi stamp pair. Không merge doc "EN-only tạm" nếu path đó đã có cây
      `docs/vi/` (hoặc ngược lại).
- [ ] **Đừng dịch file có nguồn đang nằm trong PR chưa merge.** `sourceHash` lệch ngay khi
      PR kia vào `main`, cặp quay về `planned`, và verify + stamp phải làm lại từ đầu —
      dịch hai lần cho một kết quả (tiền lệ ghi ở `docs/.i18n/TASKS.md` §7.5).
- [ ] **Ngoại lệ hẹp (phải ghi lý do trong mô tả PR):** (a) file tooling/index cố ý không
      có pair (vd `docs/en/agent-setup/llms.txt` khi tree chưa có bản VI — thêm pair sau
      thì PR đó phải dịch đủ); (b) sửa thuần typo/whitespace không đổi nghĩa **vẫn** nên
      sync nếu counterpart tồn tại (thừa > thiếu); (c) artifact máy (`docs/.i18n/*`,
      `docs/i18n-sync-log.md`) không dịch.
- [ ] **Tutorial:** §5 vẫn áp dụng — sửa tutorial một locale thì locale kia + bump bảng
      Compatibility / comment version theo §5.

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

## 7. Out-of-scope findings — LOG lại, đừng bỏ sót

> Trong khi làm một PR, ta hay phát hiện lỗ hổng / bug / nợ kỹ thuật / feature
> **không thuộc scope** PR đó. Nếu chỉ nêu trong mô tả PR hay chat, chúng **biến
> mất sau khi merge**. Hàng rào: gom về một chỗ duy nhất
> `.kiro/steering/out-of-scope-backlog.md`.

- [ ] **Rà lại cả session, không chỉ diff:** có phát hiện điều gì thật (bug/lỗ hổng/nợ kỹ thuật/feature) **ngoài scope** PR này khi đọc code / chạy CI / điều tra không?
- [ ] **Nếu CÓ:** thêm một dòng vào `.kiro/steering/out-of-scope-backlog.md` **trong cùng PR** (ID, loại, khu vực, mô tả, mức độ, trạng thái, tham chiếu). Đủ lớn thành feature → tạo `.kiro/specs/<feature>/` và để trạng thái `tracked` trỏ tới spec. Fix luôn được trong PR → vẫn log một dòng `fixed` để giữ dấu vết.
- [ ] **Nếu KHÔNG:** không cần đụng backlog — nhưng câu hỏi phải được hỏi, không mặc định bỏ qua.
