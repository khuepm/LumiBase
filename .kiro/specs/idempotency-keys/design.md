# Design Document — Idempotency Keys

## 1. Vì sao bài toán "duplicate payment charge" áp vào LumiBase

Bài gốc mô tả pattern cho payment API, nhưng bản chất là: **mutation có side-effect + client retry khi không chắc request đã tới server**. LumiBase gặp đúng cấu hình đó ở ba lớp:

| Lớp | Endpoint | Side-effect khi double-execute |
|---|---|---|
| Content | `POST /items/:collection`, `/bulk` | Duplicate item (id `nanoid()`, không có natural key để DB tự chặn) |
| External ops | `POST /deployments/targets/:id/deploy` | Hai build trên Vercel/Netlify — không huỷ được, tốn quota, tương tự "charge" |
| Automation | flow run / agent run / AI skill execute | Email gửi 2 lần, webhook bắn 2 lần, git commit đôi |

Những chỗ đã idempotent sẵn (inbound webhook theo delivery-id, sweep conditional-update, vote unique-index) **không** cần cơ chế này — chúng có natural key. Cơ chế mới nhắm vào mutation **không có natural key**.

## 2. Điểm lấy từ bài viết vs. điểm chỉnh cho LumiBase

Giữ nguyên 3 nguyên tắc contract (client-generated key, execute-once-per-key, chống concurrent same-key). Chỉnh hai điểm khi hiện thực:

1. **Store = Postgres, không phải `runtime.cache`.** Sơ đồ phổ biến vẽ Idempotency Store là Redis/cache tách rời. Với LumiBase điều đó tạo dual-write: handler ghi domain data vào Postgres nhưng ghi key vào KV/Redis — crash giữa hai bước → retry MISS → double-execute. Bảng `idempotency_keys` nằm cùng database, response được persist trong **cùng transaction** với domain write khi handler dùng transaction. Đây là ngoại lệ có chủ đích của rule "runtime abstraction cho cache": idempotency record là dữ liệu đúng đắn, không phải cache có thể mất.
2. **Concurrency control bằng unique index + claim, không lock in-memory.** Dual deployment (CF Workers + Docker) nghĩa là nhiều instance không chia sẻ memory; nguồn sự thật duy nhất hai bên cùng thấy là Postgres.

## 3. Schema (`packages/database/src/schema/platform.ts` hoặc file mới `idempotency.ts`)

```ts
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: text('id').primaryKey(),                    // nanoid() — quy ước domain table
  siteId: text('site_id').notNull(),              // rule multi-tenancy
  scope: text('scope').notNull(),                 // `user:<id>` | `apikey:<id>`
  key: text('key').notNull(),                     // client-provided, ≤255
  fingerprint: text('fingerprint').notNull(),     // sha256(method + path + rawBody)
  status: text('status').notNull().default('running'), // 'running' | 'completed'
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),   // createdAt + 24h
}, (t) => [
  uniqueIndex('idempotency_site_scope_key_unique').on(t.siteId, t.scope, t.key),
  index('idempotency_expires_idx').on(t.expiresAt),
]);
```

Migration: viết tay `packages/database/drizzle/0012_idempotency_keys.sql` (số kế tiếp 0011) + entry `_journal.json`, kèm RLS policy site-scoped bổ sung vào `rls-policies.sql`.

## 4. Middleware (`apps/cms/src/middleware/idempotency.ts`)

Vị trí trong chain: `logger → runtime → cors → tenant → auth → db → rls → **idempotency** → handler`, gắn per-route (Req 5.2 — registry tập trung).

Luồng:

```
header vắng ──────────────────────────────► pass-through (Req 1.5)
header có:
  validate key (1–255) ─ sai ─► 422 VALIDATION_ERROR
  fingerprint = sha256(method|path|rawBody)
  INSERT (site, scope, key, fingerprint, status='running')
         ON CONFLICT DO NOTHING RETURNING id
  ├─ claim thành công (MISS) ─► await next()
  │     handler OK  ─► UPDATE row: status='completed', responseStatus, responseBody
  │     handler 5xx/throw ─► DELETE row (giải phóng cho retry — Req 1.4)
  └─ conflict (đã có row) ─► SELECT row
        fingerprint khác     ─► 422 IDEMPOTENCY_KEY_REUSED
        status='running'     ─► 409 IDEMPOTENCY_CONFLICT + Retry-After: 2
        status='completed'   ─► replay responseStatus/responseBody
                                 + Idempotency-Replayed: true
```

Chi tiết:

- **Raw body**: middleware đọc `c.req.raw.clone()` để tính fingerprint mà không tiêu thụ body của handler.
- **Chỉ persist response 2xx/4xx**; 4xx deterministic (validation…) được replay y hệt — nhất quán với Stripe. 5xx không lưu (Req 1.4).
- **Cùng transaction (điểm Brandur):** với handler đã dùng `db.transaction`, v1 chấp nhận persist response ở bước UPDATE sau handler — khoảng hở crash-giữa-chừng được Req 1.4 xử lý bằng re-execute, an toàn với domain write trong-DB (transaction rollback rồi). Với side-effect NGOÀI DB (deploy trigger), khoảng hở này nghĩa là "external call xong nhưng chưa persist response" → v2 recovery-point (mục 7).
- Response replay giữ contract `{ data } / { errors }`; middleware chỉ replay byte đã lưu.

## 5. Prune worker

Theo pattern `retention.ts` / `scheduler-worker.ts` hiện có: sweep định kỳ `DELETE FROM idempotency_keys WHERE expires_at < now() LIMIT batch` — idempotent, batch-bounded, chạy trong tick scheduler hiện hữu (không cần queue mới).

## 6. SDK & Studio

- `packages/sdk`: các method mutation nhận `options.idempotencyKey?`; mặc định tự sinh `crypto.randomUUID()` **một lần per logical call** và tái sử dụng trong vòng retry nội bộ của SDK.
- Studio: mutation tạo item / trigger deploy sinh key tại thời điểm user bấm (useRef/useMemo per submit), truyền qua SDK — bấm lại nút khi đang pending không tạo bản ghi thứ hai.

## 7. V2 (ngoài phạm vi, ghi để không quên) — Recovery points

Với multi-step external side-effect (deploy: tạo record → gọi provider → lưu provider-deploy-id), pattern Brandur đầy đủ: cột `recovery_point`, mỗi "atomic phase" là một transaction, retry resume từ phase dở dang thay vì all-or-nothing. V1 chỉ cần: deploy handler ghi provider deployment id vào DB ngay khi provider trả về (đã có `deployment-service.ts` sync theo id — [Inference] cần xác nhận chi tiết khi implement). Đăng ký vào `.kiro/steering/out-of-scope-backlog.md`.

## 8. Bảng hành vi (đưa vào docs)

| Tình huống | Kết quả |
|---|---|
| MISS (key mới) | Execute; lưu response |
| HIT completed, cùng fingerprint | Replay + `Idempotency-Replayed: true` |
| HIT running (song song) | 409 `IDEMPOTENCY_CONFLICT` + `Retry-After` |
| HIT, khác fingerprint | 422 `IDEMPOTENCY_KEY_REUSED` |
| Lần trước 5xx | Key đã giải phóng → re-execute |
| Key hết TTL (24h) | Coi như mới → re-execute |
| Không gửi header | Hành vi cũ, không idempotency |

## 9. Test plan

- Unit middleware: đủ 7 nhánh bảng trên.
- Property test (pattern repo): với mọi chuỗi retry N lần cùng key → đúng 1 lần handler chạy, N−1 lần replay, response byte-identical.
- Race test (db integration): 2 request song song cùng key → 1 claim + 1 nhận 409 (dựa unique index, chạy trên Postgres thật như `*.db.integration.test.ts` hiện có).
- Tenant isolation: cùng key khác site/scope → hai entry độc lập.
- Prune: hết hạn bị xoá, chưa hết hạn giữ nguyên, chạy hai lần idempotent.
