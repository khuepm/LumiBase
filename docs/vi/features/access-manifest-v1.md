---
version: 1
lastUpdated: 2026-08-02T19:10:57.033Z
sourceLang: en
translatedFrom: en
sourceHash: 45474f4e992dcfdc
mtEngine: manual
syncStatus: human-translated
---

# Access Manifest `lumibase.access@v1`

File schema: [`docs/schemas/lumibase.access.v1.schema.json`](../../schemas/lumibase.access.v1.schema.json).

Đây là hợp đồng (contract) cho việc import/export cấu hình truy cập:

- các role (vai trò);
- các policy (chính sách);
- các hàng quyền (permission rows);
- các ràng buộc role/user/API-key;
- metadata của API key;
- metadata truy cập extension.

Nó sử dụng các key cố định (stable keys) thay vì DB id và tuyệt đối không bao giờ chứa API key dạng plaintext, static token, password hash, mã khôi phục (backup codes), tài liệu token SCIM, hoặc webhook secret.

## Root object

Các trường root bắt buộc là `schema`, `version`, `kind`, `siteKey`, `roles`, `policies`, và `bindings`.

```json
{
  "schema": "lumibase.access@v1",
  "version": 1,
  "kind": "lumibase.access",
  "siteKey": "default",
  "roles": [],
  "policies": [],
  "bindings": {},
  "apiKeys": [],
  "extensions": []
}
```

## Stable keys

Các key cố định khớp với:

```txt
^[a-z][a-z0-9_:-]{1,127}$
```

Quá trình import sẽ ánh xạ các key thành DB id bên trong một transaction.

## Policies

Policy sở hữu các hàng quyền của chính nó. Các hàng quyền là duy nhất dựa trên:

```txt
policy.key + collection + action
```

Các hành động v1 được hỗ trợ:

```txt
create
read
update
delete
share
read_decrypted
execute
configure
install
enable
grant_capability
```

Các hành động vận hành dành cho các đối tượng hệ thống như truy cập extension.

## Bindings

Bindings ở cấp cao nhất (top-level):

- `rolePolicies`
- `userRoles`
- `userPolicies`
- `apiKeyRoles`
- `apiKeyPolicies`

Các bản export ở môi trường production nên bỏ qua tư cách thành viên của người dùng theo mặc định nếu nó chứa PII.

## API keys

Export API key chỉ bao gồm metadata. Không bao giờ export secret ở dạng plaintext hoặc token hash. Quá trình import có thể tạo các giữ chỗ (placeholders) bị vô hiệu hóa hoặc yêu cầu `--generate-secrets`.

## Extension access

Metadata truy cập extension là tùy chọn trong v1. Quyền truy cập hiệu lực vẫn đến từ các hàng quyền trên `extensions`, `extension_modules`, `extension_endpoints`, và `extension_operations`.

## Import modes

| Mode | Hành vi |
|---|---|
| `dry-run` | Phân tích, validate, diff, kiểm tra xung đột, không ghi bất cứ thứ gì. |
| `merge` | Upsert các manifest key; không xóa các đối tượng nằm ngoài manifest. |
| `replace-managed` | Xóa các đối tượng được quản lý bởi access import nhưng vắng mặt trong manifest. |
| `replace-all` | Thay thế toàn bộ cấu hình truy cập của site; chỉ dành cho các môi trường mới/sao chép (cloned). |
