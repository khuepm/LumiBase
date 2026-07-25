# Tham chiếu biến môi trường

> **Dành cho AI agent:** Mọi biến bắt buộc phải được đặt trước khi khởi động CMS API. Thiếu biến bắt buộc sẽ khiến quá trình khởi động thất bại kèm thông báo lỗi rõ ràng.

Trang này liệt kê mọi biến môi trường và binding Cloudflare mà LumiBase sử dụng.

---

## Runtime lõi

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `LUMIBASE_ENV` | ✓ | — | Nhãn môi trường: `development`, `staging`, `production` |
| `LUMIBASE_RUNTIME` | Chỉ Docker | `cloudflare` | `docker` cho Node.js/Docker; Cloudflare Workers tự suy ra từ binding |
| `JWT_SECRET` | ✓ | — | Secret để ký/xác thực JWT ứng dụng. Tối thiểu 32 ký tự. **Với production Cloudflare, đặt bằng `wrangler secret put JWT_SECRET --env production`; không bao giờ commit hay đặt trong `[env.production.vars]`.** |
| `LUMIBASE_DEV_AUTH` | Chỉ local dev | `false` | Đặt `true` để bỏ qua auth Logto trong local dev. **Không bao giờ bật ở production; `pnpm release:check` sẽ fail nếu production resolve thành `true`.** |
| `LUMIBASE_REALTIME_ENABLED` | ✗ | `true` | Đặt `false` để tắt WebSocket ở mức deployment |
| `LUMIBASE_ADMIN_PATH` | ✗ | (ngẫu nhiên) | Path tùy chỉnh cho Studio admin panel (bảo mật qua obscurity) |
| `VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT` | Chỉ setup/debug | `false` | Opt-in phía client cho phép redirect tiện lợi tới admin path riêng tư. Giữ không đặt ở production, trừ một cửa sổ setup/debug tạm thời có kiểm soát. |

Admin path là trạng thái vận hành riêng tư. Không phơi bày qua biến môi trường `VITE_*` hay client build metadata, và không tự động redirect các route public/setup tới nó ở production. Xem [Admin path riêng tư](./private-admin-path.md).

---

## Xác thực (Logto)

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `LOGTO_ENDPOINT` | ✓ | URL instance Logto (vd `https://your-tenant.logto.app`) |
| `LOGTO_APP_ID` | ✓ | ID ứng dụng Logto |
| `LOGTO_APP_SECRET` | ✓ | Secret ứng dụng Logto |
| `LOGTO_JWKS_URI` | ✗ | Override URL JWKS (tự suy từ `LOGTO_ENDPOINT` nếu không đặt) |
| `CF_ACCESS_CERTS_URL` | Chỉ CF Access | URL JWKS Cloudflare Access cho auth admin tunnel |
| `CF_ACCESS_AUDIENCE` | Chỉ CF Access | Audience tag của ứng dụng Cloudflare Access |

---

## Cơ sở dữ liệu

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `DATABASE_URL` | Chỉ Docker | Chuỗi kết nối PostgreSQL (vd `postgres://user:pass@host:5432/lumibase`) |
| `DATABASE_POOL_MIN` | ✗ | Số kết nối pool DB tối thiểu (mặc định: `2`) |
| `DATABASE_POOL_MAX` | ✗ | Số kết nối pool DB tối đa (mặc định: `10`) |
| `DATABASE_SSL` | ✗ | `true` để bắt buộc SSL cho kết nối DB |

Với Cloudflare Workers, dùng binding `HYPERDRIVE` (xem [Binding Cloudflare](#binding-cloudflare)).

---

## Cache

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `REDIS_URL` | Chỉ Docker | Chuỗi kết nối Redis (vd `redis://localhost:6379`) |
| `CACHE_TTL_SCHEMA` | ✗ | TTL cache schema, đơn vị giây (mặc định: `60`) |
| `CACHE_TTL_PERMISSIONS` | ✗ | TTL cache permission, đơn vị giây (mặc định: `300`) |
| `CACHE_TTL_SETTINGS` | ✗ | TTL cache settings, đơn vị giây (mặc định: `60`) |

---

## Lưu trữ object

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `S3_ENDPOINT` | Chỉ Docker/S3 | URL endpoint tương thích S3 (vd MinIO: `http://localhost:9000`) |
| `S3_ACCESS_KEY_ID` | Chỉ Docker/S3 | Access key S3 |
| `S3_SECRET_ACCESS_KEY` | Chỉ Docker/S3 | Secret key S3 |
| `S3_BUCKET` | Chỉ Docker/S3 | Tên bucket lưu trữ (mặc định: `lumibase-media`) |
| `S3_REGION` | ✗ | Region S3 (mặc định: `us-east-1`) |
| `S3_PUBLIC_URL` | ✗ | Base URL công khai cho asset (vd URL CDN trỏ tới bucket) |

---

## Tìm kiếm (MeiliSearch)

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `MEILISEARCH_URL` | Nếu bật search | URL instance MeiliSearch |
| `MEILISEARCH_API_KEY` | Nếu bật search | Master key hoặc search API key của MeiliSearch |

---

## AI Copilot

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `LLM_PROVIDER` | ✗ | Provider LLM: `openai`, `anthropic`, `claude`, `gemini`, `nvidia`, `vertex`, `workers-ai`, `echo` (mặc định: `echo`) |
| `OPENAI_API_KEY` | Nếu provider `openai` | API key OpenAI |
| `ANTHROPIC_API_KEY` | Nếu provider `anthropic` / `claude` | API key Anthropic |
| `GEMINI_API_KEY` | Nếu provider `gemini` | API key Google Gemini |
| `NVIDIA_API_KEY` | Nếu provider `nvidia` | Key hosted-inference NVIDIA (build.nvidia.com / NIM). Tính phí bởi NVIDIA. |
| `NVIDIA_BASE_URL` | ✗ | Override endpoint NVIDIA — vd một container NIM self-host (`http://nim:8000/v1`). Mặc định `https://integrate.api.nvidia.com/v1`. |
| `VERTEX_ACCESS_TOKEN` | Nếu provider `vertex` | Bearer OAuth 2.0 Google Cloud (`gcloud auth print-access-token`). Token hết hạn (~1h). **Tính phí vào Google Cloud, không phải AWS.** |
| `VERTEX_PROJECT_ID` | Nếu provider `vertex` | ID project Google Cloud sở hữu các model Vertex AI. |
| `VERTEX_LOCATION` | ✗ | Region Vertex AI (mặc định: `us-central1`). |
| `LLM_MODEL` | ✗ | Override tên model (vd `gpt-4.1-nano`, `claude-3-5-haiku-latest`, `gemini-3.5-flash`, `meta/llama-3.1-8b-instruct`) |
| `WORKERS_AI_GATEWAY` | Chỉ Workers AI | URL gateway CF Workers AI |

> **Provider ↔ billing:** `nvidia` và `vertex` gọi các cloud *bên ngoài* — lần lượt là NVIDIA và Google Cloud — nên usage của chúng **không** được tính vào credit AWS. `nvidia` (hoặc NIM self-host qua `NVIDIA_BASE_URL`) và MeiliSearch là các phần ăn khớp tự nhiên với hạ tầng host trên AWS.

---

## Email (Resend)

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `RESEND_API_KEY` | Nếu bật email | API key Resend cho email giao dịch |
| `EMAIL_FROM` | Nếu bật email | Địa chỉ người gửi (vd `noreply@yourdomain.com`) |

---

## SCIM provisioning

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `SCIM_TOKEN` | Nếu bật SCIM | Bearer token xác thực endpoint `/scim/v2/` |

---

## Pressure limiter (Docker / Node.js)

CMS chạy bằng Docker có cơ chế bảo vệ quá tải cho event loop Node.js. Khi bật và process bị nghẽn, API sẽ trả nhanh HTTP `503` với envelope `SERVICE_UNAVAILABLE`, header `Retry-After` và `X-Lumi-Overload` thay vì để request xếp hàng đến lúc container mất phản hồi. Mặc định `/health` và `/metrics` được bỏ qua để vẫn kiểm tra được tình trạng instance.

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `LUMIBASE_PRESSURE_LIMITER_ENABLED` | Chỉ Docker | `true` | Bật guard quá tải Node.js. Chỉ đặt `false` tạm thời khi đang scale hoặc tối ưu endpoint gây nghẽn. |
| `LUMIBASE_PRESSURE_LIMITER_SAMPLE_INTERVAL` | ✗ | `250` | Chu kỳ đo pressure, đơn vị mili giây. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY` | ✗ | `1000` | Độ trễ event loop tối đa, đơn vị mili giây, trước khi API trả `503`. Đặt `false` để tắt ngưỡng này. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION` | ✗ | `false` | Ngưỡng utilization tùy chọn, ví dụ `0.99`. Mặc định tắt để tránh reject nhầm khi CPU đang bận nhưng vẫn xử lý hữu ích. |
| `LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER` | ✗ | `5` | Số giây ghi trong header `Retry-After`. |
| `LUMIBASE_PRESSURE_LIMITER_EXCLUDED_PATHS` | ✗ | `/health,/metrics` | Danh sách prefix phân tách bằng dấu phẩy vẫn được phục vụ khi guard phát hiện quá tải. |

---

## Rate limiting

Một throttle cửa sổ-cố-định bảo vệ API đã xác thực. Nó key theo principal (user → API key → IP) và scope theo site. Khi vượt ngưỡng, nó trả HTTP `429` với envelope `RATE_LIMITED` kèm `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, và `Retry-After`. Nó fail open nếu cache không khả dụng, nên là defence-in-depth chứ không phải quota cứng.

Import lớn có thể chạm ngân sách mặc định. Tăng `LUMIBASE_RATE_LIMIT_MAX` và ưu tiên endpoint bulk — xem [Nhập dữ liệu](../features/data-import.md).

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `LUMIBASE_RATE_LIMIT_MAX` | ✗ | `300` | Số request tối đa mỗi cửa sổ, mỗi principal, mỗi site. |
| `LUMIBASE_RATE_LIMIT_WINDOW_S` | ✗ | `60` | Độ dài cửa sổ, đơn vị giây. |
| `LUMIBASE_RATE_LIMIT_DISABLED` | ✗ | (không đặt) | Đặt `true` để tắt hẳn throttle. |

---

## GraphQL

Mọi operation GraphQL đều được validate trước khi chạy, đối chiếu với một giới hạn độ sâu và một giới hạn chi phí tĩnh, từ chối các query sâu hoặc rộng bất thường ngay ở tầng parse (CWE-770). Độ sâu là hằng số compile-time (12); chi phí thì tinh chỉnh được. Tăng `LUMIBASE_GQL_MAX_COST` nếu một query hợp lệ bị từ chối. Xem [`graphql-api-spec.md`](../api/graphql-api-spec.md#chống-lạm-dụng).

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `LUMIBASE_GQL_MAX_COST` | ✗ | `1000` | Chi phí tĩnh tối đa chấp nhận cho mỗi operation. |
| `LUMIBASE_GQL_DEFAULT_LIST_SIZE` | ✗ | `20` | Hệ số nhân chi phí cho một list field không có argument phân trang literal (hoặc là variable). |
| `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` | ✗ | `100` | Trần clamp cho hệ số nhân chi phí của một list field bất kỳ. |

---

## Observability

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `PROMETHEUS_ENABLED` | Chỉ Docker | `true` để phơi bày endpoint `/metrics` |
| `LOG_LEVEL` | ✗ | Mức log: `debug`, `info`, `warn`, `error` (mặc định: `info`) |
| `LOG_FORMAT` | ✗ | `json` (mặc định) hoặc `pretty` (local dev) |

---

## Binding Cloudflare

Cấu hình các binding này trong `apps/cms/wrangler.toml` (không phải biến môi trường):

| Binding | Loại | Mục đích |
|---------|------|----------|
| `HYPERDRIVE` | Hyperdrive | Pool kết nối PostgreSQL |
| `CONFIG_CACHE` | KV Namespace | Cache schema, permission và settings |
| `MEDIA` | R2 Bucket | Lưu trữ object media/file |
| `SITE_ROOM` | Durable Object | Điều phối WebSocket theo từng site (realtime) |
| `AI` | Workers AI | Binding Workers AI cho provider LLM `workers-ai` |

```toml
# trích wrangler.toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your-hyperdrive-id>"

[[kv_namespaces]]
binding = "CONFIG_CACHE"
id = "<your-kv-namespace-id>"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "lumibase-media"

[durable_objects]
bindings = [{ name = "SITE_ROOM", class_name = "SiteRoom" }]
```

---

## Checklist bảo mật

Trước khi deploy lên production, xác minh:

- [ ] `JWT_SECRET` dài ít nhất 32 ký tự và lưu dưới dạng Wrangler Secret hoặc Docker secret
- [ ] `LUMIBASE_DEV_AUTH` KHÔNG được đặt `true`
- [ ] Credential database lưu dưới dạng secret, không nằm trong file `.env` commit vào git
- [ ] `S3_SECRET_ACCESS_KEY` lưu dưới dạng secret
- [ ] `RESEND_API_KEY` lưu dưới dạng secret
- [ ] CORS được cấu hình chỉ cho phép domain Studio và consumer của bạn
