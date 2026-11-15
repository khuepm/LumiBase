---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T12:01:39.030Z
translatedFrom: en
sourceHash: a20c90d7a1acdcc4
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T17:12:07.442Z
codeVerifiedHash: a20c90d7a1acdcc4
codeVerifiedClaims: 20
---

# Field datetime có múi giờ

Field `datetime` hoặc `timestamp` có thể bật chế độ lưu **thời điểm tuyệt đối kèm múi giờ IANA mà giá trị được nhập**. Dùng cho mọi thứ diễn ra "lúc 9:00 giờ Tokyo": sự kiện, giờ mở cửa hàng, lịch phát sóng. Field không bật option vẫn giữ nguyên chuỗi ISO như trước.

## 1. Bật option

Đặt `timezone: true` trong `options` của field (Studio: Data model → field → Interface → **Timezone-aware**).

```json
{
  "name": "starts_at",
  "type": "datetime",
  "interface": "datetime",
  "options": { "timezone": true, "defaultTimezone": "Europe/London", "disambiguation": "compatible" }
}
```

| Option | Mặc định | Ý nghĩa |
|---|---|---|
| `timezone` | `false` | Bật tính năng. Chỉ cho phép trên `datetime`, `dateTime` và `timestamp`. |
| `defaultTimezone` | `UTC` | Múi giờ dùng khi lệnh ghi không kèm `tz` (chuỗi ISO trần). |
| `disambiguation` | `compatible` | Quy tắc DST cho input dạng giờ địa phương (xem §4). |

Schema service từ chối bộ option sai bằng `422 INVALID_FIELD_OPTIONS`: `timezone` trên type khác, `defaultTimezone` không tồn tại, hoặc `disambiguation` không hợp lệ.

## 2. Dạng lưu trữ và trả về

```json
{ "instant": "2026-03-08T07:30:00.000Z", "tz": "America/New_York", "offset": "-04:00" }
```

- `instant` — ISO-8601 theo UTC. Filter và sort dùng giá trị này.
- `tz` — múi giờ IANA lúc nhập giá trị. Alias được chuẩn hoá (`US/Eastern` → `America/New_York`).
- `offset` — độ lệch UTC của `tz` tại `instant`, server tính lại ở mỗi lần ghi. Offset giờ địa phương lịch sử giữ cả phần giây (`-04:56:02`).

REST, delivery và realtime trả object đúng như đã lưu. GraphQL định kiểu field là `ZonedDateTime { instant, tz, offset }`. Typegen sinh `{ instant: string; tz: string; offset: string }`, và SDK export type `ZonedDateTime`.

## 3. Ghi giá trị

Mọi lệnh ghi đều được chuẩn hoá về dạng lưu trữ. Các input được chấp nhận:

| Input | Ví dụ | Kết quả |
|---|---|---|
| Instant + múi giờ | `{ "instant": "2026-07-01T10:00:00+02:00", "tz": "Europe/London" }` | Nhận mọi offset; `offset` lưu trữ được tính lại. |
| Giờ địa phương + múi giờ | `{ "local": "2026-07-04T09:00", "tz": "America/New_York" }` | Giải theo `disambiguation` của field, hoặc `"disambiguation"` riêng của giá trị. |
| Chuỗi ISO có offset | `"2026-01-01T00:00:00Z"` | Múi giờ = `defaultTimezone` (nếu không có thì `UTC`). |
| Chuỗi ISO không offset | `"2026-01-01T09:00"` | Giờ địa phương theo `defaultTimezone`; bị từ chối khi chưa cấu hình mặc định. |

Gửi cả `instant` lẫn `local` sẽ bị từ chối. Múi giờ được kiểm tra với `Intl.supportedValuesOf('timeZone')`; với runtime không có hàm này, hệ thống dùng danh sách múi giờ phổ biến dựng sẵn. Offset cố định như `+05:00` không phải múi giờ nên bị từ chối.

## 4. Khoảng trống và chồng lấn DST

Một giờ địa phương có thể rơi vào khoảng trống khi vặn đồng hồ tới (không bao giờ xảy ra) hoặc vùng chồng lấn khi vặn lùi (xảy ra hai lần). Quy tắc theo `disambiguation` của Temporal:

| Quy tắc | Khoảng trống | Chồng lấn |
|---|---|---|
| `compatible` (mặc định) | dời tới bằng độ dài khoảng trống | instant sớm hơn |
| `earlier` | dời lùi bằng độ dài khoảng trống | instant sớm hơn |
| `later` | dời tới bằng độ dài khoảng trống | instant muộn hơn |
| `reject` | lỗi `NONEXISTENT_LOCAL_TIME` | lỗi `AMBIGUOUS_LOCAL_TIME` |

Ví dụ với `compatible`:

| Input | Kết quả |
|---|---|
| `2026-03-08T02:30` `America/New_York` (khoảng trống 02:00–03:00) | `03:30-04:00` = `07:30Z` |
| `2026-11-01T01:30` `America/New_York` (chồng lấn) | `01:30-04:00` = `05:30Z` |
| `2026-10-04T02:15` `Australia/Lord_Howe` (khoảng trống 30 phút) | `02:45+11:00` = `15:45Z` ngày hôm trước |
| `2026-10-25T01:30` `Europe/London` (chồng lấn) | `01:30+01:00` = `00:30Z` |

Input dạng instant không bao giờ mơ hồ, nên quy tắc chỉ áp dụng cho input giờ địa phương.

## 5. Filter và sort

Các toán tử so sánh (`_eq`, `_neq`, `_in`, `_nin`, `_gt`, `_gte`, `_lt`, `_lte`) và sort trên field có múi giờ so sánh `instant` dưới dạng `timestamptz`, không bao giờ so giờ địa phương. Giá trị filter có thể là chuỗi ISO hoặc object có múi giờ:

```json
{ "starts_at": { "_gte": { "local": "2026-03-08T00:00", "tz": "America/New_York" } } }
```

Giá trị ghi trước khi bật option (chuỗi trần) vẫn filter và sort đúng: biểu thức filter quay về dùng chuỗi khi không có `instant`. Chúng chuyển sang dạng mới ở lần lưu kế tiếp.

## 6. Studio

- **Settings → Date & time** đặt múi giờ hiển thị cho từng người dùng (`users.preferences.timezone`, `PATCH /api/v1/me/preferences`). Để trống nghĩa là "theo trình duyệt". Múi giờ không tồn tại bị từ chối.
- Ô nhập ngày của field có múi giờ có thêm bộ chọn múi giờ. Giờ địa phương được sửa theo múi giờ của chính giá trị; giá trị mới bắt đầu ở múi giờ hiển thị của người dùng. Dòng gợi ý cho biết cùng thời điểm đó theo múi giờ của người dùng, và một ghi chú giải thích khi khoảng trống DST làm dời giờ.
- Danh sách (display `formatted-date`) hiển thị instant theo múi giờ của người dùng, kèm giờ và múi giờ gốc làm gợi ý, ví dụ `(Jul 4, 2026, 9:00 AM America/New_York (-04:00))`.

## 7. Triển khai

| Phần | Vị trí |
|---|---|
| Chuyển đổi, kiểm tra, quy tắc DST | `packages/contracts/src/field/zoned-datetime.ts` |
| Chuẩn hoá khi ghi | `apps/cms/src/services/validation.ts` |
| Kiểm tra option | `apps/cms/src/services/schema-service.ts` |
| Filter / sort trên instant | `apps/cms/src/services/item-service.ts`, `apps/cms/src/services/json-filter-cast.ts` |
| Kiểu GraphQL | `apps/cms/src/graphql/type-mapping.ts` |
| Editor / display / settings của Studio | `apps/studio/src/modules/content/interfaces/datetime.tsx`, `apps/studio/src/modules/content/displays/formatted-date.tsx`, `apps/studio/src/modules/settings/date-time-page.tsx` |

Chỉ dùng `Intl`, nên cùng một đoạn code chạy được trên Cloudflare Workers, Node và trình duyệt. Không cần migration: giá trị nằm trong JSON của item và tuỳ chọn nằm trong `users.preferences`.
