# Design — GraphQL Query Cost Limiting

## Bối cảnh code hiện tại

- `apps/cms/src/graphql/yoga.ts` — Yoga instance. `hardeningPlugin.onValidate` (dòng 65-73) hiện `addValidationRule(depthLimitRule(MAX_QUERY_DEPTH))` và, ngoài dev, `NoSchemaIntrospectionCustomRule`. `context` ở đây là **server context** (`{ honoCtx }`), có sẵn trước khi full GraphQL context được build.
- `apps/cms/src/graphql/depth-limit.ts` — mẫu rule dependency-free (`GraphQLError`, `Kind`, visitor `Field`, `countFieldDepth(ancestors)`). Cost-limit sẽ bám đúng khuôn này.
- `apps/cms/src/middleware/rate-limit.ts:35-39` — mẫu `envInt(value, fallback)` để parse env an toàn; tái dùng khuôn parse (không import chéo — copy helper cục bộ như depth-limit đã tự chứa).

Điểm chèn là **cùng một chỗ** với depth-limit; không đụng tới schema-builder, resolver, hay middleware chain.

## Kiến trúc

### Vì sao chấm điểm tĩnh từ AST (không dùng envelop cost plugin bên thứ ba)

Depth-limit đã chọn dependency-free có chủ đích (comment ở `depth-limit.ts:3`). Giữ nhất quán: cost-rule cũng thuần `graphql`, không thêm `@envelop/*` hay `graphql-cost-analysis` vào bundle Workers (bundle size + rủi ro tương thích edge). Chấm điểm tĩnh đủ cho defence-in-depth: nó chặn được hình dạng query đắt trước khi resolver chạy, đúng lớp mối đe doạ (client gửi query độc hại), mà không cần đo runtime.

### Thuật toán cost

Một hàm đệ quy trên `SelectionSet`, trả về cost của subtree:

```
cost(selectionSet, inheritedMultiplier):
  total = 0
  for each selection:
    if Field:
      if name starts with "__": continue        # introspection miễn phí
      fieldBase = 1
      childMultiplier = listMultiplier(field)    # 1 nếu không phải list-with-pagination
      subtree = field.selectionSet
                  ? cost(field.selectionSet, childMultiplier)
                  : 0
      total += inheritedMultiplier * (fieldBase + subtree)
    if InlineFragment / FragmentSpread:
      total += cost(fragmentSelectionSet, inheritedMultiplier)   # theo type condition
  return total
```

- `inheritedMultiplier` bắt đầu = 1 ở operation root.
- List lồng nhau nhân multiplier một cách tự nhiên qua đệ quy (Req 2.4).
- Fragment (`...spread` và inline) được đi vào để cost phản ánh field thật (nếu không, client né trần bằng cách gói field vào fragment). Fragment definitions tra từ `context.getDocument()`; đề phòng vòng lặp fragment bằng một `Set` các fragment đang thăm.

### `listMultiplier(field)`

```
listMultiplier(field):
  for argName in ["first", "last", "limit", "pageSize"]:
    arg = field.arguments.find(a => a.name === argName)
    if arg && arg.value.kind === IntValue:
      return clamp(parseInt(arg.value.value), 1, MAX_LIST_MULTIPLIER)
  return DEFAULT_LIST_SIZE     # vắng mặt hoặc là Variable → cỡ mặc định
```

- `Variable` (ví dụ `first: $n`) không đọc được ở validate-time (chưa có variables trong initial context) → dùng `DEFAULT_LIST_SIZE`. Đây là đánh đổi có ý thức: bảo thủ nhưng không chặn nhầm; trần cost + default list size vẫn bao được phần lớn lạm dụng. Ghi rõ trong comment.
- `clamp(x, 1, MAX_LIST_MULTIPLIER)` chặn tràn số học từ `first: 999999999` và làm cho một `first` khổng lồ tự nó vượt `Max_Cost` xác định.

### Rule shape

```ts
export function costLimitRule(opts: {
  maxCost: number;
  defaultListSize: number;
  maxListMultiplier: number;
}) {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node) {
      const total = costOfSelectionSet(node.selectionSet, 1, context, opts, new Set());
      if (total > opts.maxCost) {
        context.reportError(
          new GraphQLError(`Query exceeds the maximum cost of ${opts.maxCost}.`, { nodes: [node] }),
        );
      }
    },
  });
}
```

Dùng visitor `OperationDefinition` (một lần/operation) thay vì visitor `Field` — vì cost là thuộc tính của cả cây, tính một lần ở gốc gọn hơn cộng dồn qua ancestors như depth-limit. Vẫn báo mọi operation vượt trần (Req 1.6) vì visitor chạy cho từng `OperationDefinition` trong document.

## Wiring vào `yoga.ts`

```ts
const MAX_QUERY_DEPTH = 12;

function gqlInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const hardeningPlugin: Plugin<ServerContext> = {
  onValidate({ addValidationRule, context }) {
    addValidationRule(depthLimitRule(MAX_QUERY_DEPTH));
    const honoCtx = (context as Partial<ServerContext> | undefined)?.honoCtx;
    const env = honoCtx?.env ?? {};
    addValidationRule(
      costLimitRule({
        maxCost: gqlInt(env.LUMIBASE_GQL_MAX_COST, 1000),
        defaultListSize: gqlInt(env.LUMIBASE_GQL_DEFAULT_LIST_SIZE, 20),
        maxListMultiplier: gqlInt(env.LUMIBASE_GQL_MAX_LIST_MULTIPLIER, 100),
      }),
    );
    if (honoCtx && !isDevEnv(honoCtx)) {
      addValidationRule(NoSchemaIntrospectionCustomRule);
    }
  },
};
```

Ba biến env mới cần thêm khai báo type vào `AppEnv['Bindings']` (nơi các `LUMIBASE_*` khác được khai báo — tìm `LUMIBASE_RATE_LIMIT_MAX` trong `env.ts`).

## Rủi ro & đánh đổi

| Rủi ro | Giảm thiểu |
|---|---|
| False positive chặn query Studio hợp lệ | Default `maxCost=1000` hào phóng; test Req 4.1 dùng query Studio thực; env cho phép nới nhanh không cần deploy |
| `Variable` pagination bị định giá `DEFAULT_LIST_SIZE` (có thể dưới thực tế) | Có ý thức — bảo thủ; kết hợp rate-limit + depth-limit; có thể nâng cấp sau bằng cách đọc variables ở execute-phase plugin (ngoài scope) |
| Fragment cycle gây đệ quy vô hạn | `Set` fragment đang thăm; GraphQL spec cấm fragment cycle nên validate khác sẽ bắt, đây là phòng thủ kép |
| Tràn số với `first` khổng lồ | `clamp(_, 1, maxListMultiplier)` |

## Không thay đổi

- Không đụng `depth-limit.ts`, schema-builder, resolver, middleware chain.
- Không thêm dependency.
- Introspection/GraphiQL ở dev giữ nguyên (cost miễn field `__*`).
