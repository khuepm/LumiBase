# LumiBase — v1.0.0 Release Criteria (exit checklist)

> Khác với `definition-of-done.md` (áp cho **từng feature**), file này là điều kiện thoát cho **một release major**. v1.0.0 là lời cam kết public: API surface ổn định, semver được tôn trọng, upgrade path được bảo hành. Chưa tick đủ mục **BẮT BUỘC** thì chưa tag v1.0.0.
>
> Trạng thái khảo sát nền (2026-07-06, tại v0.18.0): security audit 66/78 CWE mitigated, 9 partial, 3 not addressed (`docs/en/security/cwe-top-100-audit.md`); CI có version-check/typecheck/test/build/lint nhưng **chưa có E2E gate và dependency-audit gate**; M2A relations còn reserved-not-implemented.

## 1. Security — BẮT BUỘC

Nguồn: `docs/en/security/cwe-top-100-audit.md`. Mỗi mục Partial/Not-addressed phải được **fix** hoặc **accept có chữ ký** (ghi lý do + owner vào bảng audit). Không được để trạng thái "chưa ai quyết".

### 1a. Phải fix trước v1.0 (rủi ro thật cho public deployment)

- [ ] **CWE-400 — Rate limiting per-user/per-endpoint** cho REST/GraphQL. Hiện chỉ có auth/recovery (3/IP/h) + global backpressure. Đây là gap chính khi mở public.
- [ ] **CWE-362/367 — Race condition AI approval decide**: UPDATE phải kèm `WHERE status='pending'` + check affected-row count (`apps/cms/src/services/ai-harness.ts:2207–2258`).
- [ ] **CWE-620/613 — Session & password lifecycle**: thêm change-password endpoint (yêu cầu current password); reset password phải invalidate token hiện hành. JWT 24h không revocation → tối thiểu có cơ chế revoke (session table hoặc token version).
- [ ] **CWE-521 — Thống nhất password policy**: register đang `min(6)` (`apps/cms/src/routes/auth.ts:209`) trong khi setup/recovery là `min(12)` + complexity. Align về 12+.
- [ ] **CWE-302 — `X-Lumi-Site` header**: verify tenant membership ngay tại middleware (không defer xuống route layer); map role Cloudflare Access từ DB thay vì hardcode `['admin']` (`apps/cms/src/middleware/auth.ts:146`).
- [ ] **CWE-942 — CORS non-production**: bỏ wildcard-origin-with-credentials khi `CORS_ALLOWED_ORIGINS` unset (`apps/cms/src/config/cors.ts:11-34`) — staging chạy nhầm dev env là dính thật.

### 1b. Fix hoặc accept-with-rationale

- [ ] **CWE-203 — User enumeration qua register** (`EMAIL_ALREADY_EXISTS`): đổi sang generic response + email thông báo, hoặc accept nếu deployment mặc định đóng register.
- [ ] **CWE-321 — CDC fallback key trong code** (`apps/cms/src/modules/cdc/registry/encryption.ts:16`): production đã reject, nhưng cần bước ép `ENCRYPTION_KEY` trong setup wizard / deployment checklist.
- [ ] **CWE-359 — PII trong audit metadata**: erasure route purge items nhưng không purge audit log → quyết định policy (redact-on-write hoặc erasure quét cả audit) trước khi cam kết GDPR ở v1.
- [ ] **CWE-1104 — Dependency hygiene**: bật renovate/dependabot + thêm `pnpm audit` (hoặc tương đương) vào CI. Đây vừa là security vừa là gate lâu dài (xem mục 3).

### 1c. Chốt sổ

- [ ] Bảng audit không còn dòng nào thiếu verdict: mọi ⚠️/❌ hoặc đã chuyển ✅, hoặc có dòng "Accepted for v1.0 — lý do, owner, ngày".
- [ ] Chạy lại `/security-review` (hoặc tương đương) trên diff tổng từ v0.18.0 → release candidate.

## 2. Scope freeze — BẮT BUỘC

- [ ] **Quyết định M2A relations**: hiện `schema-service.ts` trả "reserved but not implemented". Hoặc ship trong v1, hoặc tuyên bố chính thức out-of-scope trong docs + roadmap (một dòng "coming in 1.x", không để mập mờ). Reserved-surface không được đổi shape sau v1 nếu đã public.
- [ ] **Rà `.kiro/specs/`**: mọi spec đang partial hoặc mở phải được phân loại **in-v1 / post-v1** — spec in-v1 phải qua đủ DoD; spec post-v1 ghi rõ vào roadmap. Không dùng checkbox tasks.md làm bằng chứng — đối chiếu Implementation-status footer + code. → Kết quả: `.kiro/steering/v1-scope-classification.md` (2026-07-16).
- [ ] **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) không còn feature in-v1 nào thiếu dòng registry.
- [ ] **API surface freeze**: chốt danh sách endpoint/params/response-shape công khai trong `docs/en/api/hono-api-spec.md` + GraphQL spec + chữ ký `@lumibase/sdk`. Từ thời điểm freeze, mọi thay đổi breaking dồn về v2 (xem mục 6).

## 3. Quality gates — BẮT BUỘC

Hiện CI (`.github/workflows/ci.yml`) có: version-check, typecheck, test, build, lint. Bổ sung trước v1:

- [ ] **E2E/smoke test golden path**, chạy trong CI hoặc release workflow: setup wizard → tạo site → tạo collection → CRUD item → publish → đọc qua public API (kèm two-site isolation check). Không tag v1 khi golden path chỉ được verify tay.
- [ ] **Dependency audit gate** trong CI (liên thông CWE-1104 ở mục 1b).
- [ ] **CodeQL** (workflow đã tồn tại) được nối vào PR gate hoặc scheduled + có người xem kết quả.
- [ ] **Cả hai deployment target** (Cloudflare Workers + Docker) đều được smoke-test trên release candidate — không chỉ một. Docker path đi qua `serve.ts`, CF path qua `index.ts` + bindings production (Hyperdrive/KV/R2/Queue).
- [ ] `pnpm typecheck` **recursive** + `pnpm test` full suite pass trên RC (nhắc: single-package typecheck pass không đủ).

## 4. Upgrade path & data — BẮT BUỘC

- [ ] **Migration path 0.x → 1.0 được test thật**: dựng instance từ bản 0.x cũ nhất còn hỗ trợ, chạy upgrade, verify dữ liệu nguyên vẹn. Lưu ý các mốc đã biết: v0.6.x cần backfill RBAC Administrator; v0.17.x table prefix là fresh-install-only — chính sách cho instance pre-0.17 phải được viết rõ (hỗ trợ migrate hay tuyên bố phải re-install).
- [ ] **`docs/en/operations/upgrades.md`** có mục "Upgrading to 1.0" hoàn chỉnh: từ version nào lên thẳng được, từ version nào phải qua bước trung gian, rollback thế nào.
- [ ] Mọi migration trong khoảng 0.18 → 1.0 idempotent, đánh số không xung đột (nhắc: renumber khi merge các nhánh song song).

## 5. Docs & release mechanics — BẮT BUỘC

- [ ] CHANGELOG có entry v1.0.0: tổng kết breaking changes so với 0.x (nếu có), highlight, upgrade steps.
- [ ] README **Release policy** cập nhật theo quy tắc DoD mục 4 (giữ narrative 0.5.0, chỉ bổ sung).
- [ ] `docs/en/api/hono-api-spec.md`, `data-model.md`, `agent-setup/prompt.md` khớp code tại thời điểm tag.
- [ ] Tutorials: rà bảng Compatibility từng tutorial theo DoD mục 5; bump badge version nếu contract đổi.
- [ ] docs/en ↔ docs/vi sync (workflow i18n hiện có).
- [ ] Cloudflare prereqs sẵn sàng trước khi push tag: Worker/Pages projects + production secrets tồn tại (release.yml deploy khi tag).
- [ ] Tag `v1.0.0` đặt đúng commit bump version (không tag trôi), theo skill `/release`.

## 6. Versioning policy sau v1.0 — chốt TRƯỚC khi tag

Đây là "điều kiện để có các version tiếp theo". Ghi thành mục **Versioning policy** trong README (hoặc `docs/en/contributing/`), nội dung tối thiểu:

- [ ] **Semver nghiêm ngặt từ 1.0.0:**
  - **PATCH (1.0.x)** — bug fix, security fix không đổi contract. Không migration phá dữ liệu.
  - **MINOR (1.x.0)** — feature mới, endpoint/field mới (additive), migration additive + idempotent. Không xoá/đổi shape của surface đã freeze ở mục 2.
  - **MAJOR (2.0.0)** — breaking change: xoá endpoint, đổi response shape, đổi auth contract, migration đòi downtime/re-install.
- [ ] **Định nghĩa "public surface"** (cái được semver bảo hành): REST/GraphQL API, `@lumibase/sdk` exports, response format `{ data, meta }`/`{ errors }`, header contracts (`X-Lumi-Site`…), env var tên + ngữ nghĩa, CLI/setup wizard flags. Ngoài danh sách này (internal services, DB schema chi tiết, Studio internals) được phép đổi trong minor.
- [ ] **Deprecation policy**: muốn bỏ gì phải deprecate ở một bản minor trước (log warning + CHANGELOG + docs), chỉ xoá ở major kế tiếp. Tối thiểu 1 minor cycle giữa deprecate và remove.
- [ ] **Support window**: tuyên bố rõ (đề xuất: security fix cho major hiện tại + major liền trước trong 6 tháng sau khi major mới ra — chỉnh theo năng lực team).
- [ ] **Release cadence & gate cho mọi bản sau v1**: mỗi release (kể cả patch) đi qua CI đầy đủ ở mục 3 + upgrade-path test ở mục 4 nếu có migration. Checklist này (mục 1c, 3, 4, 5) trở thành template rút gọn cho minor/major sau — major thì chạy lại toàn bộ file này.
- [ ] **DoD evolution** (DoD mục 6) vẫn áp dụng: bug class mới sau v1 → tripwire + cập nhật DoD cùng PR.

## 7. Nên có — không chặn tag (ghi rõ nếu bỏ qua)

- [ ] Performance baseline: đo p95 latency các endpoint nóng trên cả hai runtime, lưu số làm mốc so sánh cho các bản sau.
- [ ] Load test cơ bản sau khi có rate limiting (mục 1a) — xác nhận limit đúng ngưỡng thiết kế.
- [ ] `docs/en/DEPLOYMENT-CHECKLIST.md` chạy thử end-to-end bởi người KHÔNG phải tác giả, ghi lại chỗ vướng.
- [ ] Kênh báo lỗi bảo mật public (SECURITY.md + email/contact) — chuẩn mực khi mời production adoption.

---

**Cách dùng:** mở tracking issue "v1.0.0 readiness" gồm các mục BẮT BUỘC ở trên, mỗi mục một checkbox + owner. Khi tất cả mục 1–6 xanh, chạy `/release` cho 1.0.0. File này sau đó giữ lại làm template cho 2.0.0.
