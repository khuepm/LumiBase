# Tasks — Setup-Complete Per-IP Rate Brake

> Điều kiện hoàn thành: `pnpm -F @lumibase/cms test`, `turbo run typecheck` (recursive), và rà **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done. Spec này **đụng trực tiếp** setup wizard ⇒ mục Setup Impact KHÔNG phải `n/a`.

- [x] 1. Thêm state cho `/complete` trong `apps/cms/src/modules/setup/routes.ts`
  - [x] 1.1 Khai báo `COMPLETE_RATE_LIMIT = 10`, `COMPLETE_RATE_WINDOW_MS = 60_000`, `completeRateBuckets` (cạnh khối `/state`, tái dùng interface `RateBucket`) (Req 1.5)
  - [x] 1.2 `checkCompleteRateLimit(ip)` — sliding-window cùng kiểu `checkStateRateLimit`, key = `ip || 'unknown'` (Req 1.2, 2.3)
  - [x] 1.3 Mở rộng `__resetSetupRateLimitForTests()` để `completeRateBuckets.clear()` (Req 2.4)

- [x] 2. Áp brake trong handler `POST /complete`
  - [x] 2.1 Ở dòng đầu handler: `extractClientIp` → `checkCompleteRateLimit`; nếu fail trả `429 { errors: [{ code: 'RATE_LIMITED' }] }` + `retry-after`, **trước** `c.req.json()` và `buildService` (Req 1.1, 2.2)
  - [x] 2.2 Tái dùng biến `ip` cho `SetupCompleteContext.ip` (tránh gọi `extractClientIp` lần hai) (Req 1.3 — không đổi luồng còn lại)

- [x] 2b. **(ngoài spec gốc, cần thiết cho Req 3.3)** Wire seam `setupServiceOverride`
  - [x] 2b.1 Khai báo type `setupServiceOverride` trong `AppEnv['Variables']` (`env.ts`, structural — chỉ method `complete`, mirror `recoveryServiceOverride`)
  - [x] 2b.2 Handler `/complete` đọc `c.get('setupServiceOverride') ?? buildService(c)`; narrow `outcome.error as SetupServiceError` tại 1 call site. Trước đây comment `buildService` *nhắc tới* seam này nhưng code chưa đọc — nay đúng lời hứa, mở đường test route-level không cần Postgres.

- [x] 3. Test — file mới `apps/cms/src/modules/setup/__tests__/complete-rate-brake.test.ts` (mount `setupRouter` + `db` stub + `setupServiceOverride`, mẫu recovery routes test)
  - [x] 3.1 `COMPLETE_RATE_LIMIT + 1` request cùng IP → 429 + `retry-after: 60`; khẳng định `stub.complete` KHÔNG được gọi thêm ở request bị chặn (Req 3.1)
  - [x] 3.2 IP khác không bị ảnh hưởng bởi hạn mức IP đầu (Req 3.2)
  - [x] 3.3 `/complete` hợp lệ trong hạn mức vẫn 201 (dùng `setupServiceOverride`) (Req 3.3)
  - [x] 3.4 Spam `/state` không làm 429 `/complete` (bucket độc lập) — assert `/state` không bao giờ 429 + `/complete` sau đó vẫn 201 (Req 3.4, Req 1.4)
  - [x] 3.5 `__resetSetupRateLimitForTests()` trong `beforeEach` để cô lập
  - [x] 3.6 429 body chỉ chứa key `errors` (không rò version/hostname/tenant) (Req 2.2)

- [x] 4. Verify & DoD
  - [x] 4.1 `pnpm -F @lumibase/cms test setup/` 95/95 xanh (gồm 5 test mới); `pnpm -F @lumibase/cms typecheck` sạch. **Lưu ý:** `turbo run typecheck` recursive fail ở `@lumibase/extension-cli` do thiếu `node_modules` trong worktree (lỗi môi trường pre-existing, KHÔNG liên quan thay đổi này).
  - [x] 4.2 Ghi vào **Setup Impact Registry** — hàng #79. Đây là thay đổi hành vi setup wizard (thêm nhánh 429 trên `/complete`, ngưỡng 10 req/60s/IP); client setup cần xử lý `429 + retry-after` (backoff, không loop cứng).

---

**Implementation status:** Implemented 2026-07-17. Rate brake + `setupServiceOverride` seam trong `routes.ts`, type trong `env.ts`, 5 tests mới. `pnpm -F @lumibase/cms test setup/` 95/95, typecheck sạch. Giới hạn đã biết (ghi trong design): in-memory per-isolate ⇒ hạn mức thực = `10 × số_isolate`; DB lock + unique index vẫn là hard guard chống admin trùng.
