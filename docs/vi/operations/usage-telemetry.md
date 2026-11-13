---
version: 1
lastUpdated: 2026-11-13T15:31:03.856Z
sourceLang: en
translatedFrom: en
sourceHash: 3b14ce684d73bd22
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-13T15:31:03.856Z
codeVerifiedHash: 3b14ce684d73bd22
codeVerifiedClaims: 6
---

# Mốc kích hoạt và telemetry sử dụng

Trang này nói về hai thứ tách biệt, dễ bị nhầm với nhau:

- **Mốc kích hoạt** được lưu trong chính database của bạn và do admin site của bạn đọc. Chúng không bao giờ rời khỏi bản cài đặt.
- **Telemetry sử dụng** là một bộ phát tuỳ chọn, báo các mốc ở cấp bản cài đặt tới một endpoint do bạn chỉ định. Nó **tắt theo mặc định** và không có endpoint dựng sẵn.

## Mốc kích hoạt

Mỗi site có bốn mốc, theo thứ tự:

| Mốc | Đạt khi | Thời điểm lấy từ |
|---|---|---|
| `site_created` | Site tồn tại | `lumibase_sites.created_at` |
| `item_published` | Site có một item đã publish | `updated_at` sớm nhất trong các `lumibase_items` đã publish, chưa xoá của site, tại lúc mốc được suy ra lần đầu |
| `delivery_request` | Một client đọc nội dung thành công lần đầu | Ghi tại thời điểm request |
| `agent_run` | Site có một agent run | `lumibase_agent_runs.started_at` sớm nhất |

`delivery_request` tính một `GET` được trả `2xx` hoặc `304` trên một trong hai bề mặt:

- `/api/v1/deliver/*`, tức Delivery API công khai;
- `/api/v1/items/*` khi bên gọi xác thực bằng API key. Lượt đọc của người dùng đã đăng nhập không được tính.

Mốc chỉ ghi một lần. Chúng nằm trong `lumibase_activation_milestones`, mỗi site và mỗi mốc một dòng, và việc xoá item hay run đã đánh dấu mốc không làm mốc đó mất đi. `item_published` không có cột riêng để đọc, nên thời điểm của nó là một cận trên: đó là giá trị tốt nhất có được khi mốc được suy ra lần đầu, và từ đó được giữ nguyên.

Chỉ thời điểm được lưu. Không ghi path, API key, địa chỉ IP hay user agent.

### Đọc phễu

```http
GET /api/v1/activation
```

Chỉ dành cho admin site (ngược lại trả `403 FORBIDDEN`). Trả về phễu của site đang hoạt động:

```json
{
  "data": {
    "siteId": "site_abc",
    "milestones": [
      { "key": "site_created", "reachedAt": "2026-10-01T08:00:00.000Z", "source": "derived", "secondsSinceSiteCreated": 0 },
      { "key": "item_published", "reachedAt": "2026-10-01T09:00:00.000Z", "source": "derived", "secondsSinceSiteCreated": 3600 },
      { "key": "delivery_request", "reachedAt": null, "source": null, "secondsSinceSiteCreated": null },
      { "key": "agent_run", "reachedAt": null, "source": null, "secondsSinceSiteCreated": null }
    ],
    "reached": 2,
    "total": 4
  }
}
```

`source` là `event` khi mốc được ghi ngay lúc xảy ra, và là `derived` khi mốc được đọc ngược từ các dòng đã có.

## Telemetry sử dụng

### Nó tắt cho tới khi bạn bật

Telemetry không gửi gì trừ khi **cả hai** biến sau được đặt:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `LUMIBASE_TELEMETRY_ENABLED` | (không đặt) | Đặt `true` để opt-in. |
| `LUMIBASE_TELEMETRY_ENDPOINT` | (không đặt) | URL nhận các sự kiện. Không có endpoint mặc định. Phải là `https:`; `http:` chỉ được chấp nhận với `localhost`. |

Khi telemetry tắt, bộ phát không truy vấn database, không sinh install id và không thực hiện request mạng nào.

Studio không bao giờ hỏi bạn bật telemetry. Các biến môi trường ở trên là cách duy nhất để bật.

### Cách tắt

Đặt một biến:

```bash
LUMIBASE_TELEMETRY_DISABLED=true
```

Biến này thắng `LUMIBASE_TELEMETRY_ENABLED`. `DO_NOT_TRACK=1` có tác dụng tương tự. Bỏ `LUMIBASE_TELEMETRY_ENABLED` cũng tắt telemetry.

Để xoá install id sau khi opt-out, xoá dòng trạng thái:

```sql
DELETE FROM lumibase_telemetry_state;
```

### Những gì được gửi

Ở mỗi tick theo lịch hằng giờ, một bản cài đặt đã opt-in báo lần đầu tiên **bất kỳ** site nào của nó đạt từng mốc. Tức là tối đa bốn request trong suốt vòng đời của một bản cài đặt. Mỗi request là một HTTP `POST` có body đúng là object JSON sau:

```json
{
  "schemaVersion": 1,
  "installId": "3f0c1e52-8a55-4b0e-9d5e-0c6f1f6f2a11",
  "event": "first_item_published",
  "occurredOn": "2026-11-02",
  "version": "2.0.0",
  "runtime": "docker"
}
```

| Trường | Nội dung |
|---|---|
| `schemaVersion` | Luôn là `1`. |
| `installId` | Một UUID v4 ngẫu nhiên, sinh trên bản cài đặt của bạn ở lần đầu telemetry chạy. Nó không được suy ra từ hostname, key, người dùng hay site nào. |
| `event` | `first_site_created`, `first_item_published`, `first_delivery_request` hoặc `first_agent_run`. |
| `occurredOn` | Ngày (UTC) mốc được đạt. Không có giờ trong ngày. |
| `version` | Phiên bản LumiBase, hoặc `unknown`. |
| `runtime` | `docker` hoặc `cloudflare`. |

Schema được công bố dưới dạng JSON Schema tại [`docs/schemas/telemetry-event.v1.schema.json`](https://github.com/khuepm/LumiBase/blob/main/docs/schemas/telemetry-event.v1.schema.json) và dưới dạng `TelemetryEventSchema` trong `@lumibase/contracts`. Schema từ chối trường lạ, và bộ phát validate mọi body theo schema trước khi gửi.

Header duy nhất bộ phát đặt cho request là `Content-Type: application/json`. Nó không đi theo redirect.

### Những gì không bao giờ được gửi

- Nội dung, tên collection, tên field hay dữ liệu item.
- Site id, organization id, domain hay hostname.
- User id, email, API key hay token.
- Địa chỉ IP, cả trong body lẫn trong mọi header do bộ phát đặt.
- Số đếm của bất cứ thứ gì: bao nhiêu site, item, request hay run.

Mọi request HTTP đều để lộ địa chỉ mạng của bên gửi cho bên nhận ở tầng kết nối. Bộ phát không ngăn được điều đó; người vận hành endpoint mà bạn cấu hình quyết định có ghi log địa chỉ ấy hay không.

### Phân phối

Một sự kiện chỉ được đánh dấu đã gửi sau khi endpoint trả `2xx`. Nếu không, nó được thử lại ở một tick sau. Trên Cloudflare Workers, hai tick chồng nhau có thể gửi cùng một sự kiện hai lần với body giống hệt, nên bên thu nên coi `(installId, event)` là khoá.

Mỗi body đã gửi cũng được ghi vào log server với tiền tố `[telemetry]`, để bạn kiểm tra chính xác những gì đã rời khỏi bản cài đặt.

### Quan hệ với consent của người dùng

Bản ghi consent theo từng người dùng (`/api/v1/me/consents`) chi phối việc xử lý dữ liệu của một người dùng cụ thể. Telemetry không đọc dữ liệu theo người dùng nào, và không tham chiếu hay thay đổi các bản ghi đó. Quyết định bật telemetry thuộc về người vận hành bản cài đặt.

## Hỗ trợ runtime

Cả hai tính năng đều chạy trên Docker và trên Cloudflare Workers. Lượt telemetry chạy theo lịch hằng giờ vốn đã có trên từng runtime: Cron Trigger `0 * * * *` trên Workers và cron hằng giờ trong server Node.
