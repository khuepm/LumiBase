---
version: 8
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
lastUpdated: 2026-11-19T09:24:30.545Z
sourceHash: 03d4a7aca3ee7947
codeVerified: 2026-11-19T09:24:30.545Z
codeVerifiedHash: 03d4a7aca3ee7947
codeVerifiedClaims: 58
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
| `CLAMD_HOST` | host clamd cho adapter native (chỉ Docker) |
| `CLAMD_PORT` | port clamd (mặc định `3310`) |
| `MALWARE_SCAN_URL` | HTTP endpoint nhận upload multipart |
| `MALWARE_SCAN_TOKEN` | bearer token, tuỳ chọn |
| `MALWARE_SCAN_FIELD` | tên field multipart (mặc định `file`) |

Có hai adapter. Khi cả hai được cấu hình, clamd được ưu tiên.

- **clamd (Docker).** Daemon ClamAV native được gọi qua TCP bằng
  `zINSTREAM`. Runtime Docker cung cấp socket client (`runtime.clamd`) khi
  đặt `CLAMD_HOST`, nên business logic không bao giờ import `node:net`.
  `stream: OK` là sạch, `stream: <signature> FOUND` là nhiễm, còn reply
  `ERROR` hoặc daemon không kết nối được thì theo `scan.onError`.
- **HTTP (cả hai runtime).** Bất kỳ scanner REST nào. Adapter đọc được các
  dạng response ClamAV REST phổ biến cũng như dạng chung
  `{ infected, viruses }`. Đây là adapter trên Cloudflare, nơi không có clamd
  TCP: trỏ nó tới bất kỳ dịch vụ quét HTTPS nào.

Docker: `docker compose -f docker/docker-compose.yml --profile malware-scan up -d`
khởi động clamd (`clamav`) và một REST front (`clamav-rest`). Đặt hoặc
`CLAMD_HOST=clamav` (native, khuyến nghị) hoặc
`MALWARE_SCAN_URL=http://clamav-rest:3000/api/v1/scan` cùng
`MALWARE_SCAN_FIELD=FILES`.

**Sweeper quét lại file pending.** Một lần quét không hoàn tất để file ở
`pending`, và file ở trạng thái đó không bao giờ được phục vụ. Điều này xảy ra khi
process chết giữa chừng, hoặc khi lần quét thấy file đã bị thay và bỏ kết
luận cũ. Cứ năm phút, một sweep quét lại các file đã `pending` quá mười phút,
tối đa 50 file mỗi lượt, cũ nhất trước. Nó chạy dưới dạng cron có leader lock
trên Docker và từ Cron Trigger năm phút trên Workers. Mỗi kết luận được ghi
theo version của file, nên các lượt chạy chồng nhau chỉ chốt một file một lần.
Kết luận được audit trên site của file với `sweep: true`. Site đã tắt quét
thì được để nguyên: các file pending của nó vẫn không được phục vụ cho tới khi
admin quét lại hoặc bật lại quét. Phép tra cứu dùng partial index
`files_pending_scan_idx`.

## Upload tiếp tục được (TUS, D04)

File lớn có thể được upload bằng giao thức [TUS 1.0](https://tus.io/protocols/resumable-upload)
(core, `creation`, `termination`, `expiration`) tại `/api/v1/files/tus`.
Mất kết nối hay tải lại trang không còn bắt upload chạy lại từ đầu: client
hỏi server đang giữ bao nhiêu byte (`HEAD`) rồi tiếp tục từ đó. Mọi client
TUS đều dùng được; thư viện media trong Studio tự chuyển sang cách này cho
file từ 32 MiB trở lên (`apps/studio/src/modules/files/tus-client.ts`, chunk
16 MiB, URL upload được giữ trong `localStorage` để tải lại trang vẫn tiếp
tục được).

1. `POST /api/v1/files/tus` với `Upload-Length` và `Upload-Metadata`
   (`filename`, `filetype`, tuỳ chọn `folder`, `alt`). Bộ bảo vệ upload kiểm
   tra phần khai báo giống hệt upload trực tiếp: role public bị từ chối,
   giới hạn dung lượng, danh sách MIME cho phép, vệ sinh tên file và đuôi ↔
   MIME đều áp dụng. `files:create` và rule đặt vào thư mục cũng được kiểm
   tra. Kết quả là `201` kèm `Location` và `Upload-Expires`.
2. `PATCH <Location>` với `Upload-Offset` và body
   `application/offset+octet-stream`. Mỗi chunk được ghi **tất cả hoặc
   không**: nếu storage lỗi thì trả `503` và offset không đổi. Offset sai
   trả `409 OFFSET_MISMATCH` kèm offset đang lưu. Chunk đầu tiên được kiểm
   tra nội dung so với kiểu đã khai báo.
3. Chunk chạm tới `Upload-Length` hoàn tất upload. Quyền và vị trí thư mục
   được **kiểm tra lại** (upload của người đã bị thu hồi quyền bị huỷ), file
   đã ghép được quét polyglot, dòng file được tạo, metadata được trích xuất
   và lượt quét mã độc được lên lịch y như upload trực tiếp. Response mang
   `X-Lumi-File-Id`.
4. `DELETE <Location>` huỷ upload và xoá các phần đã lưu.

**Chạy trên cả hai runtime như thế nào.** Byte đi thẳng vào một multipart
upload trên R2 (Workers) hoặc S3/MinIO (Docker) qua port `MultipartStorage`
của runtime (`packages/runtime/src/interfaces/storage.ts`), nên không runtime
nào giữ cả file trong bộ nhớ. Các phần multipart phải cùng kích thước, nên
server cắt luồng thành phần 8 MiB và giữ phần dư trong một object đuôi nhỏ
cho tới khi chunk tiếp theo tới. Tiến độ nằm trong bảng
`lumibase_upload_sessions`. Mỗi `PATCH` giữ một lease ngắn bằng update có
điều kiện, nên hai writer đồng thời không thể cùng nối; lease bị bỏ lại bởi
một request sập sẽ hết hạn sau năm phút.

**Quyền sở hữu và hết hạn.** Chỉ người tạo (hoặc site admin) xem hoặc ghi
được một upload; người khác nhận `404`. Upload hết hạn 24 giờ sau chunk cuối
cùng được ghi (sau đó trả `410`). Một lượt quét mỗi giờ, `upload-expiry`,
abort các multipart upload đã hết hạn và xoá object đuôi của chúng (cron
Docker có leader lock và cron giờ của Workers).
## Pipeline video (#871)

Video không transcode được trong Worker, nên CMS giao chúng cho một **video
provider** bên ngoài qua một port (`apps/cms/src/modules/video/provider.ts`).
Có sẵn hai adapter: **Cloudflare Stream** và **Mux**. Cả hai chỉ dùng HTTP,
nên pipeline chạy như nhau trên Workers và Docker. Business logic không bao
giờ gọi tên provider.

Tắt theo mặc định. Khi một site bật `video.enabled` và deployment có
provider, mọi file `video/*` mới hoặc được thay có một dòng trong
`lumibase_video_assets` và đi qua các trạng thái sau:

| Trạng thái | Ý nghĩa |
|---|---|
| `uploaded` | đang xếp hàng; chờ quét mã độc (#707) đánh dấu file phân phối được |
| `processing` | đã gửi; provider đang dựng renditions, manifest HLS và poster |
| `ready` | phát được; thời lượng và kích thước được chép sang file (`duration` tính bằng giây, `width`, `height`) |
| `failed` | provider từ chối, năm lần gửi thất bại, hoặc xử lý quá 24 giờ |

1. **Gửi.** Sau response upload (`waitUntil` trên Workers, một tác vụ tách
   rời trên Node), CMS gửi cho provider một URL có chữ ký, sống ngắn,
   `GET /api/v1/video/source/<token>`. Token ghi site, file và version, hết
   hạn sau sáu giờ, và khoá của nó được dẫn xuất từ `JWT_SECRET`. Provider
   kéo bản gốc từ URL đó. File còn đang được quét sẽ được gửi khi kết quả
   quét là sạch.
2. **Webhook.** Provider gọi `POST /api/v1/video/webhook/<provider>`. Chữ ký
   được kiểm theo webhook secret của deployment, với cửa sổ chống replay năm
   phút. Site, file và version lấy từ passthrough CMS gắn lúc gửi. Sự kiện
   cho version cũ hơn hoặc asset khác bị bỏ qua.
3. **Quét định kỳ.** Mỗi năm phút (cron Docker có leader lock, trigger năm
   phút của Workers), `video-sweep`:
   - gửi các dòng đang xếp hàng, kể cả lỗi thử lại được (tối đa năm lần);
   - hỏi trạng thái các dòng đang xử lý mà webhook không tới;
   - xếp hàng lại một lần gửi bị ngắt giữa chừng;
   - đánh dấu thất bại mọi thứ xử lý quá 24 giờ.

Thay file sẽ xếp hàng lại và xoá asset provider của version trước. Xoá file
cũng xoá asset provider của nó.

**Endpoint.**

- `GET /api/v1/files/:id/video` trả trạng thái (`meta.enabled`,
  `meta.providerConfigured`).
- `POST /api/v1/files/:id/video/retry` (files `update`) gửi lại một video
  thất bại hoặc đang xếp hàng.
- `GET /api/v1/files/:id/video/playback` trả `{ hls, poster, expiresAt }` cho
  video đã sẵn sàng. Với `video.signedPlayback` (mặc định) cả hai URL được
  provider ký và hết hạn sau `video.playbackTtlSeconds`: cùng mô hình URL
  sống ngắn như signed transforms. Response là
  `Cache-Control: private, no-store`. Endpoint trả `409 VIDEO_NOT_READY` cho
  tới khi version hiện tại sẵn sàng.

Provider là thiết lập **cấp deployment**:

| Biến | Ý nghĩa |
|---|---|
| `VIDEO_PROVIDER` | `cloudflare-stream` hoặc `mux`; không đặt = không transcode |
| `LUMIBASE_PUBLIC_URL` | origin công khai mà provider kéo nguồn về; thiếu nó thì lượt quét định kỳ không gửi được |
| `CF_STREAM_ACCOUNT_ID`, `CF_STREAM_API_TOKEN` | quyền gọi Stream API |
| `CF_STREAM_WEBHOOK_SECRET` | secret trả về khi đăng ký webhook của account |
| `CF_STREAM_CUSTOMER_DOMAIN` | host phát, ví dụ `customer-<code>.cloudflarestream.com` |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | access token của Mux API |
| `MUX_WEBHOOK_SECRET` | secret ký webhook của Mux |
| `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_KEY_PRIVATE` | khoá ký cho phát có chữ ký (khoá base64 Mux cấp, hoặc PEM) |

Trỏ webhook của provider tới
`<LUMIBASE_PUBLIC_URL>/api/v1/video/webhook/cloudflare-stream` hoặc
`…/webhook/mux`.

**Trong Studio.** Ngăn chi tiết asset của một file video hiển thị:

- trạng thái xử lý, được hỏi lại định kỳ trong lúc provider làm việc;
- lỗi và nút **Retry processing** khi xử lý thất bại;
- trình phát xem trước khi video đã sẵn sàng.

Trình phát chạy HLS qua hls.js, được tải lười. CSP của Studio chỉ cho phép
`'self'` và `blob:` cho media và ảnh, nên poster và các track WebVTT được tải
về trước rồi phát từ URL `blob:`. Track đi qua SDK, vốn mang theo phiên đăng
nhập. Khi thiếu Media Source (webview iOS cũ trong shell desktop/mobile),
trình phát quay về HLS gốc.

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

Trong Studio, mục **Captions & subtitles** ở ngăn chi tiết của video liệt kê
các track, bật/tắt track mặc định, gỡ track, và thêm track từ một file WebVTT
chọn trong thư viện media, kèm ngôn ngữ (các locale của site), kind và nhãn
tuỳ chọn.

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
| `video.enabled` | `false` | pipeline video |
| `video.signedPlayback` | `true` | URL phát do provider ký, có hạn |
| `video.playbackTtlSeconds` | `3600` | thời gian sống của URL phát (60–86400) |

## Multi-tenancy

- **Cô lập theo site:** `lumibase_files`, `lumibase_folders`,
  `lumibase_file_versions`, `lumibase_upload_sessions`,
  `lumibase_file_captions` và `lumibase_video_assets` đều mang `site_id` và
  nằm trong danh sách RLS
  `site_isolation`. Mọi query của repository được lọc theo `site_id`
  (`DrizzleFileRepository`). Binary lưu trữ nằm dưới `sites/<site>/…`. Cache
  tag (`file:<site>:<id>`) và thiết lập `files.dam` là theo site. Tra cứu
  trùng lặp và "dùng ở đâu" chỉ tìm trong site của caller.
- **Dùng chung toàn deployment:** endpoint scanner (`MALWARE_SCAN_*`) và
  tài khoản video provider (`VIDEO_PROVIDER`, `CF_STREAM_*`, `MUX_*`). Đây là
  định danh dịch vụ do operator kiểm soát, không phải dữ liệu tenant, và một
  tenant chỉ có thể bật quét hoặc video cho chính site của mình. Webhook của
  provider mang site trong một passthrough có chữ ký; route webhook và route
  nguồn chỉ truy vấn dòng của site đó.
- **Cách kiểm chứng:** `apps/cms/src/routes/__tests__/files-dam.test.ts` chạy
  hai site song song. Site A không đọc, thay hay xoá được file của site B
  (404, không ghi gì), và tra cứu trùng lặp không bao giờ trả về file cùng
  hash của site kia.

## Chưa làm

- `Upload-Defer-Length` của TUS (chưa biết dung lượng lúc tạo) trả `501`, và
  extension `concatenation` không được cung cấp.
- Rich text chưa nhúng ảnh qua picker (R03). API picker ở trên là điểm tích
  hợp.
