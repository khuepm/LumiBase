---
version: 3
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
lastUpdated: 2026-11-15T11:57:28.932Z
sourceHash: 9863d4c9c17ad1fa
codeVerified: 2026-11-15T11:57:28.932Z
codeVerifiedHash: 9863d4c9c17ad1fa
codeVerifiedClaims: 8
---

# Trường geopoint và bố cục Map

Một trường `geopoint` lưu một vị trí cho mỗi item: vĩ độ và kinh độ theo độ
WGS 84. Studio chỉnh nó trên bản đồ, API lọc theo bán kính hoặc theo khung bao,
và collection có trường geopoint được thêm bố cục **Map** trong danh sách item.
Tính năng chạy trên Postgres thường — Cloudflare Workers (Hyperdrive) lẫn
Docker — và tự dùng PostGIS khi extension đã được cài.

## Giá trị

```json
{ "loc": { "lat": 21.0285, "lng": 105.8542 } }
```

| Quy tắc | Chi tiết |
|---------|----------|
| Dạng | Đúng `{ lat, lng }`. Khóa thừa, mảng, chuỗi và GeoJSON bị từ chối khi ghi. |
| Phạm vi | `lat` trong [-90, 90], `lng` trong [-180, 180], cả hai là số hữu hạn. |
| Mảng | Mọi dạng mảng đều đặt kinh độ trước, như GeoJSON và PostGIS (xem `_within_bbox`). |
| Thiếu | Một geopoint không bắt buộc có thể là `null`. |

Tạo trường với `type: "geopoint"` và `interface: "geopoint"` (Studio:
**Data model → field → Special → Geopoint**). Các định nghĩa dùng chung — kiểu
`GeoPoint`, các schema zod và hàm haversine — nằm trong
`packages/contracts/src/field/geopoint.ts` và
`packages/contracts/src/schemas/geopoint.ts`, nên API, Studio và SDK kiểm tra
hợp lệ theo cùng một cách.

## Lọc

Hai toán tử, đặt dưới khóa của trường như mọi toán tử lọc khác:

| Toán tử | Toán hạng | Khớp |
|---------|-----------|------|
| `_near` | `{ "lat": n, "lng": n, "radius": metres }` | Item nằm trong `radius` mét (khoảng cách vòng lớn). `0 < radius <=` nửa chu vi Trái Đất. |
| `_within_bbox` | `[minLng, minLat, maxLng, maxLat]` | Item nằm trong khung, tính cả cạnh. `minLng > maxLng` là khung vắt qua kinh tuyến 180 (±180°). |

```bash
# Within 2 km of Hoan Kiem lake
curl -G "$CMS/api/v1/items/places" \
  --data-urlencode 'filter={"loc":{"_near":{"lat":21.0288,"lng":105.8525,"radius":2000}}}'

# Bracket form
curl "$CMS/api/v1/items/places?filter[loc][_near][lat]=21.0288&filter[loc][_near][lng]=105.8525&filter[loc][_near][radius]=2000"
curl "$CMS/api/v1/items/places?filter[loc][_within_bbox]=105.7,20.9,106,21.1"
```

Cả hai kết hợp được với `_and` / `_or` và với mọi bộ lọc khác, và dùng được
trong GraphQL qua tham số `filter`. Toán hạng không hợp lệ, hoặc toán tử địa lý
trên một trường không phải geopoint (hay `json`), trả về `400 INVALID_FILTER`,
được quyết định chỉ từ schema. Toán tử nằm dưới khóa của trường, nên bộ chặn
trường-đọc-được (từ chối lọc trên trường bị ẩn) áp dụng cho nó y như các toán
tử khác.

### Cách tính

Điểm được đọc ra từ JSON của item (`data #>> '{loc,lat}'`) qua cùng phép ép
kiểu số có bảo vệ mà các bộ lọc có kiểu dùng, nên một giá trị lưu sai định dạng
đơn giản là không khớp — không bao giờ làm hỏng truy vấn. Mỗi `_near` gồm:

1. **Lọc sơ bộ** — một cửa sổ vĩ độ/kinh độ bao quanh hình tròn (tách làm hai
   khi vắt qua kinh tuyến 180, mọi kinh độ khi phủ một cực). Đây là phép so sánh
   khoảng thường trên phép ép kiểu có bảo vệ, nên một expression index lấy từ
   `GET /api/v1/collections/{name}/index-advice?path=loc.lat&cast=numeric`
   phục vụ được nó.
2. **Kiểm tra chính xác** — haversine trên mặt cầu bán kính 6 371 008.7714 m;
   hoặc, khi có PostGIS, `ST_DWithin(geography, geography, radius, false)`.
   PostGIS tính trên cùng mặt cầu đó, nên hai đường trả về cùng các dòng
   (được chứng minh bởi `apps/cms/src/services/__tests__/geo-filter.db.integration.test.ts`).

PostGIS được phát hiện một lần cho mỗi tiến trình/isolate (kiểm tra lại mỗi năm
phút, nên `CREATE EXTENSION postgis` có hiệu lực mà không cần khởi động lại), ở
bất kỳ schema nào nó được cài vào. Không đường nào cần migration. Tọa độ được
làm tròn tới 10 chữ số thập phân (khoảng 11 µm) trước phần lượng giác: Postgres
báo lỗi khi một tích số thực bị underflow, và việc làm tròn giữ cho một điểm
lưu như `lat: 1e-200` không làm hỏng mọi truy vấn.

## Studio

### Ô nhập bản đồ

Ô nhập geopoint hiển thị một bản đồ: bấm để đặt điểm hoặc kéo marker. Vĩ độ và
kinh độ cũng có thể gõ trực tiếp (giá trị ngoài phạm vi bị đánh dấu và không
được lưu), và **Use my location** điền chúng từ thiết bị. Thư viện bản đồ
(`maplibre-gl`) chỉ được tải khi bản đồ được hiển thị lần đầu, thành một chunk
riêng. Không có WebGL, hoặc khi bản đồ không tải được, các ô gõ tay vẫn hoạt
động độc lập.

### Bố cục Map

Collection có ít nhất một trường geopoint có thêm công tắc **Table / Map** trong
danh sách item. Bố cục Map đặt tối đa 200 item lên bản đồ (mới nhất trước, áp
dụng bộ lọc của danh sách), liệt kê chúng bên cạnh, và mở item khi bấm vào
marker hoặc dòng của nó. **Only this area** truy vấn lại với khung đang nhìn
thấy làm `_within_bbox`. Khi có nhiều trường geopoint, chọn trường cần vẽ.

### Tile bản đồ và ghi công

Style mặc định là OpenFreeMap "Liberty" (`https://tiles.openfreemap.org/styles/liberty`):
vector tile OpenStreetMap miễn phí, không cần API key hay tài khoản. Phần ghi
công — OpenFreeMap, © OpenMapTiles, dữ liệu từ OpenStreetMap — nằm sẵn trong
style và được hiển thị bởi attribution control của bản đồ, thứ Studio luôn bật.
Hãy giữ nó hiển thị khi đổi style: dữ liệu OpenStreetMap theo giấy phép ODbL và
bắt buộc ghi công.

Để dùng tile khác, đặt một trong hai:

| Ở đâu | Thiết lập |
|-------|-----------|
| Toàn bộ bản build Studio | `VITE_MAP_STYLE_URL` lúc build |
| Một trường | `options.mapStyleUrl` trên trường |

Giá trị phải là URL `https://`, một đường dẫn cùng origin (`/tiles/style.json`)
hoặc `http://localhost`; mọi giá trị khác quay về mặc định.

### Chính sách trình duyệt

- **CSP.** Trong Docker, CMS phục vụ Studio với `script-src 'self'` và
  `connect-src 'self' https:`. Tile, glyph và sprite được tải qua https, và
  worker của MapLibre là một file cùng origin (Studio đặt nó bằng
  `setWorkerUrl`), nên chính sách không cần đổi. Style phục vụ qua http thường
  từ host khác bị chặn — hãy phục vụ qua https.
- **Định vị.** `Permissions-Policy` của CMS cho phép `geolocation=(self)` để
  **Use my location** hoạt động khi Studio được phục vụ từ CMS; origin khác và
  frame vẫn không được gì, và trình duyệt vẫn hỏi người dùng trước.
- **Shell desktop / mobile.** Webview Tauri không có CSP, và URL của worker
  không phụ thuộc origin `http(s)`, nên bản đồ chạy được dưới
  `tauri://localhost`. Định vị phụ thuộc quyền của webview trên từng nền tảng;
  khi bị từ chối, ô nhập hiển thị lỗi và tọa độ gõ tay vẫn dùng được.

## Đa tenant

Không có gì mới được dùng chung giữa các site. Giá trị geopoint nằm trong item
của từng site (`lumibase_items.data`), và mệnh đề địa lý được thêm vào cùng
`WHERE` với phạm vi `site_id` và collection, nên một truy vấn bán kính không
bao giờ chạm tới dòng của site khác. Trạng thái duy nhất dùng chung trong tiến
trình là kết quả dò PostGIS, ghi lại database có extension hay không — một
thuộc tính của database, không phải của tenant. Được kiểm bởi ca hai site trong
`apps/cms/src/services/__tests__/geo-filter.db.integration.test.ts`.

## Kiểu

| Bề mặt | Kiểu |
|--------|------|
| SDK typegen | `{ lat: number; lng: number }` |
| SDK | `GeoPoint`; toán tử lọc `_near`, `_within_bbox` |
| GraphQL | `GeoPoint { lat: Float!, lng: Float! }`; giá trị lưu sai định dạng đọc ra `null` |
| CSV export / import | Văn bản JSON của giá trị |
