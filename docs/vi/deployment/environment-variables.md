# Biến môi trường

## Runtime CMS

| Biến | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `LUMIBASE_ENV` | Có | Nhãn môi trường như `development`, `staging`, `production`. |
| `LUMIBASE_RUNTIME` | Chỉ Docker | Đặt `docker` khi chạy Node.js self-hosted. Workers suy ra runtime từ binding. |
| `LUMIBASE_DEV_AUTH` | Chỉ local | Chỉ bật `true` khi phát triển local. Không bật ở production. |
| `LLM_PROVIDER` | Tùy chọn | Provider AI: `echo`, `openai`, `anthropic`, `claude`, `gemini`, `workers-ai`. Mặc định `echo` để test không tốn phí. |
| `LLM_MODEL` | Tùy chọn | Model override theo provider, ví dụ `gpt-4.1-nano`, `claude-3-5-haiku-latest`, `gemini-3.5-flash`. |
| `OPENAI_API_KEY` | Khi dùng `openai` | API key OpenAI. |
| `ANTHROPIC_API_KEY` | Khi dùng `anthropic`/`claude` | API key Anthropic. |
| `GEMINI_API_KEY` | Khi dùng `gemini` | API key Google Gemini. |
| `JWT_SECRET` | Có | Secret cho JWT ứng dụng. Lưu bằng secret store. |
| `CF_ACCESS_CERTS_URL` | Production admin auth | JWKS URL của Cloudflare Access. |
| `CF_ACCESS_AUDIENCE` | Production admin auth | Audience của Cloudflare Access application. |
| `LUMIBASE_REALTIME_ENABLED` | Tuỳ chọn | Kill switch realtime cấp deploy. Đặt `false` để tắt WebSocket dù site setting đang bật. |

## Pressure limiter (Docker / Node.js)

CMS chạy bằng Docker có cơ chế bảo vệ quá tải cho event loop Node.js. Khi bật và process bị nghẽn, API sẽ trả nhanh HTTP `503` với envelope `SERVICE_UNAVAILABLE`, header `Retry-After` và `X-Lumi-Overload` thay vì để request xếp hàng đến lúc container mất phản hồi. Mặc định `/health` và `/metrics` được bỏ qua để vẫn kiểm tra được tình trạng instance.

| Biến | Bắt buộc | Mặc định | Ghi chú |
| --- | --- | --- | --- |
| `LUMIBASE_PRESSURE_LIMITER_ENABLED` | Chỉ Docker | `true` | Bật guard quá tải Node.js. Chỉ đặt `false` tạm thời khi đang scale hoặc tối ưu endpoint gây nghẽn. |
| `LUMIBASE_PRESSURE_LIMITER_SAMPLE_INTERVAL` | Tùy chọn | `250` | Chu kỳ đo pressure, đơn vị mili giây. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY` | Tùy chọn | `1000` | Độ trễ event loop tối đa, đơn vị mili giây, trước khi API trả `503`. Đặt `false` để tắt ngưỡng này. |
| `LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION` | Tùy chọn | `false` | Ngưỡng utilization tùy chọn, ví dụ `0.99`. Mặc định tắt để tránh reject nhầm khi CPU đang bận nhưng vẫn xử lý hữu ích. |
| `LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER` | Tùy chọn | `5` | Số giây ghi trong header `Retry-After`. |
| `LUMIBASE_PRESSURE_LIMITER_EXCLUDED_PATHS` | Tùy chọn | `/health,/metrics` | Danh sách prefix phân tách bằng dấu phẩy vẫn được phục vụ khi guard phát hiện quá tải. |

## GraphQL

Mọi operation GraphQL đều được validate trước khi chạy, đối chiếu với một giới hạn độ sâu và một giới hạn chi phí tĩnh, từ chối các query sâu hoặc rộng bất thường ngay ở tầng parse (CWE-770). Độ sâu là hằng số compile-time (12); chi phí thì tinh chỉnh được. Tăng `LUMIBASE_GQL_MAX_COST` nếu một query hợp lệ bị từ chối. Xem [`graphql-api-spec.md`](../api/graphql-api-spec.md#chống-lạm-dụng).

| Biến | Bắt buộc | Mặc định | Ghi chú |
| --- | --- | --- | --- |
| `LUMIBASE_GQL_MAX_COST` | Tùy chọn | `1000` | Chi phí tĩnh tối đa chấp nhận cho mỗi operation. |
| `LUMIBASE_GQL_DEFAULT_LIST_SIZE` | Tùy chọn | `20` | Hệ số nhân chi phí cho một list field không có argument phân trang literal (hoặc là variable). |
| `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` | Tùy chọn | `100` | Trần clamp cho hệ số nhân chi phí của một list field bất kỳ. |

## Binding Cloudflare

| Binding | Loại | Mục đích |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive | Pool kết nối PostgreSQL cho Worker. |
| `CONFIG_CACHE` | KV | Cache schema, permission và settings. |
| `MEDIA` | R2 | Lưu media. |
| `SITE_ROOM` | Durable Object | Điều phối realtime theo từng site. |

Không commit secret production. Dùng Wrangler secrets cho Workers và secret store riêng cho Docker.
