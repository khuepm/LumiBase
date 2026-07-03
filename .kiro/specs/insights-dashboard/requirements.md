# Requirements Document — Insights / Dashboard

## Introduction

Spec mô tả một tính năng mới hoàn toàn: **Insights** — dashboard tùy biến (Directus-inspired) cho phép người vận hành dựng bảng điều khiển từ nhiều **panel**, mỗi panel kéo dữ liệu tổng hợp (aggregate) trực tiếp từ một collection của site. LumiBase hiện CHƯA có khả năng này: metrics hiện tại chỉ là số đếm Prometheus in-memory (`apps/cms/src/routes/metrics.ts`, `apps/cms/src/services/agent-metrics.ts`) không có data store bền vững, và `apps/studio/src/modules/` chưa có module `insights`/`analytics` nào.

Phạm vi gồm cả backend lẫn frontend lẫn SDK:

- **Backend mới:** 2 bảng (`dashboards`, `panels`), service `insights-service.ts` chạy aggregate query an toàn, và route group `/api/v1/dashboards`.
- **Studio mới:** module `apps/studio/src/modules/insights/` — danh sách dashboard, dashboard view dạng grid panel, panel editor, render chart.
- **SDK:** mở rộng type `Dashboard`/`Panel` + methods (backward-compatible).

Ràng buộc bất biến (CLAUDE.md): `nanoid()` cho domain table; mọi domain table có `site_id` và mọi query filter theo `siteId`; runtime abstraction (dùng `c.get('runtime')`, không import CF binding trong business logic); response format `{ data: T, meta? }` hoặc `{ errors: [...] }`; TypeScript strict, `import type`, no `any`; migration viết tay (KHÔNG `drizzle-kit generate`) kèm sửa journal.

Nguyên tắc bảo mật cốt lõi: panel query do người dùng cấu hình KHÔNG bao giờ được biến thành raw SQL string concat. Mọi định danh (collection, field, aggregate fn) phải đi qua whitelist/validate trước khi tạo SQL qua Drizzle expression builder — kế thừa kỷ luật của `materialize-service.ts` nhưng chặt hơn (không escape-string-rồi-nối).

## Glossary

- **Dashboard**: Một bảng điều khiển có tên/icon/màu, thuộc về một site, chứa nhiều Panel sắp theo grid. Bảng `dashboards`.
- **Panel**: Một ô trực quan trên Dashboard với một loại hiển thị (`metric`/`timeSeries`/`bar`/`pie`/`list`/`table`), một Panel_Query và vị trí grid. Bảng `panels`.
- **Aggregate**: Hàm tổng hợp áp lên một field của collection: `count` | `sum` | `avg` | `min` | `max`. `count` không cần field; các fn còn lại bắt buộc field số.
- **Panel_Query**: Đặc tả nguồn dữ liệu của một Panel (JSON): `collection`, `aggregate`, `field?`, `groupBy?`, `filter?`, `dateRange?`, `limit?`. Là **nguồn truth chung** giữa FE (builder tạo ra) và BE (thực thi) — chia sẻ qua SDK/`@lumibase/shared`.
- **Condition_Rule**: Cấu trúc filter tái dùng `ConditionRule` của `apps/cms/src/services/conditions.ts` (Directus-style `{ field: { _eq: ... }, _and: [...], _or: [...] }`). Panel_Query.filter dùng đúng shape này.
- **Panel_Result**: Kết quả đã tính của một Panel_Query: với `metric` là một số; với chart/list là mảng `{ label/group, value }`; format theo `{ data, meta? }`.
- **Grid_Position**: Vị trí + kích thước panel trên lưới (`{ x, y, w, h }`), lưu JSONB trong `panels.position`.
- **Field_Whitelist**: Tập field hợp lệ cho một collection = tên các field định nghĩa trong schema collection + các cột hệ thống cho phép (`id`, `status`, `created_at`, `updated_at`, `sort`). Mọi field trong Panel_Query (aggregate/groupBy/filter/dateRange) phải nằm trong tập này.
- **Admin_Base**: Prefix `/$adminPath` tùy chọn — mọi route Studio có 2 biến thể (có/không prefix), theo pattern trong `router.tsx`.

## Requirements

### Requirement 1: Mô hình dữ liệu Dashboard & Panel

**User Story:** Là một quản trị viên, tôi muốn dashboard và panel được lưu bền vững theo từng site, để cấu hình insights tồn tại qua các phiên và không rò rỉ giữa các tenant.

#### Acceptance Criteria

1. THE schema SHALL định nghĩa bảng `dashboards` ở `packages/database/src/schema/cms.ts` với cột: `id` (nanoid), `site_id` (text, FK `sites.id`, `onDelete: cascade`, NOT NULL), `name` (text NOT NULL), `icon` (text nullable), `color` (text nullable), `note` (text nullable), `created_by` (text nullable), `created_at`, `updated_at`.
2. THE schema SHALL định nghĩa bảng `panels` với cột: `id` (nanoid), `site_id` (text, FK `sites.id`, cascade, NOT NULL), `dashboard_id` (text, FK `dashboards.id`, `onDelete: cascade`, NOT NULL), `name` (text NOT NULL), `type` (text NOT NULL — một trong `metric|timeSeries|bar|pie|list|table`), `position` (jsonb NOT NULL, shape Grid_Position), `query` (jsonb NOT NULL, shape Panel_Query), `options` (jsonb default `{}` NOT NULL), `created_at`, `updated_at`.
3. THE migration tạo 2 bảng này SHALL được viết tay (KHÔNG `drizzle-kit generate`) và thêm dòng tương ứng vào journal — theo memory "Migrations are hand-written".
4. THE `dashboards` SHALL có index `(site_id)` và `panels` SHALL có index `(site_id, dashboard_id)` để truy vấn scope theo tenant + dashboard.
5. THE mọi định danh khóa chính SHALL dùng `nanoid()` (đây là domain table, KHÔNG phải audit table — không dùng `uuidv7()`/`serial`).

### Requirement 2: Panel_Query là contract chung FE↔BE

**User Story:** Là một maintainer, tôi muốn cấu trúc Panel_Query định nghĩa một lần và dùng chung ở FE (builder), BE (thực thi) và SDK, để hai phía không lệch nhau khi đặc tả hay diễn giải query.

#### Acceptance Criteria

1. THE `@lumibase/shared` (`packages/shared/src/schemas/`) SHALL export một Zod schema `panelQuerySchema` và type `PanelQuery` suy ra từ nó, gồm: `collection` (string), `aggregate` (enum `count|sum|avg|min|max`), `field` (string optional), `groupBy` (string optional), `filter` (Condition_Rule optional), `dateRange` (object optional `{ field, gte?, lte?, preset? }`), `limit` (number optional, max 1000).
2. IF `aggregate` khác `count`, THEN `panelQuerySchema` SHALL yêu cầu `field` có mặt (validation lỗi nếu thiếu) — vì `sum/avg/min/max` cần field số.
3. THE `filter` SHALL tái dùng shape `ConditionRule` của `apps/cms/src/services/conditions.ts`; spec KHÔNG định nghĩa lại operator — FE builder sinh `ConditionRule`, BE evaluate cùng một cây.
4. THE SDK (`packages/sdk`) SHALL re-export `PanelQuery`, `Dashboard`, `Panel` types backward-compatible (chỉ thêm, không đổi type cũ).

### Requirement 3: Backend thực thi panel query AN TOÀN

**User Story:** Là một maintainer lo về bảo mật, tôi muốn việc chạy aggregate từ cấu hình người dùng không bao giờ mở cửa SQL injection và không bao giờ đọc dữ liệu của site khác, để một panel cấu hình sai/độc hại không thể đọc/phá dữ liệu ngoài phạm vi.

#### Acceptance Criteria

1. THE `insights-service.ts` SHALL build aggregate query qua Drizzle expression builder (`sql`/`eq`/`and` + JSONB accessor có tham số hóa), KHÔNG nối raw identifier do người dùng nhập vào chuỗi SQL.
2. WHEN thực thi một Panel_Query, THE service SHALL validate `collection` tồn tại trong site hiện tại (`collections` filter `siteId`) trước khi chạy; collection không tồn tại → trả lỗi, không chạy SQL.
3. THE service SHALL kiểm tra mọi field tham chiếu (`field`, `groupBy`, `dateRange.field`, mọi field trong `filter`) nằm trong Field_Whitelist của collection đó; field ngoài whitelist → lỗi `INVALID_FIELD`, không chạy SQL.
4. THE `aggregate` SHALL được giới hạn bằng map cố định trong code (`count|sum|avg|min|max`) — giá trị ngoài tập này không thể tạo SQL.
5. THE mọi câu aggregate SHALL gắn `WHERE site_id = <siteId hiện tại>` và `deleted_at IS NULL` (bất biến multi-tenant); siteId lấy từ context request, KHÔNG từ body.
6. WHEN có `groupBy`, THE service SHALL `GROUP BY` trên JSONB key đã validate và `ORDER BY` value giảm dần, áp `limit` (mặc định 50, trần 1000) để chặn kết quả khổng lồ.
7. THE service SHALL áp `filter` (Condition_Rule) thành điều kiện WHERE tham số hóa trên JSONB; operator ngoài tập hỗ trợ → bỏ qua điều kiện đó hoặc lỗi (mô tả ở design), không sinh SQL tùy tiện.

### Requirement 4: API CRUD dashboard & panel

**User Story:** Là một quản trị viên, tôi muốn tạo/sửa/xóa dashboard và panel qua API, để Studio dựng UI lên trên một backend ổn định và để tự động hóa/CI dùng lại được.

#### Acceptance Criteria

1. THE route group `/api/v1/dashboards` SHALL cung cấp: `GET /` (list dashboard của site), `POST /` (tạo), `GET /:id`, `PATCH /:id`, `DELETE /:id` — mọi handler filter theo `siteId` từ context; mọi response theo `{ data }` hoặc `{ errors }`.
2. THE route `/api/v1/dashboards/:id/panels` SHALL cung cấp: `GET /` (panel của dashboard), `POST /` (tạo, validate `panelQuerySchema`), `PATCH /:pid`, `DELETE /:pid`.
3. THE endpoint thực thi panel SHALL là `POST /api/v1/dashboards/:id/panels/:pid/data` trả Panel_Result đã tính; body optional cho override `dateRange` (vd đổi khoảng thời gian từ UI) — override vẫn đi qua validate Field_Whitelist.
4. WHEN dashboard/panel id không thuộc site hiện tại hoặc không tồn tại, THE handler SHALL trả 404 `{ errors: [...] }` — không lộ dữ liệu cross-tenant.
5. THE thao tác ghi (`POST`/`PATCH`/`DELETE`) SHALL yêu cầu quyền admin HOẶC quyền của collection được tham chiếu (mô tả lựa chọn ở design); đọc Panel_Result yêu cầu người gọi có quyền đọc collection trong Panel_Query.
6. THE `POST /panels/:pid/data` SHALL trả `meta` gồm tối thiểu `{ executedAt, rowCount, durationMs }` để FE hiển thị độ trễ/độ tươi.

### Requirement 5: Studio — danh sách dashboard

**User Story:** Là một người vận hành, tôi muốn mở module Insights là thấy danh sách dashboard của site và tạo mới nhanh, để bắt đầu dựng bảng điều khiển.

#### Acceptance Criteria

1. THE module `apps/studio/src/modules/insights/` SHALL có trang list (route `/insights`, cả hai biến thể Admin_Base) hiển thị các dashboard (name, icon, màu, số panel) dạng card/grid; mỗi card link đến dashboard view.
2. THE trang list SHALL có nút "New dashboard" mở form tạo (name bắt buộc, icon/color/note optional) → `POST /api/v1/dashboards`; tạo xong điều hướng vào dashboard mới.
3. WHEN chưa có dashboard nào, THE trang SHALL hiển thị empty state rõ ràng kèm CTA tạo mới.
4. THE route Insights SHALL đăng ký trong `router.tsx` theo pattern hiện có: `createRoute` con của `adminLayoutRoute` cho `/insights` và một twin `/$adminPath/insights` (kế thừa pattern mission-control).

### Requirement 6: Studio — dashboard view dạng grid panel

**User Story:** Là một người vận hành, tôi muốn xem một dashboard với các panel sắp theo lưới và kéo-thả/resize được, để tự bố trí bảng điều khiển theo nhu cầu.

#### Acceptance Criteria

1. THE dashboard view (route `/insights/$dashboardId`, cả hai biến thể Admin_Base) SHALL render các panel theo Grid_Position của chúng trên một lưới; mỗi panel là một component theo `type`.
2. THE view SHALL cho kéo-thả và resize panel; khi thả, vị trí mới SHALL được lưu (`PATCH /panels/:pid` với `position`). Lựa chọn thư viện (react-grid-layout vs CSS grid đơn giản) là quyết định mở — mô tả ở design, default đơn giản.
3. WHEN dashboardId trong URL không tồn tại trong site hiện tại, THE view SHALL hiển thị not-found kèm link về danh sách.
4. THE view SHALL có nút "Add panel" mở Panel editor (Req 7) và nút "Edit"/"Delete" cho dashboard.
5. THE view SHALL hỗ trợ refetch interval optional cho toàn dashboard (vd 30s/60s/off) — khi bật, mỗi panel tự refetch Panel_Result theo chu kỳ đó.

### Requirement 7: Studio — panel editor với filter builder

**User Story:** Là một biên tập viên, tôi muốn cấu hình panel (loại hiển thị, collection, hàm tổng hợp, group, filter) bằng form có cấu trúc, để dựng panel mà không phải viết JSON hay SQL.

#### Acceptance Criteria

1. THE Panel editor SHALL cho chọn `type` (6 loại), `collection` (load từ schema API của site), `aggregate` (5 hàm), `field` (chọn từ field của collection — bắt buộc khi aggregate ≠ `count`), `groupBy` optional, `limit` optional, `dateRange` optional, và `name`.
2. THE field/groupBy selector SHALL chỉ liệt kê field thuộc Field_Whitelist của collection đã chọn (lấy từ schema API) — FE không cho nhập field tùy tiện, khớp validate BE.
3. THE filter builder SHALL tạo ra một `ConditionRule` (tái dùng shape `conditions.ts`): thêm/xóa điều kiện (field + operator + value), nhóm `_and`/`_or`; output gắn vào `Panel_Query.filter`.
4. WHEN người dùng lưu panel, THE editor SHALL gọi `POST`/`PATCH` panel với `query` là object `PanelQuery` (không phải chuỗi JSON thô) và validation lỗi từ backend hiển thị tại chỗ.
5. THE editor SHALL có preview: gọi `POST /panels/:pid/data` (hoặc một dry-run endpoint nếu panel chưa lưu — mô tả ở design) để hiển thị kết quả trước khi chốt.

### Requirement 8: Studio — render panel theo loại + trạng thái

**User Story:** Là một người vận hành, tôi muốn mỗi loại panel hiển thị đúng cách và biết khi nào đang tải / rỗng / lỗi, để đọc dashboard mà không bị nhầm dữ liệu cũ với dữ liệu mới.

#### Acceptance Criteria

1. THE panel `metric` SHALL hiển thị một con số lớn (+ nhãn); `timeSeries`/`bar`/`pie` SHALL render chart; `list`/`table` SHALL render danh sách/bảng từ Panel_Result.
2. Mỗi panel SHALL có ba trạng thái rõ ràng: loading (skeleton/spinner), empty (query hợp lệ nhưng 0 dòng), error (hiển thị message từ `{ errors[0].message }`) — lỗi một panel KHÔNG làm sập cả dashboard.
3. THE lựa chọn thư viện chart (recharts vs thư viện nhẹ) là quyết định mở — design nêu rõ default và lý do; component chart SHALL nhận data đã chuẩn hóa từ Panel_Result, không tự gọi API.
4. THE panel render SHALL hiển thị độ tươi dữ liệu (vd "updated 12s ago") từ `meta.executedAt`.

### Requirement 9: Tái dùng materialized table cho panel nặng (optional path)

**User Story:** Là một maintainer, tôi muốn panel chạy trên collection lớn không gây tải DB mỗi lần render, để dashboard vẫn nhanh khi dữ liệu phình to.

#### Acceptance Criteria

1. THE design SHALL mô tả cách một panel có thể trỏ tới một materialized collection (`materializedCollections`, `materialize-service.ts`) thay vì bảng `items` gốc, khi aggregate nặng hoặc lặp lại với tần suất cao.
2. THE quyết định dùng materialized hay không SHALL là tùy chọn cấu hình panel (vd `options.source = 'items' | 'materialized'`), mặc định `items`; KHÔNG bắt buộc cho v1.
3. WHEN dùng materialized, THE service SHALL vẫn áp các bất biến bảo mật của Req 3 (whitelist field, filter siteId) trên bảng materialized tương ứng.

### Requirement 10: Tương thích và chất lượng

**User Story:** Là một maintainer, tôi muốn tính năng mới tuân chuẩn repo và không phá vỡ phần đã có, để rollout an toàn.

#### Acceptance Criteria

1. THE migration mới SHALL viết tay + cập nhật journal; `pnpm -F @lumibase/database db:migrate` chạy sạch trên DB mới.
2. THE `insights-service.ts` SHALL có service test cover: aggregate `count`/`sum`/`groupBy`; từ chối field ngoài whitelist; từ chối collection cross-tenant; filter Condition_Rule áp đúng.
3. THE route handlers SHALL có integration test cover: CRUD scope siteId, 404 cross-tenant, validate `panelQuerySchema` khi tạo panel.
4. THE Studio module SHALL có component test cho: filter builder sinh `ConditionRule` đúng, panel ba trạng thái (loading/empty/error), lưu panel gửi `query` là object.
5. `pnpm typecheck` SHALL pass; không dùng `any`; dùng `import type` cho type-only imports; mọi query domain filter `siteId`.
6. THE response của mọi endpoint mới SHALL theo `{ data: T, meta? }` hoặc `{ errors: [...] }`.
