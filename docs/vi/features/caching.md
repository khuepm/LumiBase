---
title: Caching
description: HTTP cache ở edge, CacheProvider tầng ứng dụng, và các lớp phòng thủ cache penetration
translatedFrom: en
sourceHash: 51a8d58a17e1a120
version: 1
lastUpdated: 2026-08-10T07:26:56.146Z
sourceLang: en
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-10T07:26:56.146Z
codeVerifiedHash: 51a8d58a17e1a120
codeVerifiedClaims: 16
---

# Caching

LumiBase cache trên ba tầng: HTTP/edge (`Cache-Control` + ETag trên Delivery API), application cache (`CacheProvider` — Workers KV hoặc Redis), và các process cache ngắn hạn. Invalidation theo tag ở những provider hỗ trợ (xem [ADR-004](../architecture/decisions/adr-004-tag-based-cache-invalidation.md)).

## URL media và lời hứa `immutable`

`Cache-Control: immutable` là một lời hứa không rút lại được. Một khi browser đã lưu response, không lệnh purge nào chạm tới được — không phải CDN purge, không phải `POST /api/v1/utils/cache/purge`, cũng không phải một lần deploy lại. Lời hứa đó chỉ đúng khi **URL** là hàm của **nội dung**, để bytes thay đổi thì phải đi qua một URL khác.

`POST /api/v1/media/:key` ghi đè tại chỗ dưới một key do client đặt, nên riêng key không phải là hàm đó. Vì vậy URL media mang một version pin tường minh:

| URL | `Cache-Control` |
|-----|-----------------|
| `/api/v1/media/logo.png` | `public, max-age=300, must-revalidate` |
| `/api/v1/media/logo.png?v=<contentHash>` (pin khớp bytes đang lưu) | `public, max-age=31536000, immutable` |
| `/api/v1/media/logo.png?v=<stale>` (pin đã cũ, không khớp) | `public, max-age=300, must-revalidate` |

Fingerprint được ghi vào metadata của storage (`contentHash`) lúc upload và trả về trong response upload dưới trường `version`. Một `GET` thường cũng báo giá trị này qua header `X-Lumi-Media-Version`, nên client dựng được URL có pin mà không cần thấy response upload. Response mang một `ETag` weak tính trên fingerprint và trả `304` cho `If-None-Match`.

Hai trường hợp có chủ đích không bao giờ nhận chính sách immutable:

- **Object không có fingerprint** — upload từ trước khi có trường này, hoặc ghi qua receiver dạng stream `PUT /api/v1/files/upload/:key` vốn không buffer body nên không hash được.
- **Đường transform redirect** (CF Image Resizing / Imgproxy) khi pin không kiểm được — ở đó source không bao giờ được đọc, nên pin được chấp nhận nguyên trạng còn URL không pin thì revalidate.

**Quy tắc cho endpoint mới:** nếu bạn không nói được thay đổi nội dung tương ứng với thay đổi URL nào, thì bạn không được dùng `immutable`. Hãy dùng `must-revalidate` kèm `ETag` — tốn một conditional request nhưng vẫn thu hồi được.

## Cache penetration

*Cache penetration* là trường hợp một key không tồn tại ở cả cache lẫn database — mọi request đều rơi xuống Postgres. Nó khác với *cache breakdown* (một hot key **có** dữ liệu hết hạn và dồn tải về origin) và khác với rate limiter chung của API đã xác thực.

Ba lớp phòng thủ xếp chồng trên các đường đọc công khai (`GET /api/v1/deliver/*`, tra cứu schema/collection):

1. **Shape guard** — kiểm regex/độ dài trên `site_id`, `slug`, và tên collection. Sai hình dạng trả **404** (không phải 400) với zero query DB, để endpoint không bị dùng làm oracle cho "hình dạng này hợp lệ". Ngoại lệ là header `X-Lumi-Site`: giá trị sai định dạng trả `400 TENANT_INVALID` vì client đã chủ động đặt header đó.
2. **Negative cache (tombstone)** — khi DB xác nhận không tồn tại, một tombstone ngắn hạn được ghi dưới `neg:${siteId}:${kind}:${id}` (TTL `LUMIBASE_NEGATIVE_CACHE_TTL`, mặc định 30s, jitter ±20%). Các lần dò lặp lại cùng một key thiếu sẽ được trả lời từ cache. Request có credential / preview không bao giờ đọc tombstone. Tạo resource sẽ xoá tombstone tương ứng ngay lập tức (TTL là lưới an toàn, không phải đường invalidate chính).
3. **Delivery IP rate limit** — `LUMIBASE_DELIVER_RATE_LIMIT` (mặc định 1200 req/phút/IP, `0` = tắt) trên `/api/v1/deliver/*`, khoá `rl:deliver:${ip}` (không có `siteId` — một IP tấn công N site dùng chung một budget). Vượt ngưỡng → `429` + `Retry-After` + `Cache-Control: no-store`. Request bị rate-limit không ghi tombstone.

### Vì sao không dùng Bloom filter?

Hoãn cho P0/P1:

- Dual-runtime: RedisBloom không có bản tương đương trên Cloudflare KV; một bitmap trên KV sẽ là read-modify-write và eventually consistent (~60s), có thể sinh lỗi đúng đắn (báo "không tồn tại" sai cho một resource vừa được tạo).
- Xoá buộc phải rebuild toàn bộ filter (Bloom filter chuẩn không xoá được phần tử).
- Với IP rate limit và TTL 30s, bộ nhớ tombstone sống theo mỗi IP là nhỏ.

**Mở lại khi:** đo được bộ nhớ tombstone vượt 5% `maxmemory` của Redis, hoặc một triển khai chỉ-Docker bỏ ràng buộc KV, hoặc tập tra cứu vượt ~10⁷ key.

### Observability

Counter Prometheus:

- `lumibase_cache_negative_hits_total` — số lần đọc được trả lời từ tombstone
- `lumibase_cache_negative_writes_total` — số tombstone được ghi sau một miss đã xác nhận

Giữ hai chỉ số này tách khỏi hit/miss dương để người vận hành phân biệt được "hit vì ta có dữ liệu" với "hit vì ta đã biết là nó không tồn tại".

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `LUMIBASE_NEGATIVE_CACHE_TTL` | `30` | TTL tombstone tính bằng giây, trước khi áp jitter ±20%. `0` tắt tombstone. |
| `LUMIBASE_DELIVER_RATE_LIMIT` | `1200` | Số request Delivery API tối đa mỗi phút cho mỗi IP client. `0` tắt. |

Đánh đổi: TTL tombstone ngắn nghĩa là một page vừa tạo vẫn có thể 404 trong khoảng ~TTL nếu đường ghi không `forget` được tombstone. Hãy sửa forget hook thay vì nâng TTL. Tạo page / đổi slug đi qua `POST|PATCH /api/v1/pages` (`PageService`), nơi gọi `forgetNegative` cho slug mới và cho slug cũ khi đổi tên.

## Multi-tenancy

Khoá cache penetration theo đúng cách chia shared-vs-isolated như phần còn lại của cache stack (design §17):

| Resource | Phạm vi | Khoá / hành vi | Vì sao |
|----------|---------|----------------|--------|
| Tombstone page / collection / item | **Cô lập** | `neg:${siteId}:page:${slug}`, `neg:${siteId}:collection:${name}`, `neg:${siteId}:item:${collection}:${id}` | Dữ liệu tenant — Property P20 khẳng định tombstone của site A không bao giờ ảnh hưởng site B |
| Tombstone cấp site (llms.txt) | **Cô lập (phẳng)** | `neg:site:${siteId}` | Bản thân khoá *là* site id; không có tenant cha để lồng vào |
| Delivery rate limit | **Chia sẻ theo IP** | `rl:deliver:${ip}` | Công khai, không xác thực. Cố ý **không** tách theo site để một IP tấn công N site dùng chung một budget (cùng tiền lệ với `rl:recovery:${ip}`) |
| Shape guard | n/a | Thuần regex, không lưu trữ | Cùng body/header 404 như một miss thật — không bao giờ là oracle cho hình dạng hợp lệ |

**Kiểm chứng thế nào:** Properties P17–P20 mức unit/integration trong `apps/cms/src/__tests__/cache-penetration.test.ts` (cô lập tombstone hai site + bypass khi có credential); wiring tripwire cho `withDeliverRateLimit` trong `security-guards.wiring.test.ts`.
