# v1.0.0 — CHANGELOG draft (chưa phát hành)

> **Đây KHÔNG phải release notes đã phát hành.** `1.0.0` chưa được tag. Nội dung dưới đây được viết ngày 2026-07-11 và trước đó nằm trực tiếp trong `CHANGELOG.md` dưới heading `## [1.0.0] - 2026-07-11`, kẹp giữa `[0.22.0]` và `[0.21.0]`. Đã chuyển ra đây vì:
>
> 1. **Nó khẳng định một bản release không tồn tại.** Người đọc `CHANGELOG.md` sẽ kết luận 1.0.0 đã ship ngày 2026-07-11 — trước cả 0.22.0, 0.23.0, 0.24.x.
> 2. **Nó sẽ tạo heading trùng khi cắt release thật.** `/release` (`.claude/commands/release.md` step 2) chèn section mới ngay dưới `## [Unreleased]`. Giữ bản cũ ở giữa file → hai heading `## [1.0.0]`, và đoạn `awk` extract ở cùng step sẽ bắt đúng bản stale để đưa vào GitHub Release.
>
> **Khi cắt RC:** dùng file này làm điểm bắt đầu, KHÔNG copy nguyên xi — xem mục "Còn phải bổ sung/sửa" bên dưới — rồi viết section `## [1.0.0]` mới dưới `## [Unreleased]` theo `/release`. Nguồn tiêu chí: `v1-release-criteria.md` §5. Sau khi entry thật đã vào `CHANGELOG.md`, xoá file này.

## Còn phải bổ sung / sửa trước khi dùng

Bản nháp dừng ở v0.21.x. Đối chiếu lại trước khi đưa vào CHANGELOG:

- **Chưa cover 0.22.0 → 0.24.1** (viết trước các bản này): MCP server, NVIDIA/Vertex providers, pageviews, extension signing, OWASP API Top 10 audit, và các thay đổi 0.24.x.
- **Mục Security đã stale.** Bản nháp ghi *"CWE-521 … tracked as a required v1 fix"* — CWE-521 đã fix; bảng audit hiện là 78 ✅ / 0 ⚠️ / 0 ❌. CWE-359 đã có verdict (redact-on-write).
- **Backfill giờ đã chạy được thật.** Bản nháp nói backfill "verified" nhưng lúc đó repo không có gì chứng minh. Nay đã có `packages/database/src/backfill/role-policies.ts` + CLI `pnpm backfill:role-policies` (apply|verify|rollback) và `apps/cms/src/__tests__/upgrade-path.e2e.test.ts` nối vào CI job `e2e-golden-path` — nêu đúng tên artifact thay vì nói chung.
- **Golden-path E2E đã mạnh hơn mô tả:** nay có bước đọc ẩn danh qua Delivery API (trước dùng admin token) và assert isolation trên surface công khai.
- **Nhắc scope freeze:** trỏ tới `v1-scope-classification.md` cho danh sách in-v1 / post-v1 (M2A out-of-scope, trả 501 `RELATION_TYPE_NOT_IMPLEMENTED`).

---

## Nội dung nháp (nguyên văn, giữ để tham chiếu)

### Highlights

- **First release under a semver stability guarantee.** `1.0.0` freezes the
  public surface — REST/GraphQL API, `@lumibase/sdk` exports, the
  `{ data, meta }` / `{ errors }` response format, header contracts
  (`X-Lumi-Site`…), environment variable names/semantics, and setup-wizard
  flags. From here, breaking changes are deferred to `2.0.0`; additive changes
  ship in minors and bug/security fixes in patches. See the versioning policy in
  the README.
- **Policies are the source of truth for access.** The role→policy migration
  reaches its stable shape: `admin_access`/`app_access` (plus `enforce_tfa`, IP
  guards, and time windows) are owned by policies. Legacy role flags remain as a
  compatibility fallback through 1.0 for rollback safety. A verified,
  idempotent backfill materializes legacy role flags into policies on upgrade.
- **Backward-compatible upgrade path from `0.6.x`.** Instances on `0.6.x`–
  `0.21.x` upgrade in place; the full "Upgrading to 1.0" runbook documents which
  sources go direct, which need an intermediate stop, and the pre-`0.17.0`
  re-import boundary. See Upgrade notes below.
- **Golden-path E2E gate in CI.** No tag ships on hand-verified flows: CI now
  drives setup wizard → create site → create collection → CRUD item → publish →
  read via the public API, with a two-site isolation check.

### Added

- **CI golden-path E2E gate.** A new `e2e-golden-path` job in
  `.github/workflows/ci.yml` exercises the end-to-end content lifecycle
  (setup → site → collection → item CRUD → publish → public read) plus
  cross-tenant isolation, on every PR and push to `main`. The v1 release
  criteria (§3) require this gate to be green before tagging.
- **"Upgrading to 1.0" operations runbook.** `docs/en/operations/upgrades.md`
  (VI mirror in `docs/vi/`) gains a version-specific section: a supported-source
  matrix, the RBAC role→policy backfill with its idempotent SQL and zero-row
  verification query, and rollback guidance. Surfaced under a new "Operations"
  docs category.

### Changed

- **RBAC access model finalized on policies.** Effective access continues to be
  computed as `role flags OR active policy flags` during the 1.0 compatibility
  window; the role flag columns are retained (not dropped) so rollback stays
  safe. They are scheduled to drop in a later release only after
  `LUMIBASE_RBAC_LEGACY_ROLE_FLAGS=false` has shipped and been verified.

### Security

- No new advisories in this release. The v1 security audit
  (`docs/en/security/cwe-top-100-audit.md`) is the release gate: every
  Partial/Not-addressed CWE must be fixed or accepted-with-rationale before the
  `v1.0.0` tag. CWE-521 (password-policy alignment, `register` → 12-char
  minimum) is tracked as a required v1 fix.

### Upgrade notes

- **Read `docs/en/operations/upgrades.md` → "Upgrading to 1.0" before
  upgrading.** Summary:
  - `0.18.x`–`0.21.x` → direct, no manual data step.
  - `0.6.x`–`0.17.x` → direct, plus the RBAC role→policy backfill (run against
    staging, verify the post-check returns zero rows).
  - Before `0.17.0` (unprefixed tables) → **not an in-place upgrade**; export and
    re-import into a fresh `1.0.0` install.
  - Before `0.6.0` → upgrade to an intermediate `0.17.x`–`0.21.x` release first,
    verify, then upgrade to `1.0.0`.
- **No destructive schema change over `0.21.x`.** Application rollback to the
  previous `0.21.x` deployment remains compatible with the 1.0 database. The
  backfill is separately reversible during the compatibility window (delete the
  `legacy_role_flags_%` policies; role flags are untouched).
