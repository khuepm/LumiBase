---
version: 1
lastUpdated: 2026-07-28T10:17:03.297Z
sourceLang: en
translatedFrom: en
sourceHash: 152cf39aee864f38
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:17:03.297Z
codeVerifiedHash: 152cf39aee864f38
codeVerifiedClaims: 4
---

# Data import

Nạp hàng loạt nhiều item — migration, seed, hay backfill một lần — phải đi qua
**bulk items endpoint**, không phải một request cho mỗi row. Trang này nói về
endpoint đó, rate limit thường làm sập các lần import lớn, và cách batch được
khuyến nghị.

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

- [Environment Variables → Rate limiting](../deployment/environment-variables.md#rate-limiting)
- [Data model](../data-model.md)
