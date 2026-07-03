# Design Document — Insights / Dashboard

## Overview

Thêm module **Insights** (Directus-inspired BI cho nội dung): bảng `dashboards` + `panels`, service `insights-service.ts` chạy aggregate query AN TOÀN trên collection, route group `/api/v1/dashboards`, và Studio module `insights/` (list → grid view → panel editor → render). Backend là phần rủi ro nhất vì query do người dùng cấu hình → kỷ luật bảo mật là trục chính của thiết kế.

Nguyên tắc:
- **Panel_Query là contract chung** ở `@lumibase/shared` (Zod) — FE builder sinh ra, BE thực thi, SDK re-export. Không nơi nào định nghĩa lại.
- **Không raw SQL từ input.** Mọi identifier (collection/field/aggregate) qua whitelist trước khi vào Drizzle expression builder, kế thừa kỷ luật `materialize-service.ts` nhưng chặt hơn (không escape-rồi-nối).
- **Tái dùng:** `ConditionRule` từ `conditions.ts` cho filter; `StatCard` pattern từ mission-control cho panel metric; SchemaService cho Field_Whitelist.

## Architecture

### Schema mới (`packages/database/src/schema/cms.ts`)

```ts
export const dashboards = pgTable('dashboards', {
  id: text('id').primaryKey(),                       // nanoid()
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'), color: text('color'), note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({ siteIdx: index('dashboards_site_idx').on(t.siteId) }));

export const panels = pgTable('panels', {
  id: text('id').primaryKey(),                        // nanoid()
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  dashboardId: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),                       // metric|timeSeries|bar|pie|list|table
  position: jsonb('position').$type<GridPosition>().notNull(),
  query: jsonb('query').$type<PanelQuery>().notNull(),
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({ idx: index('panels_site_dashboard_idx').on(t.siteId, t.dashboardId) }));
```
Migration viết tay ([[migrations-are-hand-written]]) + journal.

### Contract chung (`packages/shared/src/schemas/insights.ts`)

```ts
export const panelQuerySchema = z.object({
  collection: z.string().min(1),
  aggregate: z.enum(['count','sum','avg','min','max']),
  field: z.string().optional(),
  groupBy: z.string().optional(),
  filter: conditionRuleSchema.optional(),            // shape của conditions.ts
  dateRange: z.object({ field: z.string(), gte: z.string().optional(), lte: z.string().optional(), preset: z.string().optional() }).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).refine(q => q.aggregate === 'count' || !!q.field, { message: 'field required for non-count aggregate' });
export type PanelQuery = z.infer<typeof panelQuerySchema>;
export type GridPosition = { x: number; y: number; w: number; h: number };
export type PanelType = 'metric'|'timeSeries'|'bar'|'pie'|'list'|'table';
```

### Service: `apps/cms/src/services/insights-service.ts`

```ts
export interface PanelResult { data: { value?: number; series?: {label:string;value:number}[]; rows?: unknown[] }; meta: { executedAt: string; rowCount: number; durationMs: number } }

export class InsightsService {
  constructor(private db: Db, private siteId: string, private schema: SchemaService) {}

  // CRUD dashboards/panels — đều filter siteId
  listDashboards(): ...; createDashboard(...); getDashboard(id); updateDashboard(id, patch); deleteDashboard(id);
  listPanels(dashboardId); createPanel(dashboardId, input); updatePanel(pid, patch); deletePanel(pid);

  async runPanel(panel: Panel, override?: { dateRange?; filter? }): Promise<PanelResult> {
    const q = { ...panel.query, ...override };
    // 1) collection tồn tại trong site?
    const col = await this.assertCollection(q.collection);               // 404/INVALID nếu không
    // 2) whitelist field
    const allowed = await this.fieldWhitelist(col);                      // schema fields + id/status/created_at/updated_at/sort
    this.assertFields(q, allowed);                                       // throw INVALID_FIELD
    // 3) build qua Drizzle expression builder — KHÔNG nối raw
    return this.executeAggregate(col, q);
  }
}
```

**executeAggregate (lõi an toàn):**
- `aggregate` resolve qua map cố định: `{ count: count(), sum: sql\`sum(...)\`, ... }` — value ngoài map không vào được.
- field truy cập JSONB qua accessor tham số hóa: `sql\`(data->>${field})::numeric\`` với `field` đã whitelist (không phải user-raw vào identifier).
- `WHERE site_id = ${this.siteId} AND deleted_at IS NULL` luôn được thêm; `siteId` từ context KHÔNG từ body.
- `filter` (ConditionRule) → WHERE tham số hóa, tái dùng builder của permission/conditions; operator lạ → bỏ qua điều kiện đó (an toàn-mặc định), không sinh SQL tuỳ tiện.
- `groupBy` → `GROUP BY (data->>${groupBy})`, `ORDER BY value DESC`, `LIMIT min(limit ?? 50, 1000)`.

### Routes: `apps/cms/src/routes/insights.ts` (mount `/api/v1/dashboards`)

```
GET    /api/v1/dashboards                              list
POST   /api/v1/dashboards                              create
GET    /api/v1/dashboards/:id
PATCH  /api/v1/dashboards/:id
DELETE /api/v1/dashboards/:id
GET    /api/v1/dashboards/:id/panels
POST   /api/v1/dashboards/:id/panels                   validate panelQuerySchema
PATCH  /api/v1/dashboards/:id/panels/:pid
PATCH  /api/v1/dashboards/:id/layout                   batch position (Req 6.2)
DELETE /api/v1/dashboards/:id/panels/:pid
POST   /api/v1/dashboards/:id/panels/:pid/data         runPanel → PanelResult
```
- Write ops: admin HOẶC quyền của collection tham chiếu (reuse PermissionService). Read `/data`: cần quyền đọc collection trong query.
- Cross-tenant: id không thuộc site → 404 `{ errors }`.
- `/data` trả `meta { executedAt, rowCount, durationMs }`.

### Studio module (`apps/studio/src/modules/insights/`)

```
modules/insights/
├─ api.ts            — SDK wrappers: listDashboards, createDashboard, runPanel, ...
├─ list-page.tsx     — /insights : card grid + New dashboard + empty state
├─ dashboard-page.tsx— /insights/$dashboardId : grid layout panel + Add panel + refetch interval
├─ panel-grid.tsx    — kéo-thả/resize → PATCH layout (react-grid-layout HOẶC CSS grid — Quyết định mở)
├─ panel-editor.tsx  — chọn type/collection/aggregate/field/groupBy/limit/dateRange + FilterBuilder + preview
├─ filter-builder.tsx— sinh ConditionRule (thêm/xóa điều kiện, nhóm _and/_or)
├─ panels/
│   ├─ metric-panel.tsx (tái dùng StatCard pattern)
│   ├─ chart-panel.tsx  (timeSeries/bar/pie — Quyết định mở: recharts default)
│   └─ table-panel.tsx  (list/table)
└─ panel-frame.tsx   — wrapper 3 trạng thái loading/empty/error + "updated Xs ago" từ meta.executedAt

router.tsx: thêm /insights + /insights/$dashboardId, mỗi route 2 biến thể Admin_Base (pattern mission-control).
```

### Sequence — render một panel

```
dashboard-page mount → useQuery panels → mỗi PanelFrame:
  useQuery(['panel-data', pid, dateRange], () => api.runPanel(...))
    BE: validate collection → whitelist field → executeAggregate (siteId scoped) → PanelResult
  loading → skeleton; success → render theo type; empty → empty state; error → errors[0].message
refetch interval (nếu bật) → React Query refetchInterval cho mọi panel-data query
```

### Sequence — preview trong editor (panel chưa lưu)

```
panel-editor "Preview" → POST /dashboards/:id/panels/preview  (dry-run, nhận PanelQuery body, KHÔNG ghi)
  hoặc nếu panel đã tồn tại: POST .../panels/:pid/data
  → PanelResult render trong editor trước khi Save
```
(Dry-run endpoint `POST /dashboards/:id/panels/preview` là Quyết định mở — đề xuất có để preview pre-save; cùng path validate.)

## Quyết định mở (chốt khi implement)

1. **Chart lib:** default `recharts` (phổ biến, tree-shakeable). Component chart nhận data đã chuẩn hoá từ PanelResult, không tự fetch.
2. **Grid lib:** default `react-grid-layout`; fallback CSS grid nếu muốn bundle nhỏ. Position vẫn lưu `{x,y,w,h}` bất kể lib.
3. **Preview endpoint:** đề xuất thêm `POST .../panels/preview` dry-run.
4. **Materialized source (Req 9):** `options.source = 'items' | 'materialized'`, default `items`; v1 chỉ cần `items`.

## Error handling

- collection/field lạ → `400 { errors: [{ code: 'INVALID_FIELD', message }] }`; editor hiển thị inline.
- id cross-tenant/không tồn tại → 404.
- panel `/data` lỗi → PanelFrame hiển thị error, các panel khác vẫn chạy (lỗi cô lập từng query).
- aggregate `sum/avg` trên field không-số → DB cast lỗi → bắt và trả `400 INVALID_FIELD` (gợi ý field số).

## Testing strategy

- Service: count/sum/groupBy ra đúng số; từ chối field ngoài whitelist; từ chối collection cross-tenant; filter ConditionRule áp đúng WHERE; siteId luôn được thêm dù body cố override.
- Route: CRUD scope siteId; 404 cross-tenant; `panelQuerySchema` reject non-count thiếu field; `/data` trả meta.
- FE: FilterBuilder sinh ConditionRule đúng; PanelFrame 3 trạng thái; Save gửi `query` là object (không JSON string); field selector chỉ liệt kê whitelist.
- Bảo mật (ưu tiên): test injection — `field: "id); DROP TABLE"` bị whitelist chặn, không chạm DB.
