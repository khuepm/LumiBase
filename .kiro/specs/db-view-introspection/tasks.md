# Tasks — DB View Introspection & Field Bootstrap

> Status: **Proposal / Roadmap**. Chưa bắt đầu.

## Phase 1 — Introspection backend
- [ ] 1.1 `[Proposal]` Cổng `SchemaIntrospector` trong [`packages/runtime/src/`](packages/runtime/src/) (Req 1.3).
- [ ] 1.2 Postgres adapter (`information_schema` + `pg_catalog` PK/FK) — phủ CF Hyperdrive/Neon + Docker (Req 1.5).
- [ ] 1.3 SQLite adapter (`PRAGMA`) nếu dev dùng SQLite.
- [ ] 1.4 `GET /api/v1/db/objects?registered=false` — loại bảng hệ thống LumiBase (Req 1.2, 5.2).
- [ ] 1.5 `GET /api/v1/collections/:name/introspect` — reconcile catalogued/uncatalogued/drift + counts (Req 1.1, 2.5).
- [ ] 1.6 Filter `site_id`, chỉ trả metadata, không trả rows (Req 1.4, 5).
- [ ] 1.7 Test: bảng có/không FK; view không PK; bảng hệ thống bị ẩn.

## Phase 2 — Type_Map
- [ ] 2.1 `db-type-map.ts` phủ các kiểu ở Req 3.1.
- [ ] 2.2 Suy `nullable/length/precision/scale/unique/indexed` từ introspect (Req 3.3).
- [ ] 2.3 Fallback `string/input` + cảnh báo cho kiểu lạ (Req 3.4).

## Phase 3 — UI chấm than + bootstrap
- [ ] 3.1 `fields-tab.tsx`: hợp nhất physical + records, render ⚠ (lucide `triangle-alert`) + counts (Req 2).
- [ ] 3.2 Phân biệt Uncatalogued vs Drift vs Catalogued (Req 2.4).
- [ ] 3.3 `field-inspector.tsx` mode `configure-existing-column` — khoá tên/kiểu, nạp Type_Map (Req 4.1).
- [ ] 3.4 Save → `PUT .../fields/:field` không chạy ALTER TABLE (Req 4.2).
- [ ] 3.5 Audit classification + encrypted cho pii/phi; invalidate cache; bỏ ⚠ (Req 4.3–4.5).
- [ ] 3.6 HITL `ai_approvals` nếu agent thực hiện schema:write (Req 4.6, rule #4).

## Phase 4 — An toàn
- [ ] 4.1 Quyền quản trị schema bắt buộc (Req 5.1).
- [ ] 4.2 Mark non-RLS cho bảng thiếu `site_id` + xác nhận (Req 5.3).
- [ ] 4.3 Ghi `activity` cho mọi bootstrap (Req 5.4).

## Phase 5 — Definition of Done
- [ ] 5.1 Setup Impact Registry update [`.kiro/specs/admin-setup-wizard/setup-impact.md`](.kiro/specs/admin-setup-wizard/setup-impact.md).
- [ ] 5.2 `turbo run typecheck` recursive ([[typecheck-recursive-vs-per-package]]).
- [ ] 5.3 Doc người dùng: "Đăng ký bảng DB có sẵn".
- [ ] 5.4 Checklist [`.kiro/steering/definition-of-done.md`](.kiro/steering/definition-of-done.md).
