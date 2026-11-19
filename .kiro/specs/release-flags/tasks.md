# Tasks — Release Flags & In-app Upgrade (#869)

> Điều kiện hoàn thành mỗi phần: `pnpm -F @lumibase/cms test` (kèm `DATABASE_URL` cho suite DB), typecheck, docs EN/VI stamp `--verified`, Setup Impact Registry.

## Part 1 — Release flags (PR này)

- [x] 1. Registry có kiểu + kiểm tra khai báo + test hết hạn `removeBy` (Req 1)
- [x] 2. Resolver thuần hai lớp + parse `LUMIBASE_RELEASE_FLAGS`; unit + property test (Req 2.1–2.3)
- [x] 3. Manifest Ed25519: schema, xác minh, chống replay; test (Req 3.1–3.2)
- [x] 4. Migration `0043_release_manifest` (bảng `lumibase_release_manifests`) + upsert có điều kiện; DB test race (đã kiểm bằng đột biến: bỏ điều kiện → test fail) và test schema N-1 (bảng chưa có → mặc định theo stage) (Req 3.3)
- [x] 5. Push + pull + trạng thái lần pull; lỗi pull giữ manifest cũ (Req 3.4–3.6)
- [x] 6. Site choice + xoá cache khi ghi; test cô lập hai site và cache dùng chung (Req 4)
- [x] 7. `requireReleaseFlag` / `isReleaseFlagEnabled`, memo theo request; test route 404 → 200 theo site (Req 2.4–2.5)
- [x] 8. Route `/api/v1/release-flags/*` + test phân quyền (member / site admin / bootstrap / API key)
- [x] 9. Script `scripts/release-flags/manifest.mjs` + test đồng bộ script ↔ verifier
- [x] 10. Docs `features/release-flags.md` (EN/VI), API spec, data-model, OpenAPI, CHANGELOG, Setup Impact #314

## Part 1 — Tiếp theo

- [ ] 11. Studio: trang chỉ đọc "Release flags" (trạng thái, nguồn quyết định) và công tắc theo site cho admin
- [ ] 12. Chuyển các cờ hiện có vào registry hoặc khai báo chúng (`contentOs.*`, `files.dam`, `openapi`, …) — giữ tương thích dữ liệu `settings` cũ
- [ ] 13. Lớp organization (đọc + đường ghi), nếu còn cần sau khi có billing (ADR-013)
- [x] 14. Nạp manifest khi khởi động / cron thay vì chỉ khi có request (instance ít traffic) — #897: `runScheduledReleasePull` (start + `node-cron` Docker, `scheduled` Workers), lịch sử pull dùng chung qua cache, `/health` `releaseManifest`, metric `lumibase_release_manifest_*`
- [x] 15. Hạ tầng phát hành của LumiBase: nơi giữ khoá riêng, CI ký và đăng manifest — #897: secret của environment `release-manifest` (reviewer bắt buộc) + bản offline; workflow `release-manifest.yml` (`sign --key-env` → `verify` → R2); audience theo `LUMIBASE_INSTANCE_ID` từng môi trường; runbook xoay khoá trong docs

## Part 2 — Nút Upgrade (Req 5)

- [x] 16. Preflight endpoint (phiên bản, migration chờ, cảnh báo) — #898
- [x] 17. Mô hình deploy hook theo kiểu triển khai (hosted control plane / CI webhook / updater riêng), tái dùng provider của deployment-integrations — #898
- [x] 18. `POST /system/upgrade` + audit + theo dõi tiến độ — #898
- [x] 19. Studio: preflight → xác nhận → tiến độ trên trang Updates — #898
- [x] 20. Quyết định ai chạy migration ở từng chế độ triển khai — #898
