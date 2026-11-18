---
version: 3
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
lastUpdated: 2026-11-18T05:33:16.586Z
sourceHash: 7408737bb33e1a8c
codeVerified: 2026-11-18T05:33:16.586Z
codeVerifiedHash: 7408737bb33e1a8c
codeVerifiedClaims: 36
---

# Quản lý tài sản số (Digital Asset Management)

Module files (`/api/v1/files`, **Studio → Files & Media**) là một thư viện tài
sản số: thư mục có thể sắp xếp lại, upload hàng loạt, thay file tại chỗ kèm
hoàn tác, phát hiện trùng lặp, "dùng ở đâu" kèm xoá an toàn, metadata nhúng
(EXIF / IPTC / XMP) tìm kiếm được, tuỳ chọn gỡ GPS, tuỳ chọn quét mã độc, và
một media picker dùng chung cho field lẫn extension.

Theo dõi: epic #670 (D01–D08). Code: `apps/cms/src/routes/files.ts`,
`apps/cms/src/services/files/`, `apps/cms/src/modules/malware-scan/`,
`apps/studio/src/modules/files/`.

## Thư mục và phân quyền theo thư mục (D01)

- `GET /api/v1/files/folders/tree` trả về cây lồng nhau. Mỗi node có `path`
  theo id (`/root/child/`), `namePath` (`Marketing/2026`) và `depth`.
- `PATCH /api/v1/files/folders/:id` đổi tên (`name`) và/hoặc di chuyển
  (`parent`) một thư mục. Di chuyển vào chính nó hoặc một thư mục con của nó
  bị từ chối với `409 FOLDER_CYCLE`.
- `DELETE /api/v1/files/folders/:id` chỉ xoá thư mục **rỗng**. Nếu không,
  trả về `409 FOLDER_NOT_EMPTY` kèm số lượng.
- Di chuyển hay đổi tên một file (`PATCH /api/v1/files/:id` với `folder` hoặc
  `filenameDownload`) không bao giờ đổi id hay storage key của nó. URL và các
  tham chiếu vẫn hoạt động, nên không cần redirect map.
- Trong Studio, kéo file (hoặc một nhóm đã chọn) thả lên một thư mục ở thanh
  bên để di chuyển, và kéo một thư mục thả lên thư mục khác để đổi thư mục cha.

**Phân quyền theo thư mục.** Site admin có toàn quyền. Thành viên khác cần một
policy permission trên collection `files` (`read`, `create`, `update`,
`delete`). Rule của permission được đánh giá trên từng file, với các field sau:

| Field | Giá trị |
|---|---|
| `folder` | id thư mục, hoặc `null` ở gốc |
| `folder_path` | `/a/b/c/` (chuỗi id của thư mục), hoặc `/` ở gốc |
| `uploaded_by` | id user đã upload |
| `mime` | kiểu MIME |
| `id` | id file |

```json
{ "folder_path": { "_starts_with": "/<folderId>/" } }
```

Rule đó cấp quyền cho cả một cây con. Dấu gạch chéo ở cuối khiến `/ab/` không bao
giờ khớp với `/a/`. File nằm ngoài rule trả về `404` (không phải `403`), và
việc di chuyển file ra khỏi cây con được cấp bị từ chối. Quản lý thư mục và
DAM settings vẫn chỉ dành cho site admin. Principal không có grant `files`
nào bị từ chối y như trước.

## Upload hàng loạt (D02)

Thả nhiều file (hoặc chọn chúng) ở bất kỳ đâu trên trang thư viện. Hàng đợi
upload **ba file một lúc** và hiển thị tiến độ từng file. Lỗi mạng và lỗi
server được thử lại hai lần có backoff. File bị upload guard từ chối (4xx)
thất bại ngay và được báo trên dòng riêng của nó kèm lý do. Cả lô vào đúng
thư mục đang mở lúc bạn thả. Panel có **Retry failed** và **Clear finished**.
Cập nhật tiến độ được gộp lại, nên 100 file không làm treo UI.

Sau khi upload, chọn các file và dùng **Edit metadata** để đặt alt text,
caption, credit và tags một lần. Lời gọi API là
`POST /api/v1/files/bulk { ids, folder?, metadata? }`. File mà caller không
được đụng tới được liệt kê trong `meta.skipped`, phần còn lại được áp dụng.

## Thay file tại chỗ (D03)

```
PUT /api/v1/files/:id/content?filename=new-name.jpg
Content-Type: image/jpeg
If-Match: "v3"            # optional — 409 VERSION_CONFLICT when stale
<raw bytes>
```

- Id, **storage key**, thư mục và mọi tham chiếu giữ nguyên, còn `version`
  tăng thêm một. Field `file` của Studio lưu storage key, nên key được cố ý
  giữ lại.
- Byte cũ được sao chép sang `sites/<site>/file-versions/<id>/v<n>` và ghi
  vào `lumibase_file_versions` trong `versionRetentionDays` ngày (mặc định
  30). `GET /api/v1/files/:id/versions` liệt kê chúng, và
  `POST /api/v1/files/:id/versions/:versionId/restore` khôi phục một bản.
  Khôi phục cũng chính là một lần thay, nên lịch sử không bao giờ bị viết
  lại. Bản hết hạn được dọn cùng object của nó.
- Sau khi thay, các bản sao ở edge của file bị purge (cache tag
  `file:<site>:<id>`). Mọi collection có item tham chiếu file bị invalidate
  cache tag và các ISR revalidation target của nó được báo. Page nhúng file
  invalidate deliver tag. Transform ảnh được tính theo request từ byte hiện
  tại và khoá theo version của nó, nên được tạo lại lười.
- Body của lần thay đi qua đúng upload guard như mọi upload surface khác
  (kích thước, MIME allowlist, magic bytes, quét polyglot). Xem
  [bảo mật upload](../security/upload-security.md).

**Phân phối theo id.** `GET /api/v1/files/:id/content` trả byte hiện tại, dùng
cùng quyền `files:read`. Response mặc định là revalidate
(`max-age=300, must-revalidate`). URL ghim bằng `?v=<version>` là `immutable`
trong một năm: thay file làm tăng version, nên URL đã ghim không bao giờ trả
byte cũ. Response mang `ETag`, `Cache-Tag` và `X-Lumi-File-Version`.

## Trùng lặp, dùng ở đâu, và xoá an toàn (D06)

- Khi đăng ký (`POST /api/v1/files`) CMS đọc lại object đã lưu (object tới
  64 MiB), ghi SHA-256 vào `content_hash`, và trả các file cùng nội dung trong
  `meta.duplicates`. Studio hash từng file trong trình duyệt **trước** khi
  upload (`GET /api/v1/files/duplicates?hash=`). Khi trùng, hàng đợi tạm dừng
  file đó và hỏi: **Skip** hay **Upload anyway**.
- `GET /api/v1/files/:id/usage` liệt kê các item (collection, id, status và
  các field cấp cao nhất) và page chứa id hoặc storage key của file.
- `DELETE /api/v1/files/:id` trên một file đang được tham chiếu trả về
  `409 FILE_IN_USE`, với danh sách tham chiếu trong
  `errors[0].details.usage`. `deletePolicy` của site quyết định bước tiếp.
  `confirm` (mặc định) xoá khi request được gửi lại với `?confirm=true`.
  `block` không bao giờ xoá file đang được tham chiếu. Một lần xoá gỡ row,
  object đã lưu và mọi phiên bản đã lưu trữ.

Tham chiếu được tìm bằng phép khớp chuỗi con nguyên văn trên JSON. Cách này
có thể báo thừa (một field văn bản chỉ nhắc tới key) nhưng không bao giờ bỏ
sót một tham chiếu nguyên văn, đúng hướng an toàn cho một thao tác xoá.

## Metadata nhúng (D05)

EXIF (máy ảnh, ống kính, phơi sáng, hướng ảnh, artist, copyright), GPS,
IPTC-IIM (headline, caption, keywords, by-line, credit, source, copyright,
city, country) và XMP (`dc:title`, `dc:description`, `dc:creator`,
`dc:subject`, `dc:rights`, `photoshop:Credit`) được trích từ JPEG, PNG, WebP
và TIFF khi đăng ký và mỗi lần thay. Kết quả vào
`files.metadata.embedded`. Một `summary` đã gộp (IPTC thắng XMP, XMP thắng
EXIF) và một `searchText` chữ thường cấp cho tìm kiếm thư viện:
`GET /api/v1/files?search=sunrise` khớp IPTC keywords, credit và copyright.
Các key biên tập do bạn tự đặt (`alt`, `caption`, `tags`, …) không bao giờ bị
ghi đè. Parser là TypeScript thuần với các lần đọc có giới hạn, nên chạy trên
cả hai runtime.

**Gỡ GPS khi phân phối công khai.** Với `stripGpsOnPublic: true`, byte do
`GET /api/v1/files/:id/content` trả về được gỡ GPS. GPS IFD được làm rỗng và
các thuộc tính XMP `exif:GPS*` bị xoá trắng. File giữ nguyên độ dài và cấu
trúc, hướng ảnh và copyright vẫn còn. Bản gốc đã lưu không bị đụng tới, nên
biên tập viên vẫn thấy vị trí trong panel chi tiết. Transform ảnh vốn đã bỏ
GPS: Sharp mặc định gỡ metadata, và Cloudflare Image Resizing mặc định chỉ
giữ copyright.

## Media picker (D08)

Một picker phục vụ thư viện media, các field `file` / `files` có sẵn
("Choose from library") và UI extension:

```ts
import { getStudioHost } from '@lumibase/extension-sdk';

const assets = await getStudioHost()?.openMediaPicker({
  multiple: true,
  max: 5,
  initiallySelected: ['<fileId or storage key>'],
  allowedMimeTypes: ['image/*'],
  folder: '<folderId>',        // scope; includeSubfolders defaults to true
});
// → PickedAsset[] | null (cancelled)
```

Lọc diễn ra ở server. `GET /api/v1/files` nhận `folder` (`root` cho file nằm
ngoài mọi thư mục), `subfolders=true`, `search`, `mime` (phân tách bằng dấu
phẩy, chính xác hoặc `type/*`), `ids`, `limit` (≤ 1000) và `offset`. Nó trả
về `meta.total`. Trong code Studio, dùng hook `useMediaPicker()`.

## Quét mã độc (D07)

Mặc định tắt. Khi một site bật `scan.enabled`, mọi binary mới hoặc vừa thay
bắt đầu ở `scanStatus: pending`. Một lần quét nền (`waitUntil` trên Workers,
một tác vụ tách rời trên Node) gửi byte tới scanner của deployment và ghi
`clean`, `infected` hoặc `error`. `GET /api/v1/files/:id/content` chỉ phục vụ
file `skipped` và `clean`. Mọi trạng thái khác trả về
`423 FILE_SCAN_PENDING` / `423 FILE_QUARANTINED`. Kết luận được ghi vào audit
log (`file_quarantined`, `file_scan_clean`, `file_scan_error`).
`scan.onError` quyết định kết quả khi scanner không hoạt động. Mặc định,
`quarantine`, là fail closed; `allow` đánh dấu file là clean. Site admin có
thể chạy lại quét bằng `POST /api/v1/files/:id/scan`.

Scanner là thiết lập của **deployment**, không bao giờ là của tenant:

| Biến | Ý nghĩa |
|---|---|
| `MALWARE_SCAN_URL` | HTTP endpoint nhận upload multipart |
| `MALWARE_SCAN_TOKEN` | bearer token, tuỳ chọn |
| `MALWARE_SCAN_FIELD` | tên field multipart (mặc định `file`) |

Docker: `docker compose -f docker/docker-compose.yml --profile malware-scan up -d`
khởi động một sidecar ClamAV REST. Đặt `MALWARE_SCAN_URL=http://clamav-rest:3000/api/v1/scan`
và `MALWARE_SCAN_FIELD=FILES`. Trên Cloudflare, trỏ nó tới bất kỳ dịch vụ
quét HTTPS nào. Adapter đọc được các dạng response ClamAV REST phổ biến cũng
như dạng chung `{ infected, viruses }`.

## Phụ đề và caption (#871)

Một track phụ đề hoặc caption là một file WebVTT trong thư viện, được gắn với
một video cho một locale. Track vẫn là một asset bình thường: quyền thư mục,
phiên bản và thay tại chỗ của riêng nó, nên sửa lỗi chính tả trong phụ đề vẫn
giữ mọi liên kết. Upload nó như mọi file. `text/vtt` (`.vtt`) có trong
catalogue upload nhưng tắt mặc định, nên hãy bật nó trong
**Settings → Uploads**. Bộ bảo vệ upload yêu cầu chữ ký `WEBVTT`, nên một tài
liệu HTML hay SVG không thể giả làm phụ đề.

- `GET /api/v1/files/:id/captions` liệt kê các track của một video (files
  `read`). Mỗi track mang những gì phần tử HTML `<track>` cần: `kind`,
  `locale` (`srclang`), `label`, `isDefault` và `src`, một URL bất biến ghim
  theo version `GET /api/v1/files/<caption>/content?v=<n>`. Track mà caller
  không thấy được file phụ đề sẽ được liệt kê với `src: null`.
- `POST /api/v1/files/:id/captions` gắn một track (files `update` trên
  video), với body `{ captionFileId, locale, kind?, label?, isDefault? }`:
  - `kind` là `subtitles` (mặc định), `captions`, `descriptions` hoặc
    `chapters`;
  - video phải là `video/*` (`422 NOT_A_VIDEO`);
  - track phải là file `text/vtt` mà caller thấy được
    (`415 CAPTION_NOT_VTT`, `404 CAPTION_FILE_NOT_FOUND`);
  - locale phải là một locale của site (`422 LOCALE_NOT_ENABLED`);
  - mỗi video, locale và kind chỉ có một track (`409 CAPTION_EXISTS`).
- `PATCH /api/v1/files/:id/captions/:captionId` đổi `captionFileId`,
  `locale`, `kind`, `label` hoặc `isDefault`. Mỗi video và kind có tối đa một
  track mặc định, nên đặt một track làm mặc định sẽ bỏ cờ của các track khác.
- `DELETE /api/v1/files/:id/captions/:captionId` gỡ track. File WebVTT vẫn ở
  trong thư viện. Xoá một trong hai file sẽ gỡ liên kết.

## Thiết lập

`GET /api/v1/files/settings` trả về thiết lập, và
`PUT /api/v1/files/settings` cập nhật chúng (site admin, cập nhật một phần).
Chúng được lưu trong `settings` dưới key `files.dam`:

| Key | Mặc định | |
|---|---|---|
| `deletePolicy` | `confirm` | `confirm` hoặc `block` cho file đang được tham chiếu |
| `versionRetentionDays` | `30` | `0` không giữ lịch sử |
| `stripGpsOnPublic` | `false` | gỡ GPS khỏi byte được phân phối |
| `extractMetadata` | `true` | trích EXIF/IPTC/XMP |
| `scan.enabled` | `false` | quét mã độc |
| `scan.onError` | `quarantine` | `quarantine` hoặc `allow` |

## Multi-tenancy

- **Cô lập theo site:** `lumibase_files`, `lumibase_folders`,
  `lumibase_file_versions` và `lumibase_file_captions` đều mang `site_id` và nằm trong danh sách RLS
  `site_isolation`. Mọi query của repository được lọc theo `site_id`
  (`DrizzleFileRepository`). Binary lưu trữ nằm dưới `sites/<site>/…`. Cache
  tag (`file:<site>:<id>`) và thiết lập `files.dam` là theo site. Tra cứu
  trùng lặp và "dùng ở đâu" chỉ tìm trong site của caller.
- **Dùng chung toàn deployment:** endpoint scanner (`MALWARE_SCAN_*`). Đây là
  định danh dịch vụ do operator kiểm soát, không phải dữ liệu tenant, và một
  tenant chỉ có thể bật quét cho chính site của mình.
- **Cách kiểm chứng:** `apps/cms/src/routes/__tests__/files-dam.test.ts` chạy
  hai site song song. Site A không đọc, thay hay xoá được file của site B
  (404, không ghi gì), và tra cứu trùng lặp không bao giờ trả về file cùng
  hash của site kia.

## Chưa làm

- Upload resumable (TUS, D04 #704) chưa được hiện thực. File lớn vẫn dùng
  một lần `PUT` có chữ ký.
- Rich text chưa nhúng ảnh qua picker (R03). API picker ở trên là điểm tích
  hợp.
- Transcode video (#871 phần 1, PR #937) cùng trình sửa phụ đề và trình phát
  trong Studio là các phần riêng của #871.
