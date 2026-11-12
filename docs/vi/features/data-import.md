---
version: 2
lastUpdated: 2026-11-12T10:11:38.468Z
sourceLang: en
translatedFrom: en
sourceHash: 932857ad9c1c2971
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-12T10:11:38.468Z
codeVerifiedHash: 932857ad9c1c2971
codeVerifiedClaims: 12
---

# Data import

Nạp hàng loạt nhiều item — migration, seed, hay backfill một lần — phải đi qua
**bulk items endpoint** hoặc, với cả một file, một **job import chạy nền**, không
bao giờ là một request cho mỗi row. Trang này nói về cả hai, rate limit thường làm
sập các lần import lớn, và cách batch được khuyến nghị.

## Bulk endpoint

```
POST /api/v1/items/{collection}/bulk
```

Body là một object gồm một operation và một array item:

```json
{
  "op": "create",
  "items": [
    { "title": "First",  "slug": "first" },
    { "title": "Second", "slug": "second" }
  ]
}
```

| Field | Type | Ghi chú |
|-------|------|-------|
| `op` | `"create" \| "update" \| "delete"` | Bắt buộc. |
| `items` | array of objects | Với `update` và `delete`, mỗi item phải có `id`. |

Response là `{ "data": [...] }` — một array kết quả theo từng item, đúng thứ tự
input. Body sai định dạng trả `400` kèm envelope `VALIDATION`. Các header tenant
(`X-Lumi-Site`) và auth tiêu chuẩn vẫn áp dụng, và permission ở mức row được
enforce cho từng item.

> `op: "delete"` thực hiện **soft delete**, không phải hard delete.

### Batching

Endpoint **không** đặt cap cứng cho `items` — độ dài array không bị validate và
service lặp qua toàn bộ payload. Tuy nhiên `bulk` **không transactional**: các
item được áp tuần tự, và một lỗi ở giữa sẽ để lại các item trước đó đã commit.
Với import lớn, hãy gửi item theo batch (ví dụ 500–1000 mỗi lần gọi) để có thể
retry một batch lỗi mà không phải gửi lại toàn bộ, đồng thời giữ mỗi request
nằm gọn dưới cửa sổ rate-limit. Chọn batch size cân bằng giữa throughput và
thời lượng request cho dữ liệu của bạn.

## Job import chạy nền

Với một file — [bản export CSV hoặc JSON](./data-export.md), dữ liệu migration,
một bảng tính 100k dòng — hãy upload nó thành một **job import** thay vì tự chia
batch các lệnh gọi `bulk`. Server lưu file, trả `202` ngay, rồi ghi các dòng ở
chế độ nền theo từng phần, nên kích thước file không bao giờ làm request bị timeout.

```
POST /api/v1/imports?collection={collection}&format=csv|json&mode=create|upsert
```

- **Body:** chính là file. Gửi dạng multipart (trường `file`; định dạng lấy từ
  đuôi tên `.csv` / `.json`) hoặc body thô (`text/csv`,
  `application/octet-stream`). Body thô `application/json` bị giới hạn bởi mức
  1 MiB của JSON body, nên hãy gửi file JSON dạng multipart hoặc
  `application/octet-stream`.
- **Định dạng:** bố cục của [Data export](./data-export.md) — CSV với các cột
  `field.locale` cho trường dịch được, hoặc envelope JSON (hoặc một mảng
  `{ id?, status?, sort?, data }`). Cột không phải là trường của collection bị
  từ chối với `400` trước khi ghi bất kỳ dòng nào.
- **Mode:** `create` (mặc định) luôn tạo item mới. `upsert` cập nhật item có
  `id` khớp và tạo phần còn lại; cần thêm quyền `update`.
- **Quyền:** được kiểm tra ngay từ đầu (`create`, cộng `update` với `upsert`) và
  kiểm tra lại ở từng dòng, dưới danh nghĩa user hoặc API key đã upload file.
  Nếu principal đó mất quyền trong lúc job chạy, job dừng với trạng thái `failed`.

Phản hồi là job:

```json
{
  "data": {
    "id": "Vb3…",
    "collection": "products",
    "format": "csv",
    "mode": "create",
    "status": "queued",
    "totalRows": 100000,
    "processedRows": 0,
    "createdRows": 0,
    "updatedRows": 0,
    "failedRows": 0,
    "errorsTruncated": 0,
    "message": null,
    "cancelRequested": false
  }
}
```

| Endpoint | Mục đích |
|----------|----------|
| `GET /api/v1/imports/{id}` | Tiến độ: `status`, `processedRows` trên `totalRows`, các bộ đếm. |
| `GET /api/v1/imports?collection=&status=&limit=` | Các job gần đây. Bạn thấy job của mình; admin của site thấy tất cả. |
| `GET /api/v1/imports/{id}/errors` | Lỗi theo dòng `{ row, id?, message }`. Thêm `?format=csv` để tải về. |
| `POST /api/v1/imports/{id}/cancel` | Dừng job. Job còn đang chờ dừng ngay; job đang chạy dừng sau phần hiện tại. |

`status` đi từ `queued` → `running` → `succeeded`, `failed`, `cancelled` hoặc
`timed_out`. Một dòng lỗi (validation, quyền, hook) được ghi lại cùng số thứ tự
dòng (đếm từ 1) và job vẫn chạy tiếp; job chỉ `failed` khi mọi dòng đều lỗi.
1.000 lỗi đầu tiên được lưu, phần còn lại được đếm trong `errorsTruncated`. Các
dòng đã ghi trước khi huỷ hoặc timeout vẫn được giữ.

Studio có cùng luồng này ở **Content → collection → Import**, với thanh tiến độ,
nút **Cancel import** và **Download error report**. Studio cũng nhận sự kiện
realtime `import.progress` cho người đã upload.

**Cách job chạy.** Request upload khởi động job và xử lý nó trong khoảng
20 giây. Sau đó một cron mỗi phút (Cron Trigger trên Workers, hoặc scheduler của
Node trên Docker) chạy tiếp. Mỗi bước giữ một lease ngắn trên job, nên các worker
chạy chồng nhau không bao giờ ghi cùng một phần hai lần, và một worker chết giữa
chừng được thay thế khi lease của nó hết hạn. Đo trên máy local với Postgres 16,
mỗi dòng đi qua toàn bộ pipeline item (validation, revision, change feed) với tốc
độ khoảng 90 dòng mỗi giây cho mỗi job, nên một file 100k dòng mất khoảng 20 phút.
Giới hạn và kích thước mỗi phần được đặt bằng [các biến `IMPORT_*`](../deployment/environment-variables.md#imports).

## Rate limit

API đã xác thực bị giới hạn mặc định ở **300 request mỗi 60 giây** cho mỗi
principal (xem [Rate limiting](../deployment/environment-variables.md#rate-limiting)).
Một lần import ngây thơ theo kiểu một request mỗi row sẽ gặp `429` giữa đường.
Hai đòn bẩy:

1. **Dùng bulk endpoint** — một request chuyển cả một batch, nên cùng lượng
   import tốn ít request hơn nhiều.
2. **Nâng budget cho lần import** — đặt `LUMIBASE_RATE_LIMIT_MAX` cao hơn (hoặc
   `LUMIBASE_RATE_LIMIT_DISABLED=true` trên một host import tin cậy, đã cách ly)
   trong lúc job chạy, rồi phục hồi lại sau.

Khi gặp `429`, response mang theo `Retry-After` và `X-RateLimit-Reset`; client
nào tôn trọng chúng sẽ tự điều tiết nhịp.

## Liên quan

- [Data export](./data-export.md)
- [Environment Variables → Imports](../deployment/environment-variables.md#imports)
- [Environment Variables → Rate limiting](../deployment/environment-variables.md#rate-limiting)
- [Data model](../data-model.md)
