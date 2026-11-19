# Design — Release Flags (#869 part 1)

## Bối cảnh trên `main` (2026-11-17)

- Nhiều tính năng đã có cờ theo site trong `settings` (`contentOs`, `files.dam`, `openapi`, …), mỗi cái một reader riêng, không registry, không kênh điều khiển từ xa.
- Hạ tầng tái dùng được: `verifyEd25519` (`@lumibase/contracts/extensions`, dùng cho ký extension), `createProcessCache` (`services/process-cache.ts`), `systemDbFor`, `requireSiteAdmin`, mẫu bootstrap-admin của `/admin/email-identity/instance`, tiền lệ thêm cột vào singleton `lumibase_system_state` (#794).

## Quyết định

1. **Hai lớp thay cho chuỗi ưu tiên phẳng.** Issue đề xuất `env → organization → site → manifest → default`. Chuỗi phẳng đó cho phép site bật một tính năng LumiBase chưa phát hành. Thiết kế tách: Release_Gate (env → manifest → stage) rồi mới tới Site_Choice. Env đứng trên manifest vì đó là công tắc tắt khẩn cấp của operator, và trên bản tự host operator vốn kiểm soát code.
2. **Lớp organization hoãn.** Chưa có đường ghi org settings cho flag; thêm lớp đọc mà không ai ghi là code chết. Ghi thành task.
3. **Ký trên byte payload.** Envelope `{ keyId, payload: base64(JSON), signature }` — không cần canonical JSON.
4. **Lưu ở bảng riêng `lumibase_release_manifests`** (migration `0043`, một dòng `id = 'current'`), không ở `settings` của site `__default__` (admin site ghi được qua `POST /api/v1/settings`, mở đường lưu manifest không qua xác minh hoặc quay ngược) và **không** ở một cột mới của `lumibase_system_state`. Lý do bỏ phương án cột: Drizzle liệt kê mọi cột đã khai báo trong câu INSERT, nên image mới chạy trên schema N-1 (chưa có cột) sẽ hỏng ngay câu INSERT token setup lúc khởi động — đã xảy ra ở CI `kind smoke test` của #894 (`column "release_manifest" does not exist`). Với bảng riêng, code mới chỉ đụng bảng khi đọc/chấp nhận manifest; đọc lỗi (bảng chưa có) → coi như chưa có manifest. Ghi bằng một câu upsert có `setWhere issued_at_ms <` giá trị mới.
5. **`notAfter` chỉ giới hạn lúc chấp nhận.** Manifest đã nhận giữ hiệu lực tới khi bị thay — mất liên lạc không tắt tính năng.
6. **Pull chạy nền (stale-while-revalidate)**, kích hoạt khi có request đánh giá flag, tối đa mỗi `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` giây/process; dùng `runDetached` (Workers `waitUntil`).
7. **Cache**: manifest — process cache 30 s (replica khác thấy trong 30 s); site choice — `runtime.cache` key `release-flags:site:{siteId}` TTL 60 s, xoá khi ghi qua API.
8. **Route gắn cờ trả 404** y hệt `app.notFound`, để tính năng dark không lộ sự tồn tại.

## Thành phần

| File | Vai trò |
|---|---|
| `apps/cms/src/modules/release-flags/registry.ts` | Khai báo + kiểm tra registry, `ReleaseFlagKey` |
| `resolver.ts` | Hàm thuần đánh giá một flag; parse `LUMIBASE_RELEASE_FLAGS` |
| `manifest.ts` | Schema envelope/payload, `verifyReleaseManifest`, parse khoá công khai |
| `service.ts` | Đọc/ghi manifest, pull, site choice, `evaluateReleaseFlags` |
| `middleware.ts` | Memo theo request, `isReleaseFlagEnabled`, `requireReleaseFlag` |
| `routes.ts` | `/api/v1/release-flags/*` |
| `scripts/release-flags/manifest.mjs` | Phía LumiBase: `keygen`, `sign` |

## Bảo mật

- Chữ ký là thứ cho phép giá trị flag, không phải người gọi: bootstrap admin cũng không lưu được manifest LumiBase không ký.
- Endpoint manifest từ chối API key và principal ẩn danh.
- Không phải rào bản quyền trên bản tự host (operator đặt được env).
- `/api/v1/release-flags` không thuộc control plane vì member cần đọc; mọi đường ghi tự gate trong router.

## Đa tenant

Manifest, env, khoá: toàn deployment (không chứa dữ liệu tenant). Site choice: `lumibase_settings` (RLS `site_isolation`), cache key có `siteId`. Kiểm bằng hai DB integration test.
