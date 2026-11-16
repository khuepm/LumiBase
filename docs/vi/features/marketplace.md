---
version: 4
lastUpdated: 2026-11-16T15:30:00.700Z
sourceLang: vi
contentHash: 291ea9be1c38e004
codeVerified: 2026-11-16T15:30:00.700Z
codeVerifiedHash: 291ea9be1c38e004
codeVerifiedClaims: 32
---

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
| `downloadCount` | Tổng số lượt tải package (tăng qua `/download`) |
| `submissionStatus` | Trạng thái community submission: `pending` / `approved` / `rejected` (null = không phải submission) |
| `submittedBy` | User đã gửi extension qua luồng community |
| `isOfficial` | Cờ official do **server suy ra**: chỉ true khi tên nằm trong namespace `lumibase-` **và** bundle verify được với một key có cờ `official`. Không bao giờ lấy từ client hay manifest |
| `autoInstall` | Tự động cài khi setup bootstrap / reconcile lúc tạo site |
| `enabledByDefault` | Giá trị `enabled` ban đầu lúc cài (admin có thể tắt sau) |
| `verifiedAt` | Thời điểm verify chữ ký thành công gần nhất (điều khiển badge) |

`extension_votes` ghi lại lượt upvote trên marketplace — mỗi `(userId, marketplaceSlug)` một dòng, được đảm bảo bằng unique index nên vote là idempotent. Vote được khoá theo slug nên vẫn giữ nguyên khi lên version.

| Column | Mục đích |
|--------|----------|
| `marketplaceSlug` | Listing được vote |
| `userId` | Người vote (FK → `users`, cascade delete) |
| `createdAt` | Thời điểm vote |

## Public keys registry

Public keys được khai báo trong env var `MARKETPLACE_PUBLIC_KEYS` dưới dạng JSON map:

```json
{
  "lumibase-official-2025": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "vendor-acme-2025-01":     "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

Env map được parse lại mỗi lần resolve key, không cache lâu dài (có thể rotate qua env update + redeploy).

Ngoài env, key còn được đăng ký trong bảng `lumibase_publisher_keys` (`keyId` duy nhất, `publicKeyPem`, `publisher`, `official`, `revoked`). Khi resolve một `publisherKeyId`, dòng trong DB được ưu tiên hơn env, nên một env var bị sửa không thể đánh dấu key là official hay gỡ revoke cho nó. Key chỉ có trong env luôn được coi là third-party (`official: false`, `revoked: false`); key đã revoke luôn verify thất bại. Key official của LumiBase được seed vào bảng này lúc setup.

Implementation: `apps/cms/src/services/extension-verifier.ts`.

## API endpoints

```
GET    /api/v1/marketplace/extensions              List published extensions
GET    /api/v1/marketplace/extensions/:slug        Detail (kèm signature)
GET    /api/v1/marketplace/extensions/:slug/download   Tải package (302 → bundle; ?redirect=0 → JSON)
POST   /api/v1/marketplace/extensions/:slug/install    Install vào site hiện tại
GET    /api/v1/marketplace/updates                 Bản cập nhật cho các extension đã cài trên site hiện tại
POST   /api/v1/marketplace/extensions/:slug/vote       Upvote (cần auth; idempotent)
DELETE /api/v1/marketplace/extensions/:slug/vote       Bỏ upvote (cần auth)
POST   /api/v1/marketplace/publish                 Publish một extension đã upload (đã ký)
POST   /api/v1/marketplace/submit                  Gửi extension từ cộng đồng để duyệt (cần auth)
GET    /api/v1/marketplace/submissions?status=     Danh sách submission để kiểm duyệt (extensions:configure)
POST   /api/v1/marketplace/submissions/:id/review  Duyệt / từ chối một submission (extensions:configure)
```

Implementation: `apps/cms/src/routes/marketplace.ts`.

Catalog projection thêm ba field suy ra bên cạnh các field public ổn định:
`verified` (true khi listing có `verifiedAt` — chỉ được ghi sau khi verify chữ ký
thật lúc publish/install — hoặc `isOfficial`; với các dòng cũ publish trước khi có
bước ghi nhận này thì fallback về việc có đủ signature + publisher key id + hash
integrity — field này điều khiển badge "Verified" và đường install tin cậy),
`voteCount`, và `hasVoted` (cho caller đã xác thực). `totalDownloads` giờ phản ánh
`downloadCount`.

## Download

`GET /extensions/:slug/download` tăng `downloadCount` trên version publish mới nhất
và mặc định trả `302` redirect tới `bundleUrl` đã ký, để bundle lớn không bao giờ đi
qua Worker. Client lập trình truyền `?redirect=0` để nhận metadata của bundle (URL,
hash, signature, key id, số lượt mới) dưới dạng JSON.

## Voting

Mọi user đã xác thực đều có thể upvote một listing. `POST …/vote` insert một dòng với
`ON CONFLICT DO NOTHING` dựa trên unique index `(userId, marketplaceSlug)`, nên vote
lặp lại không có tác dụng; `DELETE …/vote` rút lại vote. Cả hai đều trả về
`{ voteCount, hasVoted }` mới nhất.

## Community submissions

`POST /submit` cho phép mọi user đã xác thực đề xuất một extension cho catalog công
khai. Endpoint validate payload (name, `version` theo SemVer, `type`, slug, bundle
URL, description/publisher/repo/capabilities tùy chọn), từ chối slug đã đang live
trong catalog (`409 SLUG_TAKEN`), và tạo một dòng **global, chưa publish**
(`siteId = null`, `publishedAt = null`) với `submissionStatus = 'pending'` và
`submittedBy = <user>`. Vì chưa publish nên nó không bao giờ xuất hiện trong catalog
công khai cho tới khi moderator duyệt (`/submissions/:id/review`) **và** một bundle
đã ký được publish qua `/publish`. Các endpoint kiểm duyệt yêu cầu permission
`extensions:configure`.

## Verification flow

Khi `POST /install`:

1. Fetch bundle từ `bundleUrl` (R2/S3/external).
2. Recompute SHA-256 → so sánh với `bundleSha256`.
3. Lookup `publisherKeyId` trong `lumibase_publisher_keys`, rồi tới `MARKETPLACE_PUBLIC_KEYS` (xem [Public keys registry](#public-keys-registry)).
4. Verify `signature` qua `crypto.subtle.verify(algorithm, key, signatureBytes, sha256Bytes)`.
5. Nếu thất bại → reject install, không mount.
6. Nếu thành công → ghi extension vào DB cho `siteId` hiện tại với `enabled: false` mặc định, admin enable thủ công.

## Publish flow

`POST /publish` yêu cầu:

- Bundle đã upload (URL trong R2/S3).
- SHA-256 hex chính xác.
- Signature + `publisherKeyId`.
- Slug duy nhất + `publisher` info.

Chỉ moderator có permission `extensions:configure` được phép — cùng guard với `/submissions/:id/review`, vì publish ghi vào catalog global dùng chung cho mọi tenant.

## Roadmap

- [x] Trình duyệt marketplace trong Studio UI (duyệt + cài 1-click).
- [x] Versioning + thông báo auto-update.
- [x] Trang marketplace công khai (apps/marketplace) dùng catalog API thật.
- [x] Chia sẻ doanh thu cho extension thương mại: ra mắt theo hướng **Free-first**; phần checkout/payout được theo dõi trong một backlog thương mại riêng.

## Public marketplace launch

`apps/marketplace` là một Next.js static export deploy lên Cloudflare Pages. Nó đọc dữ liệu catalog từ CMS qua:

```
GET /api/v1/marketplace/extensions?q=&category=&tags=&page=&perPage=&sort=
GET /api/v1/marketplace/extensions/:slug
```

Response của catalog công khai được projection từ `extensions.manifest.marketplace` trước, rồi fallback về dòng `extensions` hiện có. Các field public ổn định gồm `slug`, `name`, `description`, `readme`, `category`, `tags`, `publisherName`, `latestVersion`, `publishedAt`, `updatedAt`, `licenseType`, `repositoryUrl` và `documentationUrl`. Các field cũ (`marketplaceSlug`, `publisher`, `version`, `type`) được giữ lại để tương thích với Studio.

Checklist ra mắt:

- Đặt `NEXT_PUBLIC_USE_REAL_API=true`.
- Đặt `NEXT_PUBLIC_CMS_API_URL` là URL CMS production.
- Build bằng `pnpm marketplace:build`.
- Deploy bằng `pnpm marketplace:deploy` hoặc Cloudflare Pages với `apps/marketplace/out`.
- Smoke test `/`, `/extensions/`, `/categories/seo/` và `/extensions/<slug>/`.
- Seed metadata của listing trong `manifest.marketplace` nếu các dòng production thiếu dữ liệu description/category/tags/license/link.

## Revenue sharing status

Marketplace lúc ra mắt theo hướng free-first. Ở giai đoạn này LumiBase không xử lý checkout cho extension trả phí, license entitlement, payout, hoàn tiền hay thuế.

Backlog cho extension thương mại:

- Các field giá cho listing extension.
- Tài khoản publisher và hồ sơ payout.
- Commission mặc định của nền tảng theo phần trăm.
- License entitlement khi cài extension trả phí.
- Tích hợp nhà cung cấp checkout.
- Revenue ledger, vòng đời payout và vòng đời hoàn tiền.

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
