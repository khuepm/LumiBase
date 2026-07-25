---
version: 1
lastUpdated: 2026-07-05T11:00:40.127Z
sourceLang: en
translatedFrom: en
sourceHash: 8ea669829ae0efac
mtEngine: claude
syncStatus: machine-translated
---

# Xác thực JWT ngoài (External JWT)

LumiBase có thể xác thực người dùng và dịch vụ qua các JWT do một nhà cung cấp
danh tính bên ngoài phát hành (Okta, Microsoft Entra, Auth0, Logto, Keycloak, Cloudflare
Access, …). Token được trình dưới dạng `Authorization: Bearer <jwt>` và được xác minh
dựa trên **JWKS công khai** của issuer — LumiBase không lưu bí mật nào cho issuer.

Đây là một khả năng **nhạy cảm về bảo mật** vì nó bỏ qua đăng nhập nội bộ.
Thiết kế theo hướng fail-closed và default-deny.

## Cách hoạt động

Với mỗi site, một admin đăng ký một hoặc nhiều **issuer đáng tin cậy** tại
`/api/v1/admin/auth/issuers`. Trên mỗi request mang một bearer token, chuỗi
xác thực (nằm giữa nhánh API-key và nhánh JWT nội bộ):

1. Giải mã token **không xác minh** chỉ để đọc `iss` và `alg`.
2. Khớp `iss` với một issuer đáng tin cậy **cho site của request**. Không khớp → token
   bị bỏ qua và chuỗi rơi xuống xác thực nội bộ (`skip`).
3. Từ chối token nếu `alg` của nó không nằm trong allowlist của issuer (chỉ có thể
   chứa các thuật toán bất đối xứng — `RS*`/`ES*`).
4. Xác minh chữ ký và `iss`/`aud`/`exp`/`nbf` (với độ lệch đồng hồ đã cấu hình)
   dựa trên JWKS của issuer.
5. Thực thi cổng đa tenant: nếu issuer ánh xạ một claim `siteId`, nó phải
   bằng site của request.
6. Ánh xạ (các) claim role của token sang các role LumiBase qua `roleMapping`
   (default-deny — không ánh xạ → 403, không bao giờ ngầm định admin), tùy chọn
   lùi về `defaultRoleId`.
7. Giải quyết người dùng theo `externalId`; với JIT bật, tạo người dùng và một
   thành viên site để phân quyền giải quyết bình thường.

Một khi một issuer khớp (bước 2), **mọi** thất bại tiếp theo là một lần từ chối
fail-closed — request không bao giờ âm thầm lùi về xác thực nội bộ.

## Mô hình đe dọa & giảm thiểu

| Đe dọa | Giảm thiểu |
|--------|------------|
| Token giả mạo / sai chữ ký | Chữ ký được xác minh dựa trên JWKS công khai của issuer; fail-closed nếu không lấy được JWKS |
| Leo thang đặc quyền (mọi token → admin) | Ánh xạ role **default-deny**; admin chỉ qua một mục `roleMapping` trỏ đến một role có `adminAccess`; bộ xác minh không bao giờ suy ra admin |
| Tái dùng token xuyên tenant (token site A trên site B) | Issuer được chọn từ tập đáng tin cậy của site của request; mọi claim `siteId` phải bằng site của request; cùng `iss` trên hai site là hai config độc lập |
| Nhầm lẫn thuật toán (RS256 → HS256) | Allowlist chỉ bất đối xứng; `HS*` và `none` bị từ chối; xác minh HS256 nội bộ nằm ở một nhánh riêng, không liên quan |
| Token bị thu hồi / issuer bị gỡ | Tắt/xóa một issuer có hiệu lực trong vòng TTL cache issuer-config; các bearer JWT vẫn hợp lệ đến `exp` (dùng vòng đời token IdP ngắn) |
| Rò rỉ thông tin | Token thô không bao giờ được ghi log; lỗi trả ra ngoài dùng mã tổng quát (`UNAUTHENTICATED`/`FORBIDDEN`); lý do cụ thể chỉ đi vào log máy chủ |

## Cấu hình một issuer

```jsonc
POST /api/v1/admin/auth/issuers
{
  "issuer": "https://your-tenant.okta.com/",
  "jwksUri": "https://your-tenant.okta.com/oauth2/v1/keys",   // or discoveryUrl
  "audience": "lumibase-api",
  "algorithms": ["RS256"],
  "claimMapping": { "email": "email", "roles": "groups", "externalId": "sub" },
  "roleMapping": { "Editors": { "systemKey": "member" }, "Admins": { "systemKey": "administrator" } },
  "jitProvisioning": true,
  "clockSkewSeconds": 60
}
```

Các URL phải là `https://` (chỉ `http://localhost` được phép trong môi trường phát triển).
`algorithms` không được chứa `HS256`/`HS384`/`HS512`/`none`.

## Quan hệ với đường dẫn Cloudflare Access

Nhánh Cloudflare Access hiện có (tin cậy header `cf-access-jwt-assertion`)
được giữ nguyên để tránh hồi quy. Lưu ý nó hiện cấp admin cho
bất kỳ token Access hợp lệ nào — nên ưu tiên đường dẫn external-JWT này với ánh xạ role
tường minh cho các IdP không phải CF; gộp CF Access vào một issuer có thể cấu hình là một cải tiến
trong tương lai.
