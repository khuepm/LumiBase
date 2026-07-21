# Requirements Document — GraphQL Query Cost Limiting

## Introduction

Bề mặt GraphQL (`POST /api/v1/graphql`, GraphQL Yoga) hiện đã có **depth limiting** (`depthLimitRule`, `MAX_QUERY_DEPTH = 12` tại `apps/cms/src/graphql/yoga.ts:57`) và tắt introspection ở production. Tuy nhiên depth-limit **không chặn** được một lớp query rẻ về độ sâu nhưng đắt về khối lượng: query rộng theo chiều ngang (nhiều field song song), list field với `first`/`limit` lớn, hoặc alias trùng lặp cùng một field đắt nhiều lần trong một operation ở depth nông. Đây là lỗ hổng DoS còn lại (CWE-770 — Allocation of Resources Without Limits).

Spec này bổ sung một **cost/complexity limiting** validation rule (dependency-free, cùng phong cách với `depthLimitRule`) chấm điểm chi phí tĩnh của mỗi operation trước khi thực thi và từ chối operation vượt trần. Mục tiêu là defence-in-depth cùng depth-limit và rate-limit hiện có, không phải quota chính xác.

Ràng buộc kiến trúc: rule phải chạy ở tầng `onValidate` (envelop) với **initial context** (chỉ có `honoCtx`), không phụ thuộc full GraphQL context, không thêm dependency runtime, và không phá GraphiQL/introspection ở dev.

## Glossary

- **Cost_Rule**: Validation rule tĩnh tính điểm chi phí của một operation từ AST, không thực thi resolver.
- **Field_Cost**: Chi phí cơ sở của một field (mặc định 1).
- **List_Multiplier**: Hệ số nhân chi phí của subtree bên trong một list field, suy ra từ argument phân trang (`first`/`last`/`limit`/`pageSize`) hoặc một `DEFAULT_LIST_SIZE` khi vắng mặt.
- **Max_Cost**: Trần chi phí tối đa một operation được phép; vượt → validation error trước khi execute.
- **Alias_Expansion**: Việc nhiều alias trỏ cùng một field làm chi phí cộng dồn theo số alias.
- **Introspection_Field**: Field bắt đầu bằng `__` (`__schema`, `__type`, `__typename`) — miễn tính cost để GraphiQL hoạt động nơi introspection được phép.

## Requirements

### Requirement 1: Static cost scoring rule

**User Story:** Là người vận hành, tôi muốn mỗi GraphQL operation bị chấm điểm chi phí tĩnh trước khi chạy, để một query rộng-nhưng-nông không thể vắt kiệt tài nguyên server dù nó qua được depth-limit.

#### Acceptance Criteria

1. THE Cost_Rule SHALL là một `graphql` `ValidationRule` dependency-free đặt tại `apps/cms/src/graphql/cost-limit.ts`, cùng phong cách với `depthLimitRule` (không thêm package vào `apps/cms/package.json`).
2. THE Cost_Rule SHALL tính tổng chi phí của mỗi operation bằng cách duyệt AST: mỗi `Field` không phải Introspection_Field cộng `Field_Cost = 1`, và chi phí của subtree con của một list field được nhân với List_Multiplier của field đó.
3. WHEN một operation có tổng chi phí vượt `Max_Cost`, THE Cost_Rule SHALL gọi `context.reportError` với một `GraphQLError` thông báo rõ trần bị vượt (ví dụ `Query exceeds the maximum cost of ${maxCost}.`) và operation SHALL bị từ chối trước khi execute.
4. THE Cost_Rule SHALL bỏ qua (không tính cost) mọi Introspection_Field để GraphiQL/introspection giữ nguyên hoạt động nơi được phép.
5. WHEN một operation chứa nhiều alias trỏ cùng một field, THE Cost_Rule SHALL cộng dồn chi phí theo Alias_Expansion (mỗi alias là một Field độc lập trong AST nên được tính riêng).
6. THE Cost_Rule SHALL báo cáo tất cả operation vượt trần trong một document đa-operation, không dừng ở operation đầu tiên.

### Requirement 2: List multiplier từ pagination arguments

**User Story:** Là người vận hành, tôi muốn chi phí phản ánh số bản ghi một list field yêu cầu, để `items(first: 1000){ … }` bị tính đắt hơn `items(first: 10){ … }`.

#### Acceptance Criteria

1. WHEN một list field có argument phân trang literal (`first`, `last`, `limit`, hoặc `pageSize`) là một `IntValue`, THE Cost_Rule SHALL dùng giá trị đó làm List_Multiplier cho subtree con của field đó.
2. WHEN một list field không có argument phân trang literal (vắng mặt, hoặc là `Variable`), THE Cost_Rule SHALL dùng `DEFAULT_LIST_SIZE` làm List_Multiplier.
3. THE Cost_Rule SHALL kẹp (clamp) mọi List_Multiplier vào khoảng `[1, MAX_LIST_MULTIPLIER]` để một `first` cực lớn không gây tràn số học và tự nó đủ khiến operation vượt `Max_Cost` một cách xác định.
4. THE Cost_Rule SHALL nhân List_Multiplier lồng nhau (list-trong-list) để một truy vấn phân trang lồng sâu phản ánh đúng tích chi phí.
5. WHERE một field không phải list (scalar hoặc object đơn), THE Cost_Rule SHALL dùng List_Multiplier = 1 cho subtree của nó.

### Requirement 3: Cấu hình và giá trị mặc định

**User Story:** Là người vận hành, tôi muốn chỉnh trần cost và cỡ list mặc định qua env mà không cần đổi code, để tinh chỉnh theo tải thực tế.

#### Acceptance Criteria

1. THE Cost_Rule SHALL nhận `maxCost`, `defaultListSize`, và `maxListMultiplier` làm tham số, do `yoga.ts` truyền vào khi đăng ký rule (song song với `depthLimitRule(MAX_QUERY_DEPTH)`).
2. THE hardening plugin SHALL đọc cấu hình từ env (tất cả optional, có default an toàn):
   - `LUMIBASE_GQL_MAX_COST` (integer, default `1000`)
   - `LUMIBASE_GQL_DEFAULT_LIST_SIZE` (integer, default `20`)
   - `LUMIBASE_GQL_MAX_LIST_MULTIPLIER` (integer, default `100`)
   với parse an toàn (giá trị không hợp lệ → fallback về default, giống `envInt` ở `middleware/rate-limit.ts`).
3. THE Cost_Rule SHALL được thêm vào cùng `addValidationRule` với `depthLimitRule` trong `hardeningPlugin.onValidate`, chạy ở mọi môi trường (dev và production), giống depth-limit.
4. THE default `Max_Cost = 1000` SHALL cho phép các query hợp lệ thông thường của Studio/Delivery đi qua mà không sai số dương giả (xác minh bằng test ở Req 4).

### Requirement 4: Kiểm thử

**User Story:** Là maintainer, tôi muốn bộ test khẳng định rule chặn đúng query đắt và không chặn nhầm query hợp lệ, để thay đổi tương lai không âm thầm phá vỡ giới hạn.

#### Acceptance Criteria

1. THE spec SHALL có unit test cho `cost-limit.ts` (dùng `graphql` `validate` trực tiếp trên một schema tối thiểu) phủ: query rộng-nông vượt trần bị từ chối; `items(first: N)` lớn bị từ chối; alias trùng lặp cộng dồn cost; list lồng nhau nhân multiplier; introspection field miễn cost; query hợp lệ thông thường đi qua.
2. THE test SHALL khẳng định thông điệp lỗi nêu rõ `Max_Cost` và operation bị chặn ở tầng validate (không có resolver nào chạy).
3. WHEN `LUMIBASE_GQL_MAX_COST` được đặt, THE test SHALL khẳng định trần mới có hiệu lực.
4. THE existing depth-limit tests (nếu có) SHALL vẫn xanh; cost-limit không được thay đổi hành vi của depth-limit.

## Out of scope

- Cost động dựa trên chi phí resolver thực tế hoặc dữ liệu runtime (đây là chấm điểm **tĩnh** từ AST).
- Field-level cost directive/annotation trong schema (`@cost`) — có thể là spec sau; bản này dùng cost đồng nhất + list multiplier.
- Persisted-queries / query allowlisting.
- Rate limiting (đã có `middleware/rate-limit.ts`) và depth limiting (đã có `depthLimitRule`).
