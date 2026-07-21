# Design — Setup-Complete Per-IP Rate Brake

## Bối cảnh code hiện tại

Tất cả nằm trong **một file**: `apps/cms/src/modules/setup/routes.ts`.

- Mẫu rate-brake đã tồn tại cho `/state` (dòng 78-104):
  ```ts
  interface RateBucket { count: number; resetAt: number; }
  const STATE_RATE_LIMIT = 60;            // req/min/IP
  const STATE_RATE_WINDOW_MS = 60_000;
  const stateRateBuckets = new Map<string, RateBucket>();
  export function __resetSetupRateLimitForTests(): void { stateRateBuckets.clear(); }
  function checkStateRateLimit(ip: string): boolean { … sliding window … }
  ```
- `/state` handler áp brake ở đầu (dòng 252-260): 429 `{ errors: [{ code: 'RATE_LIMITED' }] }` + `retry-after`.
- `/complete` handler (dòng 280-327): parse JSON → `completeBodySchema.safeParse` → `buildService(c)` → `extractClientIp(c.req.raw)` (đã dùng sẵn ở dòng 314) → `svc.complete(...)`.
- `svc.complete` là nơi chạy password hashing + DB lock. **Brake phải đứng trước cả `c.req.json()`** để chặn CPU cost (hashing) và I/O.

## Thiết kế

Tái dùng đúng khuôn `/state`, thêm một bucket **độc lập** cho `/complete` với ngưỡng chặt hơn. Không trừu tượng hoá sớm thành một helper chung — hai limiter có ngưỡng khác nhau và giữ song song đọc rõ hơn, nhất quán với phong cách file hiện tại.

### Thêm state cho `/complete` (cạnh khối `/state`)

```ts
const COMPLETE_RATE_LIMIT = 10;          // req/min/IP — mutation đắt, one-shot
const COMPLETE_RATE_WINDOW_MS = 60_000;
const completeRateBuckets = new Map<string, RateBucket>();

function checkCompleteRateLimit(ip: string): boolean {
  const now = Date.now();
  const key = ip || 'unknown';           // Req 2.3 — luôn keyed xác định
  const bucket = completeRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    completeRateBuckets.set(key, { count: 1, resetAt: now + COMPLETE_RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= COMPLETE_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}
```

Ghi chú: `checkStateRateLimit` hiện dùng `ip` trực tiếp làm key; ta thêm `|| 'unknown'` cho bản `/complete` để thoả Req 2.3. (Tùy chọn: đồng bộ cùng cách cho `/state` — nhưng đó là thay đổi ngoài phạm vi, để nguyên.)

### Mở rộng reset helper (Req 2.4)

```ts
export function __resetSetupRateLimitForTests(): void {
  stateRateBuckets.clear();
  completeRateBuckets.clear();            // thêm dòng này
}
```

Giữ nguyên tên hàm để không phá test hiện có; chỉ bổ sung clear bucket mới.

### Áp brake trong handler `/complete` (đầu handler, dòng 280)

```ts
setupRouter.post('/complete', async (c) => {
  const ip = extractClientIp(c.req.raw);
  if (!checkCompleteRateLimit(ip)) {
    return c.json(
      { errors: [{ code: 'RATE_LIMITED' }] },
      429,
      { 'retry-after': Math.ceil(COMPLETE_RATE_WINDOW_MS / 1000).toString() },
    );
  }

  // … luồng hiện tại giữ nguyên: parse JSON → safeParse → buildService → svc.complete …
  // (ctx.ip có thể tái dùng biến `ip` này thay vì gọi extractClientIp lần hai)
});
```

`ctx` ở dòng 312-316 hiện gọi `extractClientIp(c.req.raw)` lần nữa cho `SetupCompleteContext.ip`; tái dùng biến `ip` đã tính ở đầu để tránh gọi kép (tinh chỉnh nhỏ, không bắt buộc).

## Vì sao đặt brake trước `c.req.json()`

Mối đe doạ chính là **CPU exhaustion qua password hashing** và **brute-force setupToken**. Cả hai chỉ xảy ra *sau* khi vào `svc.complete`. Đặt brake ở dòng đầu tiên đảm bảo request bị chặn không tốn parse body lẫn hashing — đúng thứ tự Strapi #26494 mong muốn (chặn *trước* khi làm việc đắt).

## Ngưỡng: vì sao 10/phút

- `/state` là read rẻ → 60/phút.
- `/complete` là mutation one-shot đắt. Người dùng thật hiếm khi cần >10 lần thử/phút (sai password policy, thiếu token, typo email). 10/phút chặn brute-force token hiệu quả (một dictionary attack cần hàng nghìn req/phút) mà gần như không chạm người thật.
- Có thể hằng-số-hoá; **không** cần env-config ở bản này (giữ tối giản, nhất quán với `/state` vốn cũng hard-coded). Nếu sau này muốn chỉnh runtime, nâng cấp cả hai cùng lúc — ngoài scope.

## Giới hạn đã biết (ghi rõ, không giấu)

- **Per-isolate, không toàn cục**: giống `/state`, `Map` in-memory sống theo isolate. Trên Workers nhiều isolate hoặc Node nhiều instance, hạn mức thực = `Complete_Max × số_isolate`. Chấp nhận: đây là defence-in-depth cho một cửa sổ **one-shot ngắn** (chỉ tồn tại tới khi initialized), và DB lock/unique index vẫn là guard cứng chống tạo trùng admin. Một attacker vượt được brake per-isolate vẫn đâm vào state-machine 409/404.
- Không dùng `runtime.cache` (như `middleware/rate-limit.ts`) vì setup router cố tình tối giản middleware (chỉ `withDb()`), và cache-based limiter fail-open khi không có cache — không mong muốn cho endpoint bảo mật này. In-memory là lựa chọn có chủ đích, đồng nhất với `/state`.

## Không thay đổi

- `service.ts` (race guard, state-machine, hashing) — nguyên vẹn.
- Response 201/4xx/5xx của `/complete` — nguyên vẹn ngoài nhánh 429 mới.
- `checkStateRateLimit` và bucket `/state` — nguyên vẹn.
