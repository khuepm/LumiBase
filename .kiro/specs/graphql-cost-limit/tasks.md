# Tasks — GraphQL Query Cost Limiting

> Điều kiện hoàn thành: chạy `pnpm -F @lumibase/cms test`, `turbo run typecheck` (recursive), và rà **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done.

- [ ] 1. Tạo `apps/cms/src/graphql/cost-limit.ts`
  - [ ] 1.1 `costLimitRule(opts)` — visitor `OperationDefinition`, gọi `costOfSelectionSet` từ root với multiplier=1 (Req 1.1, 1.3)
  - [ ] 1.2 `costOfSelectionSet(selectionSet, inheritedMultiplier, context, opts, visitingFragments)` đệ quy: Field cộng `inheritedMultiplier * (1 + subtree)`, bỏ qua field `__*` (Req 1.2, 1.4)
  - [ ] 1.3 `listMultiplier(field, opts)`: đọc `first|last|limit|pageSize` là `IntValue`, clamp `[1, maxListMultiplier]`; vắng mặt/Variable → `defaultListSize` (Req 2.1–2.3, 2.5)
  - [ ] 1.4 Xử lý `InlineFragment` + `FragmentSpread` (tra fragment định nghĩa qua `context`, chống cycle bằng `Set`) (Req 1.5 alias, chống né qua fragment)
  - [ ] 1.5 `context.reportError(new GraphQLError('Query exceeds the maximum cost of ${maxCost}.', { nodes: [node] }))` khi vượt trần (Req 1.3, 1.6)

- [ ] 2. Wiring vào `apps/cms/src/graphql/yoga.ts`
  - [ ] 2.1 Thêm helper `gqlInt(v, fallback)` (khuôn `envInt` của rate-limit) (Req 3.2)
  - [ ] 2.2 Trong `hardeningPlugin.onValidate`, `addValidationRule(costLimitRule({...}))` cạnh `depthLimitRule`, đọc env `LUMIBASE_GQL_MAX_COST` / `LUMIBASE_GQL_DEFAULT_LIST_SIZE` / `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` với default 1000/20/100 (Req 3.1–3.3)

- [ ] 3. Khai báo type env
  - [ ] 3.1 Thêm 3 biến `LUMIBASE_GQL_*` vào `AppEnv['Bindings']` trong `apps/cms/src/env.ts` (cạnh `LUMIBASE_RATE_LIMIT_*`)

- [ ] 4. Test `apps/cms/src/graphql/cost-limit.test.ts`
  - [ ] 4.1 Dựng schema tối thiểu + dùng `graphql` `validate([...rules], doc)`; phủ: rộng-nông vượt trần; `first: N` lớn; alias trùng cộng dồn; list lồng nhân multiplier; `__typename`/introspection miễn cost; query hợp lệ đi qua (Req 4.1)
  - [ ] 4.2 Khẳng định message nêu `maxCost` và validate fail trước execute (Req 4.2)
  - [ ] 4.3 Test override `LUMIBASE_GQL_MAX_COST` có hiệu lực (Req 4.3)
  - [ ] 4.4 Xác nhận depth-limit test cũ vẫn xanh (Req 4.4)

- [ ] 5. Verify & DoD
  - [ ] 5.1 `pnpm -F @lumibase/cms test` + `turbo run typecheck` (recursive) xanh
  - [ ] 5.2 Ghi kết quả vào Setup Impact Registry (dự kiến `n/a` — thuần API hardening, không đụng setup wizard)

---

**Implementation status:** Not started — spec only.
