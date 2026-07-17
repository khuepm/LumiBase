# Tasks — Setup-Complete Per-IP Rate Brake

> Điều kiện hoàn thành: `pnpm -F @lumibase/cms test`, `turbo run typecheck` (recursive), và rà **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done. Spec này **đụng trực tiếp** setup wizard ⇒ mục Setup Impact KHÔNG phải `n/a`.

- [ ] 1. Thêm state cho `/complete` trong `apps/cms/src/modules/setup/routes.ts`
  - [ ] 1.1 Khai báo `COMPLETE_RATE_LIMIT = 10`, `COMPLETE_RATE_WINDOW_MS = 60_000`, `completeRateBuckets` (cạnh khối `/state`, tái dùng interface `RateBucket`) (Req 1.5)
  - [ ] 1.2 `checkCompleteRateLimit(ip)` — sliding-window cùng kiểu `checkStateRateLimit`, key = `ip || 'unknown'` (Req 1.2, 2.3)
  - [ ] 1.3 Mở rộng `__resetSetupRateLimitForTests()` để `completeRateBuckets.clear()` (Req 2.4)

- [ ] 2. Áp brake trong handler `POST /complete`
  - [ ] 2.1 Ở dòng đầu handler: `extractClientIp` → `checkCompleteRateLimit`; nếu fail trả `429 { errors: [{ code: 'RATE_LIMITED' }] }` + `retry-after`, **trước** `c.req.json()` và `buildService` (Req 1.1, 2.2)
  - [ ] 2.2 Tái dùng biến `ip` cho `SetupCompleteContext.ip` (tránh gọi `extractClientIp` lần hai) (Req 1.3 — không đổi luồng còn lại)

- [ ] 3. Test (mở rộng file test setup routes hiện có)
  - [ ] 3.1 `Complete_Max + 1` request cùng IP → 429 + `retry-after`; khẳng định `setupServiceOverride.complete` KHÔNG được gọi ở request bị chặn (Req 3.1)
  - [ ] 3.2 IP khác không bị ảnh hưởng bởi hạn mức IP đầu (Req 3.2)
  - [ ] 3.3 `/complete` hợp lệ trong hạn mức vẫn 201 (dùng `setupServiceOverride`) (Req 3.3)
  - [ ] 3.4 Spam `/state` không làm 429 `/complete` (bucket độc lập) (Req 3.4, Req 1.4)
  - [ ] 3.5 Gọi `__resetSetupRateLimitForTests()` giữa các test để cô lập

- [ ] 4. Verify & DoD
  - [ ] 4.1 `pnpm -F @lumibase/cms test` + `turbo run typecheck` (recursive) xanh
  - [ ] 4.2 Ghi kết quả vào **Setup Impact Registry** — đây là thay đổi hành vi của setup wizard (thêm nhánh 429 trên `/complete`); ghi rõ ngưỡng và ảnh hưởng UX (client cần xử lý 429 + retry-after)

---

**Implementation status:** Not started — spec only.
