---
title: Caching
description: HTTP cache ở edge, CacheProvider tầng ứng dụng, và các lớp phòng thủ cache penetration
translatedFrom: en
sourceHash: 218e2a3a0ef0179c
version: 4
lastUpdated: 2026-08-10T20:04:00.102Z
sourceLang: en
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-10T20:04:00.102Z
codeVerifiedHash: 218e2a3a0ef0179c
codeVerifiedClaims: 16
---

# Caching

LumiBase cache trên ba tầng: HTTP/edge (`Cache-Control` + ETag trên Delivery API), application cache (`CacheProvider` — Workers KV hoặc Redis), và các process cache ngắn hạn. Invalidation theo tag ở những provider hỗ trợ (xem [ADR-004](../architecture/decisions/adr-004-tag-based-cache-invalidation.md)).

## Invalidation đi được tới đâu

Một request được trả lời bởi tầng đầu tiên có sẵn dữ liệu, và trên đường về mỗi tầng giữ lại một bản. Vì vậy "xoá cache" bắt buộc phải nói rõ **tầng nào** — tag purge chạm đúng một tầng, còn các tầng phía trước nó tự hết hạn theo đồng hồ riêng:

| Tầng | Ai giữ bản sao | Thu hồi bằng cách nào | Stale tối đa |
|------|----------------|------------------------|--------------|
| Browser | Cache của chính người dùng | **Không gì chạm tới được.** Phải đổi URL — xem mục phía trên | Bằng đúng `max-age` bạn đã hứa |
| CDN / edge | `EdgeCacheProvider` (`caches.default` trên Workers; no-op trên Docker) | `purge({urls, tags})` — purge theo tag, lùi về theo URL; xem bên dưới | `s-maxage` (mặc định 60s) khi không purge được |
| Reverse proxy | Caddy | Không phải cache — chỉ proxy, không cấu hình directive cache nào | n/a |
| In-process | `withProcessCache` cho permission bundle, cộng map single-flight trong `createSwrCache` | Không invalidate — entry chỉ chạm tới được qua key có version, nên bump version làm nó thành không địa chỉ hoá được | TTL 5s trong process |
| Application cache | `CacheProvider` — Redis hoặc Workers KV | `invalidateByTag`, `POST /api/v1/utils/cache/purge` | Tức thì với Redis; KV eventually consistent (~60s) |
| Database | Buffer pool Postgres, page cache OS | Không thuộc quyền quản lý của ta | n/a |

**Tầng browser không có kênh thu hồi nào cả**, do bản chất HTTP. Đó là lý do quy tắc `immutable` phía trên là một luật chứ không phải một sở thích.

### Purge tầng edge

Purge theo tag là một lời gọi bất kể bao nhiêu URL bị ảnh hưởng, và nó chạm được cả những bản mà tiến trình này chưa từng ghi lại. Purge theo URL không cần CDN hỗ trợ tag, nhưng chỉ chạm được những gì ta đã index. Việc một tài khoản có làm được cách thứ nhất hay không thì code không nhìn thấy, nên LumiBase không bắt bạn cấu hình câu trả lời — nó thử tag trước rồi tự lùi:

1. Mỗi response delivery công khai mang `Cache-Tag: deliver:<siteId>, items:<siteId>:<collection>` và ghi URL của nó dưới đúng các tag đó trong `edgeurls:<tag>` — giới hạn 200 URL mỗi tag.
2. Một lần ghi gọi `invalidateItemsTag` / `invalidateDeliverTag`, hàm này đọc danh sách đó và đưa **cả tag lẫn URL** cho `EdgeCacheProvider.purge()`.
3. Provider xoá colo cục bộ qua `caches.default.delete`, rồi — khi có `CF_PURGE_ZONE_ID` + `CF_PURGE_API_TOKEN` — gọi zone purge API bằng **tag**, và chỉ khi lời gọi đó bị từ chối mới thử lại bằng danh sách **URL**, theo lô 30.

Chính cơ chế lùi này là lý do index URL tồn tại. Ở nơi purge theo tag chạy được, index là thừa; ở nơi không chạy được, nó là toàn bộ cơ chế.

Không có hai biến đó thì purge tụt xuống mức colo-local, và đấy **không phải** invalidate toàn cầu: các PoP khác vẫn phục vụ bản cũ tới hết `s-maxage`. Hãy cấu hình chúng cho mọi triển khai mà một lần sửa nội dung phải tới đích nhanh hơn cửa sổ `s-maxage`.

Mọi thứ trên đường này đều degrade an toàn. Mất một entry index, token hết hạn, purge API trả 403 — mỗi trường hợp đều lùi về hành vi cũ (hết hạn theo `s-maxage`) và không trường hợp nào làm hỏng lần ghi đã kích hoạt purge. `lumibase_cache_operations_total{op="purgeEdge"}` tách `ok` khỏi `error` để nhìn ra khác biệt đó.

| Biến | Ý nghĩa |
|------|---------|
| `CF_PURGE_ZONE_ID` | Zone id Cloudflare cho purge edge toàn cầu. Vắng → chỉ purge colo cục bộ. |
| `CF_PURGE_API_TOKEN` | API token có quyền `Cache Purge` trên zone đó. |

### Tầng in-process

Một hit ở Redis hay Workers KV vẫn tốn một round-trip mạng; hit trong bộ nhớ process thì không. `withProcessCache` giữ giá trị đã giải mã ngay trong isolate đã tính ra nó, đứng trước shared cache.

Hiện chỉ áp cho **một** thứ: compiled permission bundle, thứ được đọc ở gần như mọi request đã xác thực. Hai quy tắc làm cho việc đó an toàn, và cả hai đều chịu lực:

- **Chỉ những key mang segment version.** `perm:{site}:v{n}:{principal}` trỏ tới một giá trị bất biến — đổi quyền thì bump pointer, lần đọc kế tiếp trỏ sang key khác, và entry cũ không bao giờ được đọc lại. Không gì ở tầng này invalidate được xuyên instance, nên tuyệt đối không bọc một key mà giá trị của nó đổi được ngay dưới chân.
- **Tuyệt đối không cache chính version pointer.** Pointer đó được đọc từ shared cache ở mọi request. Cache nó lại sẽ làm việc thu hồi quyền chậm đi đúng bằng TTL của process, tức phá đúng cái bảo đảm mà key versioning sinh ra để giữ (Property P9: thu hồi → request kế tiếp bị từ chối, không phải chờ hết TTL). Một lần đọc mạng mỗi request chính là cái giá của bảo đảm đó.

Store nằm ở cấp module và có chặn trên (256 entry, TTL 5s). Cả hai đều quan trọng: store theo từng request sẽ không bao giờ hit, còn store không chặn thì rò rỉ — process Docker sống lâu, và isolate Workers được tái dùng cho request của **nhiều tenant khác nhau**. Mọi key đều mang `siteId`, nên không tầng nào phía trên phải tách tenant hộ.

`lumibase_cache_operations_total{backend="process"}` báo hit và miss, nên việc tầng này có đáng giữ hay không là thứ đo được chứ không phải tin.

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
