---
version: 4
lastUpdated: 2026-11-19T04:31:58.266Z
sourceLang: en
translatedFrom: en
sourceHash: 2c357c3aff9d32ed
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T04:32:04.952Z
codeVerifiedHash: 2c357c3aff9d32ed
codeVerifiedClaims: 28
---

# Release Flags

Release flag cho phép merge một tính năng vào `main` và triển khai nó ở trạng
thái **dark**: code được phát hành, nhưng không chạy cho tới khi LumiBase phát
hành nó bằng một manifest có chữ ký, hoặc operator ép bật. Sau khi được phát
hành, admin của site chọn có dùng nó cho site của mình hay không.

Đây là phần đầu của [#869](https://github.com/khuepm/LumiBase/issues/869). Nút
**Upgrade** trong ứng dụng mô tả ở issue đó chưa được làm.

## Cách quyết định một flag

Mỗi flag được khai báo một lần, trong `apps/cms/src/modules/release-flags/registry.ts`,
kèm stage, issue sở hữu và ngày phải gỡ. Trạng thái của nó được tính qua hai
lớp.

**1. Cổng phát hành (toàn deployment).** Nguồn đầu tiên có giá trị sẽ thắng:

| Thứ tự | Nguồn | Ai đặt |
|---|---|---|
| 1 | `LUMIBASE_RELEASE_FLAGS` | Operator (env). Đây là công tắc tắt khẩn cấp. |
| 2 | Manifest có chữ ký đã được chấp nhận | LumiBase |
| 3 | Stage của flag | Code: `ga` là đã phát hành, `dark` và `beta` thì chưa |

**2. Lựa chọn của site.** Chỉ áp cho flag đã phát hành và khai báo `siteToggle`:
giá trị admin của site đã chọn, nếu chưa chọn thì dùng `siteDefault` của flag.

Một site không bao giờ bật được tính năng mà cổng phát hành đang giữ tắt. Bộ
giải quyết nằm ở `apps/cms/src/modules/release-flags/resolver.ts`.

## Phát hành một tính năng (phía LumiBase)

Manifest liệt kê các flag cần phát hành và được ký bằng Ed25519. Dùng
`scripts/release-flags/manifest.mjs`:

```bash
# once: create the key pair; keep the private key out of the repository
node scripts/release-flags/manifest.mjs keygen --out ./keys --key-id lumibase-release-v1

# each release: sign the full set of flags you want released
node scripts/release-flags/manifest.mjs sign \
  --key ./keys/lumibase-release-v1.private.pem --key-id lumibase-release-v1 \
  --flags content-environments=on --out manifest.json
```

Manifest mới thay thế toàn bộ manifest trước. Hãy liệt kê mọi flag muốn phát
hành, không chỉ flag vừa đổi. `sign` từ chối manifest không có flag nào, vì nó
sẽ rút lại mọi tính năng đã phát hành; thêm `--allow-empty` nếu đó đúng là ý
bạn.

Một instance chỉ chấp nhận manifest khi đủ tất cả các điều kiện sau:

- key id có trong `LUMIBASE_RELEASE_PUBLIC_KEYS` và chữ ký hợp lệ;
- `issuedAt` không vượt quá thời điểm hiện tại hơn 5 phút;
- `notAfter`, nếu có, chưa qua;
- `audience` là `"*"` hoặc có chứa `LUMIBASE_INSTANCE_ID`;
- `issuedAt` muộn hơn manifest đã chấp nhận. Gửi lại đúng manifest đó thì không
  có tác dụng gì.

Điều kiện cuối ngăn việc phát lại một manifest cũ để quay flag về trạng thái
trước. Muốn tắt một tính năng, hãy ký một manifest mới hơn với flag đặt `off`.

## Đưa manifest tới instance

Có hai kênh. Cả hai đi qua cùng một bước xác minh.

- **Push.** Bootstrap admin gửi envelope tới
  `PUT /api/v1/release-flags/manifest`. Cách này chạy được khi không có kết nối
  mạng ra ngoài.
- **Pull (phải bật).** Đặt `LUMIBASE_RELEASE_MANIFEST_URL` là một URL
  `https://` trả về envelope. Instance tải nó ở nền, tối đa mỗi
  `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` giây một lần (mặc định 300, tối thiểu
  60). Bootstrap admin có thể yêu cầu tải ngay bằng
  `POST /api/v1/release-flags/manifest/pull`.

Nếu tải lỗi hoặc manifest bị từ chối, instance giữ manifest đã chấp nhận trước
đó. Mất kết nối tới LumiBase không bao giờ làm tắt một tính năng đã phát hành.
Kênh pull không đi theo redirect.

Mọi manifest được chấp nhận hay bị từ chối, từ kênh nào cũng vậy, đều được ghi
vào audit log ở cấp instance (không gắn site), với sự kiện
`release_flags.manifest_accepted` hoặc `release_flags.manifest_rejected`.

**Thu hồi khoá.** Manifest đã lưu chỉ có hiệu lực khi khoá đã ký nó vẫn nằm
trong `LUMIBASE_RELEASE_PUBLIC_KEYS` với cùng PEM. Gỡ một khoá, ví dụ sau khi
khoá bị lộ, sẽ rút lại mọi manifest khoá đó đã ký: các flag quay về mặc định
theo stage cho tới khi có manifest ký bằng khoá còn được tin cậy.

## Cấu hình

| Biến | Mục đích |
|---|---|
| `LUMIBASE_RELEASE_PUBLIC_KEYS` | JSON `{ "keyId": "<PEM>" }` gồm các khoá ký được tin cậy. Nhiều khoá cho phép xoay khoá. Thiếu biến này thì mọi manifest đều bị từ chối. |
| `LUMIBASE_RELEASE_FLAGS` | Ghi đè của operator, ví dụ `content-environments=on,other=off`. Key không khai báo sẽ bị bỏ qua và ghi log. |
| `LUMIBASE_RELEASE_MANIFEST_URL` | URL cho kênh pull (phải bật). `http` thường chỉ được phép với loopback. |
| `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` | Chu kỳ pull, tính bằng giây. |
| `LUMIBASE_INSTANCE_ID` | Định danh của deployment này, dùng để so với `audience` của manifest. |

## API

| Phương thức và đường dẫn | Ai | Mục đích |
|---|---|---|
| `GET /api/v1/release-flags` | Mọi thành viên | Thành viên chỉ nhận `{ key, enabled }` của các flag đã phát hành, nên key chưa phát hành vẫn bị ẩn; admin của site nhận mọi flag kèm stage, nguồn quyết định, owner và ngày gỡ. |
| `PUT /api/v1/release-flags/site` | Admin của site | `{ "flags": { "<key>": true \| false \| null } }`. `null` xoá lựa chọn. |
| `GET /api/v1/release-flags/manifest` | Bootstrap admin | Manifest đã chấp nhận (kèm `trusted`: khoá ký còn được tin cậy hay không), các key id được tin cậy, kết quả lần pull gần nhất. |
| `PUT /api/v1/release-flags/manifest` | Bootstrap admin | Gửi một envelope có chữ ký. |
| `POST /api/v1/release-flags/manifest/pull` | Bootstrap admin | Tải ngay từ URL đã cấu hình. |

Các endpoint manifest từ chối API key. Manifest bị từ chối trả về
`MANIFEST_REJECTED` kèm `reason`: `422` khi chữ ký sai, key lạ, hết hạn, chưa
tới hiệu lực, sai audience hoặc payload sai dạng; `409` khi `STALE` (cũ hơn bản
đã chấp nhận) hoặc khi chưa cấu hình khoá tin cậy nào.

## Studio

**Settings → System → Release flags** liệt kê các flag của site đang chọn.

- Admin của site thấy mọi flag đã khai báo: mô tả, giai đoạn, deployment này
  đã phát hành flag hay chưa và vì sao (do operator, theo manifest của LumiBase
  hoặc theo mặc định của giai đoạn), flag có đang bật cho site này không và vì
  sao (theo trạng thái phát hành, đã chọn cho site, hoặc mặc định của site),
  người phụ trách và ngày gỡ.
- Flag đã phát hành và khai báo `siteToggle` có công tắc cho site, và nút
  **Dùng mặc định** xoá lựa chọn của site (`null`). Công tắc bị khoá kèm lời giải
  thích khi deployment chưa phát hành flag.
- Thành viên chỉ thấy các flag đã phát hành và trạng thái bật/tắt, chỉ đọc.
- Quản lý manifest có chữ ký vẫn là API dành cho bootstrap admin; Studio không
  có trang cho việc này.

Các màn hình khác của Studio ẩn giao diện của tính năng có flag đang tắt bằng
`useReleaseFlag(key)` hoặc `<ReleaseFlagGate flag="…">` trong
`apps/studio/src/lib/release-flags.tsx`. Danh sách được đọc một lần mỗi phiên
và mỗi site; nếu đọc lỗi thì tính năng vẫn bị ẩn. Việc ẩn chỉ để tiện — server
vẫn trả `404` cho route có gắn cờ.

## Gắn cờ vào code (cho developer)

```ts
import { requireReleaseFlag, isReleaseFlagEnabled } from '../modules/release-flags';

// A whole route: answers 404 NOT_FOUND, like an unknown route, while off.
router.post('/environments', requireReleaseFlag('content-environments'), handler);

// A branch inside a handler.
if (await isReleaseFlagEnabled(c, 'content-environments')) { /* ... */ }
```

Key có kiểu: một key không khai báo trong registry sẽ không biên dịch được.
Trạng thái được tính một lần mỗi request và giữ trên context của request.

Quy tắc cho một flag mới:

1. Khai báo trong `registry.ts` với `stage: 'dark'`, một issue `owner` và ngày
   `removeBy`. Một test sẽ fail khi đã qua ngày `removeBy`.
2. **Flag chặn code, không chặn schema.** Migration chạy dù flag bật hay tắt,
   nên mọi migration nằm sau một flag phải là thay đổi cộng thêm và an toàn khi
   tính năng đang tắt.
3. Khi tính năng đã phổ biến, xoá flag và các chỗ kiểm tra nó.

## Giới hạn

- **Không phải rào chắn bảo mật hay bản quyền trên instance tự host.** Code và
  repository là mở, và operator đặt được `LUMIBASE_RELEASE_FLAGS`. Dùng flag để
  phát hành theo giai đoạn, không dùng để giới hạn tính năng trả phí.
- **Kênh pull liên lạc với một máy chủ của LumiBase.** Nó tắt trừ khi
  `LUMIBASE_RELEASE_MANIFEST_URL` được đặt.
- **Thay đổi không lan ngay lập tức giữa các replica.** Replica chấp nhận
  manifest dùng nó ngay; các replica khác đọc được trong vòng 30 giây. Lựa chọn
  của site đặt qua API có hiệu lực ở request tiếp theo; nếu ghi qua endpoint
  settings chung thì có thể mất tới 60 giây.

## Đa tenant

| Tài nguyên | Phạm vi | Lý do |
|---|---|---|
| Manifest đã chấp nhận (`lumibase_release_manifests`, một dòng) | Toàn deployment | Ghi nhận những gì deployment đã phát hành. Không chứa dữ liệu tenant. |
| `LUMIBASE_RELEASE_FLAGS`, khoá tin cậy, URL pull | Toàn deployment | Cấu hình của operator. |
| Lựa chọn của site (`lumibase_settings`, key `release.flags`) | Theo site | Nằm dưới policy RLS `site_isolation` sẵn có. |
| Cache `release-flags:site:{siteId}` | Theo site | Key chứa site id. |

Kiểm chứng bằng `apps/cms/src/modules/release-flags/__tests__/release-flags.db.integration.test.ts`
và `routes.db.integration.test.ts` trong cùng thư mục: lựa chọn ở một site không
làm đổi site khác, và một route có gắn cờ chỉ mở trên site đã chọn bật.
