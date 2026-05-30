# Marketplace cho Extensions

LumiBase Marketplace cho phép publish và install extension đã được **ký số** (signed bundle). Bundle bị verify bằng SHA-256 + ed25519/RSA-PSS qua WebCrypto trước khi mount.

## Tables

`extensions` (xem `data-model.md` mục 7) có thêm các cột marketplace từ POST-GA5:

| Column | Mục đích |
|--------|----------|
| `signature` | Detached signature (base64) trên SHA-256 của bundle |
| `signatureAlg` | Algorithm: `ed25519` hoặc `rsa-pss-sha256` |
| `publisherKeyId` | Key ID dùng để sign — lookup vào registry |
| `publisher` | Tên organization/author |
| `marketplaceSlug` | Slug để build public detail URL |
| `publishedAt` | Null khi chưa publish |
| `bundleSha256` | SHA-256 hex của bundle để verify integrity |

## Public keys registry

Public keys được khai báo trong env var `MARKETPLACE_PUBLIC_KEYS` dưới dạng JSON map:

```json
{
  "lumibase-official-2025": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "vendor-acme-2025-01":     "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

Loaded một lần khi router init, không cache lâu dài (có thể rotate qua env update + redeploy).

## API endpoints

```
GET  /api/v1/marketplace/extensions             List published extensions
GET  /api/v1/marketplace/extensions/:slug       Detail (kèm signature)
POST /api/v1/marketplace/extensions/:slug/install   Install vào site hiện tại
POST /api/v1/marketplace/publish                Publish một extension đã upload
```

Implementation: `apps/cms/src/routes/marketplace.ts`.

## Verification flow

Khi `POST /install`:

1. Fetch bundle từ `bundleUrl` (R2/S3/external).
2. Recompute SHA-256 → so sánh với `bundleSha256`.
3. Lookup `publisherKeyId` trong `MARKETPLACE_PUBLIC_KEYS`.
4. Verify `signature` qua `crypto.subtle.verify(algorithm, key, signatureBytes, sha256Bytes)`.
5. Nếu thất bại → reject install, không mount.
6. Nếu thành công → ghi extension vào DB cho `siteId` hiện tại với `enabled: false` mặc định, admin enable thủ công.

## Publish flow

`POST /publish` yêu cầu:

- Bundle đã upload (URL trong R2/S3).
- SHA-256 hex chính xác.
- Signature + `publisherKeyId`.
- Slug duy nhất + `publisher` info.

Chỉ admin (capability `marketplace:publish`) được phép.

## Roadmap

- [x] Studio UI marketplace browser (browse + 1-click install).
- [x] Versioning + auto-update notifications.
- [ ] Public marketplace site (apps/marketplace).
- [ ] Revenue sharing cho commercial extensions.

## Cấu trúc Phiên bản & Thông báo Cập nhật (Versioning & Auto-update)

### 1. Mô hình Phiên bản (Versioning Model)
Để hỗ trợ nhiều phiên bản của một tiện ích mở rộng trong hệ thống:
* **Định danh Tiện ích (Identity):** `marketplaceSlug` đại diện cho định danh duy nhất của tiện ích mở rộng trên Marketplace (ví dụ: `custom-analytics`).
* **Phiên bản (SemVer):** Cột `version` tuân thủ chuẩn Semantic Versioning (ví dụ: `1.0.0`, `1.1.0`).
* **Global Extensions (Marketplace Registry):** Các hàng có `siteId IS NULL` lưu trữ các phiên bản được xuất bản trên Marketplace. Một tiện ích có thể có nhiều hàng global đại diện cho các phiên bản khác nhau. Phiên bản mới nhất được xác định là phiên bản có số SemVer cao nhất có `publishedAt IS NOT NULL`.
* **Installed Extensions (Tenant):** Khi cài đặt, phiên bản cụ thể được sao chép vào site của tenant (`siteId = activeSiteId`). Tại một thời điểm, một site chỉ có tối đa một phiên bản hoạt động của tiện ích đó.

### 2. Luồng Kiểm tra Cập nhật (Update Check Flow)
Hệ thống cung cấp một API kiểm tra cập nhật khả dụng cho các tiện ích đã cài đặt trên site:

```
GET /api/v1/marketplace/updates
```

**Thuật toán xử lý:**
1. Lấy danh sách các tiện ích đã cài đặt trên site hiện tại từ bảng `extensions` (các hàng có `siteId = activeSiteId`).
2. Với mỗi tiện ích đã cài đặt, truy vấn bảng `extensions` các hàng global (`siteId IS NULL`) có cùng `marketplaceSlug`.
3. Lọc ra các phiên bản global được xuất bản (`publishedAt IS NOT NULL`) có số phiên bản lớn hơn phiên bản hiện tại.
4. Trả về danh sách các tiện ích có bản cập nhật mới nhất, bao gồm `version`, `bundleUrl`, và `manifest` mới.

### 3. Thông báo tự động (Auto-update Notifications)
* **Kích hoạt (Trigger):** Khi gọi `POST /api/v1/marketplace/publish` để xuất bản một phiên bản tiện ích mới thành công.
* **Bộ điều phối (Dispatcher):** Hệ thống quét toàn bộ các site đang cài đặt tiện ích đó ở phiên bản cũ hơn.
* **Kênh thông báo:** Gửi thông báo bảo mật loại `marketplace.extension.update_available` vào hòm thư nội bộ của các quản trị viên site (inbox notification) và kích hoạt webhook thông báo.
