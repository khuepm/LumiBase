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

- [ ] Studio UI marketplace browser (browse + 1-click install).
- [ ] Versioning + auto-update notifications.
- [ ] Public marketplace site (apps/marketplace).
- [ ] Revenue sharing cho commercial extensions.
