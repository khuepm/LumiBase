# Tasks — GraphQL Query Cost Limiting

> Điều kiện hoàn thành: chạy `pnpm -F @lumibase/cms test`, `turbo run typecheck` (recursive), và rà **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done.

- [x] 1. Tạo `apps/cms/src/graphql/cost-limit.ts`
  - [x] 1.1 `costLimitRule(opts)` — visitor `OperationDefinition`, gọi `costOfSelectionSet` từ root với multiplier=1 (Req 1.1, 1.3)
  - [x] 1.2 `costOfSelectionSet(selectionSet, inheritedMultiplier, context, opts, visitingFragments)` đệ quy: Field cộng `inheritedMultiplier * (1 + subtree)`, bỏ qua field `__*` (Req 1.2, 1.4)
  - [x] 1.3 `listMultiplier(field, opts)`: đọc `first|last|limit|pageSize` là `IntValue`, clamp `[1, maxListMultiplier]`; vắng mặt/Variable → `defaultListSize` (Req 2.1–2.3, 2.5)
  - [x] 1.4 Xử lý `InlineFragment` + `FragmentSpread` (tra fragment định nghĩa qua `context.getFragment`, chống cycle bằng `Set`) (Req 1.5 alias, chống né qua fragment)
  - [x] 1.5 `context.reportError(new GraphQLError('Query exceeds the maximum cost of ${maxCost}.', { nodes: [node] }))` khi vượt trần (Req 1.3, 1.6)

- [x] 2. Wiring vào `apps/cms/src/graphql/yoga.ts`
  - [x] 2.1 Thêm helper `gqlInt(v, fallback)` (khuôn `envInt` của rate-limit) (Req 3.2)
  - [x] 2.2 Trong `hardeningPlugin.onValidate`, `addValidationRule(costLimitRule({...}))` cạnh `depthLimitRule`, đọc env `LUMIBASE_GQL_MAX_COST` / `LUMIBASE_GQL_DEFAULT_LIST_SIZE` / `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` với default 1000/20/100 (Req 3.1–3.3)

- [x] 3. Khai báo type env
  - [x] 3.1 Thêm 3 biến `LUMIBASE_GQL_*` vào `AppEnv['Bindings']` trong `apps/cms/src/env.ts` (cạnh `LUMIBASE_RATE_LIMIT_*`)

- [x] 4. Test (mở rộng `apps/cms/src/graphql/__tests__/hardening.test.ts` — cùng file với depth-limit test)
  - [x] 4.1 Dùng `validate(buildSiteSchema(...), parse(doc), [costLimitRule(opts)])`; phủ: rộng-nông vượt trần; `limit: N` lớn; alias trùng cộng dồn; clamp `limit` khổng lồ về `maxListMultiplier`; `__typename` miễn cost; field ẩn trong fragment spread vẫn bị tính; query hợp lệ đi qua (Req 4.1)
  - [x] 4.2 Khẳng định message nêu `maxCost` và validate fail ở tầng validate, trước execute (Req 4.2)
  - [x] 4.3 Test trần thay đổi có hiệu lực — truyền `maxCost` khác trực tiếp vào rule (env→rule đã đơn giản, phủ ở test wiring của `gqlInt` không cần thiết) (Req 4.3)
  - [x] 4.4 Depth-limit + introspection test cũ vẫn xanh (Req 4.4)
  - Ghi chú trung thực: **nested-list multiplier (list-trong-list) chưa có test riêng** — schema test hiện chỉ có root list `articles`; logic nhân lồng nhau qua đệ quy đã có nhưng chưa được test qua một relation o2m. Đề xuất bổ sung khi thêm collection có relation vào fixture test (không chặn merge — logic single-level đã phủ).

- [x] 5. Verify & DoD
  - [x] 5.1 `pnpm -F @lumibase/cms test graphql/__tests__/hardening.test.ts` 13/13 xanh; `pnpm -F @lumibase/cms typecheck` sạch. **Lưu ý:** `pnpm turbo run typecheck` (recursive) fail ở `@lumibase/extension-cli` do **thiếu `node_modules` trong worktree** (lỗi môi trường pre-existing: "Cannot find type definition file for 'node'"), KHÔNG liên quan thay đổi này.
  - [x] 5.2 Ghi kết quả vào Setup Impact Registry — hàng #78, verdict `n/a` (thuần API hardening; 3 env mới là `Bindings` optional có default, không phải settings-DB key / không đụng setup wizard)

---

**Implementation status:** Implemented 2026-07-17. `cost-limit.ts` + wiring in `yoga.ts` + env types + 9 new tests in `hardening.test.ts` (13/13 pass, cms typecheck clean). Follow-up test gap noted: nested-list multiplier lacks a dedicated case (needs a relation in the test fixture).
