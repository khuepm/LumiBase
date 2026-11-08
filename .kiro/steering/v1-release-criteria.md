# LumiBase — v1.0.0 Release Criteria (exit checklist)

> Khác với `definition-of-done.md` (áp cho **từng feature**), file này là điều kiện thoát cho **một release major**. v1.0.0 là lời cam kết public: API surface ổn định, semver được tôn trọng, upgrade path được bảo hành. Chưa tick đủ mục **BẮT BUỘC** thì chưa tag v1.0.0.
>
> Trạng thái khảo sát nền (2026-07-06, tại v0.18.0): security audit 66/78 CWE mitigated, 9 partial, 3 not addressed (`docs/en/security/cwe-top-100-audit.md`); CI có version-check/typecheck/test/build/lint nhưng **chưa có E2E gate và dependency-audit gate**; M2A relations còn reserved-not-implemented.

## Rà soát 2026-11-08 (tại `origin/main` `112bf50e`, sau `v1.0.0-rc.4`)

Mỗi ô dưới đây được đối chiếu lại với code, workflow và lịch sử CI tại commit trên, không dựa vào checkbox cũ. Ô đã tick có bằng chứng ngay sau nó. Ô **(at-tag)** chỉ kiểm được khi cắt bản cuối, không phải thiếu sót hiện tại.

**Còn chặn tag v1.0.0 (BẮT BUỘC, chưa xong):**

1. **§2 — 4 spec chưa phân loại** (`content-preview`, `dependency-upgrade-batch-2026-08`, `jev-content-decisions`, `nextjs-starter-contract`; 43 spec, `v1-scope-classification.md` mới phủ 39). Đề xuất ở §2, cần owner chốt.
2. **§2 — Quyết định surface Jev.** Endpoint `/api/v1/ai/decisions` và `/api/v1/ai/review-profiles*` đã có trong `hono-api-spec.md`, không gắn nhãn experimental, nên sẽ bị freeze ở 1.0.0, trong khi go/no-go với dữ liệu thật (#548) chưa chạy. Chọn một: (a) gắn nhãn experimental (ngoài semver theo `versioning-policy.md`), hoặc (b) chạy #548 trước khi tag.
3. **§2 — M2A Builder ở Studio.** Quan hệ M2A trả 501 và được tuyên bố reserved, nhưng Studio vẫn có interface `relation-m2a` ("Builder (M2A)", field `json`, `special: ['m2a']`, `apps/studio/src/modules/content/interfaces/catalogue.ts`). Cần nói rõ shape JSON của field này có thuộc public surface 1.0 hay không, hoặc ẩn interface khỏi bản 1.0.
4. **§1c — Chạy lại security review** trên diff `v0.18.0` → RC: không tìm thấy bản ghi nào.
5. **§4 — Test nâng cấp từ instance 0.x thật**: CI chỉ seed shape dữ liệu cũ lên schema mới nhất (backfill RBAC), chưa chạy migrate thật từ một bản 0.x đã cài.
6. **(at-tag)** §5: CHANGELOG `[1.0.0]`, docs khớp code tại tag, tutorials, i18n, tag đúng commit.

**Đã sửa trong lần rà này** (branch `docs/v1-readiness-audit-2026-11-08`): `docs/{en,vi}/operations/upgrades.md` thêm nguồn `0.26.x`/`1.0.0-rc.x`, preflight migration `0017` (có thể fail khi một goal có hai run đang chạy), ghi rõ `0013` bỏ `NOT NULL`, rollback không xuống dưới `0.26.0`. `pages-deploy.yml` hạ token về `contents: read` (Scorecard alert #160). `rustls` 0.23.41 → 0.23.46 trong `apps/shell/src-tauri/Cargo.lock` (Dependabot, `cargo check --locked` pass).

**Không chặn nhưng cần biết:** 99 alert Code Scanning đang mở đều đến từ OpenSSF Scorecard, không phải CodeQL (96 `PinnedDependencies`, `Vulnerabilities`, `CodeReview`, `CIIBestPractices`). Dependabot còn `zod` 3.x (high) trong hai example ngoài workspace (`examples/hono-webhook`, `examples/extension-email-setup`; bản vá là 4.6.6, tức nâng major), `minimatch` (medium), `glib` (medium, đi theo Tauri). Repo chưa có secret `TAURI_SIGNING_PRIVATE_KEY`, nên `release-apps.yml` (bản desktop) sẽ đỏ; không ảnh hưởng `release.yml`.

## 1. Security — BẮT BUỘC

Nguồn: `docs/en/security/cwe-top-100-audit.md`. Mỗi mục Partial/Not-addressed phải được **fix** hoặc **accept có chữ ký** (ghi lý do + owner vào bảng audit). Không được để trạng thái "chưa ai quyết".

### 1a. Phải fix trước v1.0 (rủi ro thật cho public deployment)

- [x] **CWE-400 — Rate limiting per-user/per-endpoint** cho REST/GraphQL. Hiện chỉ có auth/recovery (3/IP/h) + global backpressure. Đây là gap chính khi mở public.
  — 2026-11-08: `withRateLimit()` trong chuỗi `api.use('*', …)` (`apps/cms/src/index.ts:227`) và trên `/pageviews/:site_id/hit`; thêm `withAiIpRateLimit()`.
- [x] **CWE-362/367 — Race condition AI approval decide**: UPDATE phải kèm `WHERE status='pending'` + check affected-row count (`apps/cms/src/services/ai-harness.ts:2207–2258`).
  — 2026-11-08: guard `eq(aiApprovals.status, 'pending')` / `eq(agentApprovals.status, 'pending')` ở `ai-harness.ts:3394, 3549, 3675`.
- [x] **CWE-620/613 — Session & password lifecycle**: thêm change-password endpoint (yêu cầu current password); reset password phải invalidate token hiện hành. JWT 24h không revocation → tối thiểu có cơ chế revoke (session table hoặc token version).
  — 2026-11-08: `changePasswordSchema` trong `routes/auth.ts`; `tokenVersion` kiểm ở `middleware/auth.ts:464–477`.
- [x] **CWE-521 — Thống nhất password policy**: register đang `min(6)` (`apps/cms/src/routes/auth.ts:209`) trong khi setup/recovery là `min(12)` + complexity. Align về 12+.
  — 2026-11-08: dùng chung `PasswordSchema` từ `@lumibase/contracts/schemas`.
- [x] **CWE-302 — `X-Lumi-Site` header**: verify tenant membership ngay tại middleware (không defer xuống route layer); map role Cloudflare Access từ DB thay vì hardcode `['admin']` (`apps/cms/src/middleware/auth.ts:146`).
  — 2026-11-08: `withTenantExists()` trước `withAuth()`, `withSiteMembership()` ngay sau (`index.ts:227`).
- [x] **CWE-942 — CORS non-production**: bỏ wildcard-origin-with-credentials khi `CORS_ALLOWED_ORIGINS` unset (`apps/cms/src/config/cors.ts:11-34`) — staging chạy nhầm dev env là dính thật.
  — 2026-11-08: `config/cors.ts` loại `'*'` khỏi allowlist vì response luôn credentialed.

### 1b. Fix hoặc accept-with-rationale

- [x] **CWE-203 — User enumeration qua register** (`EMAIL_ALREADY_EXISTS`): đổi sang generic response + email thông báo, hoặc accept nếu deployment mặc định đóng register.
  — 2026-11-08: verdict ✅ trong bảng audit (dòng 203).
- [x] **CWE-321 — CDC fallback key trong code** (`apps/cms/src/modules/cdc/registry/encryption.ts:16`): production đã reject, nhưng cần bước ép `ENCRYPTION_KEY` trong setup wizard / deployment checklist.
  — 2026-11-08: không còn fallback; route CDC trả 503 `ENCRYPTION_KEY_MISSING` (bảng audit dòng 321).
- [x] **CWE-359 — PII trong audit metadata**: erasure route purge items nhưng không purge audit log → quyết định policy (redact-on-write hoặc erasure quét cả audit) trước khi cam kết GDPR ở v1.
  — 2026-07-16: "Accepted for v1.0" (redact-on-write, owner khuepm) trong bảng audit.
- [x] **CWE-1104 — Dependency hygiene**: bật renovate/dependabot + thêm `pnpm audit` (hoặc tương đương) vào CI. Đây vừa là security vừa là gate lâu dài (xem mục 3).
  — 2026-11-08: `.github/dependabot.yml`; `pnpm audit --prod --audit-level high` ở `ci.yml:443`.

### 1c. Chốt sổ

- [x] Bảng audit không còn dòng nào thiếu verdict: mọi ⚠️/❌ hoặc đã chuyển ✅, hoặc có dòng "Accepted for v1.0 — lý do, owner, ngày".
  — 2026-11-08: scorecard 78/78 mitigated, 0 partial, 0 not addressed.
- [ ] Chạy lại `/security-review` (hoặc tương đương) trên diff tổng từ v0.18.0 → release candidate.
  — 2026-11-08: chưa có bản ghi. Epic #577 (audit AI agent) phủ phần AI, không thay cho lượt này.

## 2. Scope freeze — BẮT BUỘC

- [ ] **Quyết định M2A relations**: hiện `schema-service.ts` trả "reserved but not implemented". Hoặc ship trong v1, hoặc tuyên bố chính thức out-of-scope trong docs + roadmap (một dòng "coming in 1.x", không để mập mờ). Reserved-surface không được đổi shape sau v1 nếu đã public.
  — 2026-11-08: quan hệ M2A đã chốt (501 `RELATION_TYPE_NOT_IMPLEMENTED`, ngoài public surface trong `docs/en/contributing/versioning-policy.md`). Còn mở: interface Studio "Builder (M2A)" (field `json`) vẫn lưu dữ liệu many-to-any; cần nói nó có thuộc surface hay ẩn đi.
- [ ] **Rà `.kiro/specs/`**: mọi spec đang partial hoặc mở phải được phân loại **in-v1 / post-v1** — spec in-v1 phải qua đủ DoD; spec post-v1 ghi rõ vào roadmap. Không dùng checkbox tasks.md làm bằng chứng — đối chiếu Implementation-status footer + code. → Kết quả: `.kiro/steering/v1-scope-classification.md` (2026-07-16).
  — 2026-11-08: 4 spec mới chưa có trong file phân loại. Đề xuất (cần owner chốt): `dependency-upgrade-batch-2026-08` → in-v1 hoàn tất (footer: "Hoàn tất 2026-08-21"); `content-preview` → post-v1 (0/33 task); `nextjs-starter-contract` → cần owner (chỉ có `design.md`; `examples/nextjs-blog` tồn tại); `jev-content-decisions` → phụ thuộc quyết định surface Jev ở phần rà soát đầu file.
- [x] **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) không còn feature in-v1 nào thiếu dòng registry.
  — 2026-11-08: `registry:check` chạy trong CI (`check:all`); các PR gần nhất (#580–#585) đều có dòng (186–192). Đây là kiểm số thứ tự và rà theo PR, không phải kiểm tự động "feature nào thiếu dòng".
- [x] **API surface freeze**: chốt danh sách endpoint/params/response-shape công khai trong `docs/en/api/hono-api-spec.md` + GraphQL spec + chữ ký `@lumibase/sdk`. Từ thời điểm freeze, mọi thay đổi breaking dồn về v2 (xem mục 6).
  — 2026-11-08: `versioning-policy.md` §Public surface định nghĩa surface là các spec trên + exports SDK. Việc docs khớp code thì kiểm lúc tag (§5). Lưu ý mục Jev ở phần rà soát đầu file.

## 3. Quality gates — BẮT BUỘC

Hiện CI (`.github/workflows/ci.yml`) có: version-check, typecheck, test, build, lint. Bổ sung trước v1:

- [x] **E2E/smoke test golden path**, chạy trong CI hoặc release workflow: setup wizard → tạo site → tạo collection → CRUD item → publish → đọc qua public API (kèm two-site isolation check). Không tag v1 khi golden path chỉ được verify tay.
  — 2026-11-08: `apps/cms/src/__tests__/golden-path.e2e.test.ts` (login thật, two-site isolation), job CI "E2E golden path".
- [x] **Dependency audit gate** trong CI (liên thông CWE-1104 ở mục 1b).
  — 2026-11-08: job "Dependency vulnerability audit", `--audit-level high`.
- [x] **CodeQL** (workflow đã tồn tại) được nối vào PR gate hoặc scheduled + có người xem kết quả.
  — 2026-11-08: `codeql.yml` chạy trên `pull_request` + `schedule`; 0 alert CodeQL mở. 99 alert Scorecard mở chưa ai xử lý (xem phần rà soát đầu file).
- [x] **Cả hai deployment target** (Cloudflare Workers + Docker) đều được smoke-test trên release candidate — không chỉ một. Docker path đi qua `serve.ts`, CF path qua `index.ts` + bindings production (Hyperdrive/KV/R2/Queue).
  — 2026-11-08: Docker: job `smoke-docker-image` trong `release.yml` (pass ở rc.1–rc.4). CF: `deploy-cms.yml` deploy staging trên mỗi push `main` rồi chạy `scripts/verify-cms-deploy.mjs`; production Worker được `release.yml` kiểm `/health` + version, nhưng job đó **bỏ qua tag prerelease** (skipped ở rc.1–rc.4, chạy thật lần cuối ở v0.26.0) nên lần đầu với 1.0 sẽ là lúc tag. `/health/ready` trên staging chỉ cảnh báo vì `CMS_REQUIRE_READY` chưa được đặt.
- [x] `pnpm typecheck` **recursive** + `pnpm test` full suite pass trên RC (nhắc: single-package typecheck pass không đủ).
  — 2026-11-08: job `verify` của `release.yml` chạy typecheck + test + build trước mọi publish; pass ở rc.4.

## 4. Upgrade path & data — BẮT BUỘC

- [ ] **Migration path 0.x → 1.0 được test thật**: dựng instance từ bản 0.x cũ nhất còn hỗ trợ, chạy upgrade, verify dữ liệu nguyên vẹn. Lưu ý các mốc đã biết: v0.6.x cần backfill RBAC Administrator; v0.17.x table prefix là fresh-install-only — chính sách cho instance pre-0.17 phải được viết rõ (hỗ trợ migrate hay tuyên bố phải re-install).
  — 2026-11-08: một phần. `upgrade-path.e2e.test.ts` (CI) seed shape RBAC cũ rồi chạy backfill thật, nhưng trên schema mới nhất. Chưa có lượt cài bản 0.x thật rồi chạy migration `0001…0023`. Chính sách pre-0.17 đã viết trong `upgrades.md`.
- [x] **`docs/en/operations/upgrades.md`** có mục "Upgrading to 1.0" hoàn chỉnh: từ version nào lên thẳng được, từ version nào phải qua bước trung gian, rollback thế nào.
  — 2026-11-08: đã cập nhật (EN + VI) nguồn `0.26.x`/`1.0.0-rc.x`, preflight `0017`, `0013` bỏ `NOT NULL`, mốc rollback `0.26.0`.
- [x] Mọi migration trong khoảng 0.18 → 1.0 idempotent, đánh số không xung đột (nhắc: renumber khi merge các nhánh song song).
  — 2026-11-08: `0000`–`0023` liên tục, không trùng. Mọi `CREATE TABLE/INDEX` và `ADD COLUMN` có `IF NOT EXISTS`; `ADD CONSTRAINT` nằm trong khối `DO … EXCEPTION WHEN duplicate_object`. `0017` có thể fail trên dữ liệu bẩn (đã ghi preflight).

## 5. Docs & release mechanics — BẮT BUỘC

- [ ] CHANGELOG có entry v1.0.0: tổng kết breaking changes so với 0.x (nếu có), highlight, upgrade steps. **(at-tag)**
  — 2026-11-08: chưa có `[1.0.0]`; entry nháp tháng 7 đã không còn. Các entry rc.1–rc.4 + `[Unreleased]` là nguồn để viết.
- [x] README **Release policy** cập nhật theo quy tắc DoD mục 4 (giữ narrative 0.5.0, chỉ bổ sung).
  — 2026-11-08: `README.md` §Release policy + §Versioning (giữ narrative 0.5.0). Dòng "Current release" cần đổi lúc tag.
- [ ] `docs/en/api/hono-api-spec.md`, `data-model.md`, `agent-setup/prompt.md` khớp code tại thời điểm tag. **(at-tag)**
- [ ] Tutorials: rà bảng Compatibility từng tutorial theo DoD mục 5; bump badge version nếu contract đổi. **(at-tag)**
- [ ] docs/en ↔ docs/vi sync (workflow i18n hiện có). **(at-tag)**
- [x] Cloudflare prereqs sẵn sàng trước khi push tag: Worker/Pages projects + production secrets tồn tại (release.yml deploy khi tag).
  — 2026-11-08: secret `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NPM_TOKEN`, `MARKETPLACE_SUBMODULE_TOKEN` có; environment `production` có. Kiểm lại một lần trước khi tag vì job CF production chưa chạy từ v0.26.0.
- [ ] Tag `v1.0.0` đặt đúng commit bump version (không tag trôi), theo skill `/release`. **(at-tag)**

## 6. Versioning policy sau v1.0 — chốt TRƯỚC khi tag

Đây là "điều kiện để có các version tiếp theo". Ghi thành mục **Versioning policy** trong README (hoặc `docs/en/contributing/`), nội dung tối thiểu:

— 2026-11-08: cả 6 ô có trong `docs/en/contributing/versioning-policy.md` (+ bản VI), README §Versioning trỏ tới.

- [x] **Semver nghiêm ngặt từ 1.0.0:**
  - **PATCH (1.0.x)** — bug fix, security fix không đổi contract. Không migration phá dữ liệu.
  - **MINOR (1.x.0)** — feature mới, endpoint/field mới (additive), migration additive + idempotent. Không xoá/đổi shape của surface đã freeze ở mục 2.
  - **MAJOR (2.0.0)** — breaking change: xoá endpoint, đổi response shape, đổi auth contract, migration đòi downtime/re-install.
- [x] **Định nghĩa "public surface"** (cái được semver bảo hành): REST/GraphQL API, `@lumibase/sdk` exports, response format `{ data, meta }`/`{ errors }`, header contracts (`X-Lumi-Site`…), env var tên + ngữ nghĩa, CLI/setup wizard flags. Ngoài danh sách này (internal services, DB schema chi tiết, Studio internals) được phép đổi trong minor.
- [x] **Deprecation policy**: muốn bỏ gì phải deprecate ở một bản minor trước (log warning + CHANGELOG + docs), chỉ xoá ở major kế tiếp. Tối thiểu 1 minor cycle giữa deprecate và remove.
- [x] **Support window**: tuyên bố rõ (đề xuất: security fix cho major hiện tại + major liền trước trong 6 tháng sau khi major mới ra — chỉnh theo năng lực team).
- [x] **Release cadence & gate cho mọi bản sau v1**: mỗi release (kể cả patch) đi qua CI đầy đủ ở mục 3 + upgrade-path test ở mục 4 nếu có migration. Checklist này (mục 1c, 3, 4, 5) trở thành template rút gọn cho minor/major sau — major thì chạy lại toàn bộ file này.
- [x] **DoD evolution** (DoD mục 6) vẫn áp dụng: bug class mới sau v1 → tripwire + cập nhật DoD cùng PR.

## 7. Nên có — không chặn tag (ghi rõ nếu bỏ qua)

- [ ] Performance baseline: đo p95 latency các endpoint nóng trên cả hai runtime, lưu số làm mốc so sánh cho các bản sau.
  — 2026-11-08: một phần. `perf-k6.yml` chạy hằng đêm trên Docker với ngưỡng p95 (`<500 ms`, delivery `<800 ms`), xanh. Chưa đo trên Cloudflare.
- [ ] Load test cơ bản sau khi có rate limiting (mục 1a) — xác nhận limit đúng ngưỡng thiết kế.
  — 2026-11-08: chưa kiểm được run k6 nào khẳng định ngưỡng rate limit.
- [ ] `docs/en/DEPLOYMENT-CHECKLIST.md` chạy thử end-to-end bởi người KHÔNG phải tác giả, ghi lại chỗ vướng.
  — 2026-11-08: không có bản ghi.
- [x] Kênh báo lỗi bảo mật public (SECURITY.md + email/contact) — chuẩn mực khi mời production adoption.
  — 2026-11-08: `SECURITY.md` có; README §Versioning trỏ tới.

---

**Cách dùng:** mở tracking issue "v1.0.0 readiness" gồm các mục BẮT BUỘC ở trên, mỗi mục một checkbox + owner. Khi tất cả mục 1–6 xanh, chạy `/release` cho 1.0.0. File này sau đó giữ lại làm template cho 2.0.0.
