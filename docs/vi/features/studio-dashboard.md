---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T05:06:56.855Z
translatedFrom: en
sourceHash: 787a97109444f29a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T05:06:56.855Z
codeVerifiedHash: 787a97109444f29a
codeVerifiedClaims: 2
---

# Dashboard trang chủ Studio

Trang chủ Studio tại `/dashboard` (cũng như `/<adminPath>/dashboard`) là một lưới
widget mà mỗi người biên tập tự sắp xếp cho mình. Admin site có thể đặt bố cục
mặc định của site, dùng cho mọi người chưa có bố cục riêng. Tính năng thuộc epic
#668 (#691).

## Bạn thấy bố cục nào

Trang gọi `GET /api/v1/dashboard/layout`, được phân giải theo thứ tự:

1. **Bố cục của bạn** — lưu bằng **Save** trong chế độ sửa (`source: "user"`).
2. **Bố cục mặc định của site** — do admin site lưu (`source: "site"`).
3. **Bố cục có sẵn** — Collections, Recent activity, Scheduled releases và
   Agent runs (`source: "default"`, `layout: null`).

**Use the default** xoá bố cục của bạn và hiển thị bố cục kế tiếp theo thứ tự trên.

## Chỉnh sửa

**Edit** chuyển lưới sang chế độ chỉnh sửa:

- Kéo widget bằng tay nắm để di chuyển; kéo góc để đổi kích thước. Lưới có 12
  cột; widget bị chồng lên sẽ bị đẩy xuống và bố cục được dồn lên trên.
- **Add widget** liệt kê mọi widget có thể thêm. Widget mới nằm ở cuối với kích
  thước mặc định.
- Nút cài đặt sửa tiêu đề và tuỳ chọn của widget (ví dụ nội dung của Note, hoặc
  dashboard và panel của biểu đồ Insights).
- Nút xoá gỡ widget khỏi lưới.
- **Save** lưu bố cục cho riêng bạn. Admin site có thêm **Save as site
  default**. **Cancel** bỏ các thay đổi.

Một bố cục tối đa 40 widget, tuỳ chọn của mỗi widget tối đa 4 KB.

## Widget

| Type | Hiển thị |
|------|-------|
| `collections` | Liên kết tới các collection bạn thấy được. |
| `recent-activity` | Các mục activity mới nhất. |
| `insights-panel` | Một panel của dashboard Insights (`dashboardId`, `panelId`). |
| `releases` | Các release đã lên lịch sắp tới. |
| `agent-runs` | Các lần chạy agent gần đây. |
| `note` | Một ghi chú văn bản thuần (`text`). |
| `extension:<name>` | Một UI extension slot `panel`. |

Mỗi widget tự tải dữ liệu, có trạng thái loading và lỗi riêng, nên một widget
lỗi không làm trống cả trang.

### Widget từ extension

Mọi UI extension slot `panel` đang bật đều xuất hiện trong **Add widget** dưới
dạng `extension:<name>`. Nó được dựng qua cùng `ExtensionComponent` như mọi UI
extension — error boundary, Suspense, CSP của Studio và allowlist nguồn bundle —
và chỉ nhận `config` cùng `size` (`{ w, h }` theo đơn vị lưới) làm props.
Extension bị gỡ hoặc tắt sau đó sẽ hiện placeholder thay vì làm hỏng trang.

`@lumibase/extension-sdk` export `defineDashboardWidget` để khai báo props và
kích thước mặc định của widget:

```ts
import { defineDashboardWidget, type DashboardWidgetProps } from '@lumibase/extension-sdk';

function Uptime({ config, size }: DashboardWidgetProps) {
  return <p>{String(config.service ?? 'all')} · {size.w}×{size.h}</p>;
}

export default defineDashboardWidget({
  id: 'uptime',
  title: 'Uptime',
  defaultSize: { w: 4, h: 2 },
  component: Uptime,
});
```

## Lưu trữ và quyền truy cập

Bố cục nằm trong `lumibase_dashboard_layouts` (migration `0044`), một dòng cho
mỗi người dùng và site cộng tối đa một bố cục mặc định của site (`user_id` null),
theo phạm vi `site_id` và row-level security. Bố cục riêng cần người dùng đã đăng
nhập: API key nhận `403 USER_REQUIRED` với `PUT`/`DELETE`. Các route bố cục mặc
định cần admin site; việc đặt và xoá được ghi audit là `dashboard_default_set` và
`dashboard_default_cleared`. Xem
[tài liệu API](../api/hono-api-spec.md#bố-cục-dashboard-trang-chủ-studio).
