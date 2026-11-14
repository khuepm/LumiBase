---
version: 2
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
lastUpdated: 2026-11-14T02:15:35.179Z
sourceHash: 762fa056a7df59c7
codeVerified: 2026-11-14T02:15:35.179Z
codeVerifiedHash: 762fa056a7df59c7
codeVerifiedClaims: 14
---

# Bảo mật upload: dò MIME, làm sạch SVG và polyglot

> **Đối tượng:** operator và integrator cho phép đưa file vào LumiBase, và
> reviewer kiểm toán đường upload.
>
> **TL;DR:** LumiBase không bao giờ tin `Content-Type` khai báo hay tên file.
> Mỗi lần upload bytes thô đều được phân loại theo magic bytes, so với loại
> client khai báo, quét tìm định dạng thứ hai ẩn bên trong (polyglot), và — với
> SVG — kiểm tra script. Khi trả file ra, chỉ ảnh và video thụ động được hiển thị
> inline; mọi thứ khác là bản tải xuống trong sandbox. File hợp lệ được lưu và
> phục vụ nguyên vẹn từng byte.

Bối cảnh: lỗ hổng bypass kiểm tra MIME của Strapi năm 2026 (CVE-2026-22707) là
đúng loại lỗi mà trang này khép lại. Theo dõi: issue #740, epic #674 (S11). Spec
tính năng: `.kiro/specs/upload-file-controls/`.

## Các kiểm tra chạy ở đâu

Mọi kiểm tra nằm trong guard `withFileUploadPolicy`
(`apps/cms/src/middleware/file-upload-policy.ts`), được gắn vào chuỗi API trong
`apps/cms/src/index.ts`, nên chúng chạy **trước** khi bất kỳ route handler nào
ghi vào storage, trên cả hai runtime (Cloudflare Workers và Docker/Node). Các
bề mặt được bảo vệ:

| Bề mặt | Mang theo gì | Kiểm tra |
|---|---|---|
| `POST /api/v1/files` | metadata của file (JSON) | chặn public, allowlist MIME, vệ sinh tên file, đuôi ↔ MIME |
| `PUT /api/v1/files/upload/:key` | bytes thô, presigned (JWT) | allowlist MIME, tên file, kích thước thật, dò nội dung, quét polyglot |
| `POST /api/v1/media/:key` | bytes thô (RBAC) | chặn public + toàn bộ phía trên |

Upload presigned **không** đi thẳng vào storage: bytes vẫn chảy qua bộ nhận của
CMS, nên guard thấy trọn file trước `storage.put`.
`POST /api/v1/files/presigned-url` còn từ chối cấp URL upload cho tên file
không an toàn.

Các helper thuần nằm trong `apps/cms/src/services/upload-security/`:

- `content-sniff.ts` — `sniffContentKind`, `compareDeclaredMime`, `detectPolyglot`
- `svg-sanitizer.ts` — `sanitizeSvg`
- `serve-policy.ts` — `contentDispositionFor`, `userContentHeaders`

Không helper nào dùng DOM, `jsdom` hay API chỉ có trên Node; object stream của
PDF được giải nén bằng `DecompressionStream` của nền tảng.

## 1. Dò magic bytes so với loại khai báo

`sniffContentKind` phân loại bytes; `compareDeclaredMime` so kết quả đó với MIME
khai báo (đã chuẩn hoá):

| Loại khai báo | Bytes phải được nhận diện là |
|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif` | đúng định dạng ảnh đó |
| `video/mp4`, `video/webm` | file ISO-BMFF (brand không phải ảnh tĩnh) / EBML |
| `application/pdf` | `%PDF-` ở offset 0 |
| `image/svg+xml` | tài liệu SVG không có nội dung động (§3) |
| `text/plain`, `text/csv` | văn bản — không phải HTML, SVG hay PHP giả làm văn bản |
| mọi loại khác operator cho phép qua env | bất kỳ thứ gì **trừ** file thực thi hoặc tài liệu HTML/SVG/PHP ngụy trang |

File thực thi (PE, ELF, Mach-O, Java class, script `#!`) bị từ chối dưới mọi
loại khai báo. Không khớp trả về `415 UPLOAD_CONTENT_MISMATCH`.

## 2. Phát hiện polyglot

Polyglot là file hợp lệ đồng thời ở hai định dạng: nó qua được kiểm tra magic
bytes như một ảnh nhưng *cũng* là JAR, PDF hoặc trang HTML. `detectPolyglot`
chạy sau bước dò:

| Phát hiện | Áp dụng cho | Mã lỗi |
|---|---|---|
| `<?php`, `<script`, `<html`, `<!doctype html`, `<iframe`, `<body`, `javascript:` ở bất kỳ đâu trong bytes | ảnh raster, video | `UPLOAD_EMBEDDED_PAYLOAD` |
| bản ghi end-of-central-directory của ZIP/JAR có central directory thật ở đuôi file (GIFAR và họ hàng) | ảnh raster, video, PDF | `UPLOAD_EMBEDDED_PAYLOAD` |
| header `%PDF-` trong 1 KiB đầu | ảnh raster, video | `UPLOAD_EMBEDDED_PAYLOAD` |
| bytes nằm sau chunk `IEND` của PNG | PNG | `UPLOAD_EMBEDDED_PAYLOAD` |
| `/JavaScript`, `/JS`, `/Launch`, `/RichMedia`, hoặc action URI `javascript:` — kể cả tên bị escape `#xx` và dictionary giấu trong object stream nén Flate | PDF | `UPLOAD_ACTIVE_PDF` |

Việc giải nén object stream của PDF có giới hạn (số stream, bytes mỗi stream,
tổng bytes), nên một quả bom giải nén không thể vắt kiệt isolate.

## 3. Bộ làm sạch SVG

`sanitizeSvg` là một tokenizer nhỏ chạy một lượt với **allow-list** phần tử.
Mỗi thứ bị gỡ được phân loại:

- **active** — `<script>`, `<foreignObject>`, `<iframe>`/`<embed>`/`<object>`,
  `<handler>`, nội dung thuộc namespace XHTML/MathML, handler `on*`, giá trị
  `javascript:`/`vbscript:`/`data:text/html` (kể cả khi bị che bằng entity và
  khoảng trắng), `<set>`/`<animate>` đổi đích `href`, CSS `expression()`, mọi
  `<!DOCTYPE>`/`<!ENTITY>` (XXE, billion laughs), và processing instruction khác
  `<?xml ?>` (ví dụ `<?xml-stylesheet?>`). Upload có bất kỳ nội dung active nào
  bị **từ chối**: `415 UPLOAD_UNSAFE_SVG`.
- **external** — `href`/`xlink:href`/`src` không phải `#fragment` hay
  `data:image/...;base64` raster nội tuyến, CSS `@import` và `url(...)` trỏ ra
  ngoài tài liệu. Những thứ này được chấp nhận lúc upload và **bị gỡ khi phục vụ**.
- **unknown** — phần tử ngoài allow-list; bị gỡ khi phục vụ.

Metadata của trình soạn thảo (`sodipodi:`, `inkscape:`, `rdf:`, `dc:`, `cc:`)
được giữ lại. Khi không gỡ gì, đầu vào được trả về nguyên trạng, nên SVG sạch
được phục vụ y hệt từng byte. `GET /api/v1/media/:key` chạy lại bộ làm sạch trên
mọi SVG nó phục vụ (điều này cũng vô hiệu hoá các object đã lưu trước khi có
guard), và bộ transform ảnh trong tiến trình làm sạch nguồn SVG trước khi raster
hoá.

## 4. Vệ sinh tên file

`validateUploadFilename` (dùng chung từ `@lumibase/contracts/schemas`) từ chối,
với `400 UPLOAD_UNSAFE_FILENAME`:

- ký tự điều khiển, kể cả NUL (`photo.png%00.php`);
- ký tự điều khiển hai chiều như U+202E RIGHT-TO-LEFT OVERRIDE
  (`invoice<U+202E>gnp.exe` hiển thị thành `invoiceexe.png`);
- dấu phân cách đường dẫn và `..`;
- dấu chấm hoặc khoảng trắng ở cuối (`shell.php.`);
- đuôi nguy hiểm ở **bất kỳ** vị trí nào (`shell.php.png`, `x.html.jpg`,
  `invoice.pdf.exe`) — xem `DANGEROUS_FILENAME_EXTENSIONS`.

Đuôi cuối cùng vẫn phải khớp MIME khai báo (`415 UPLOAD_EXTENSION_MISMATCH`).

## 5. Chính sách phục vụ

`GET /api/v1/media/:key` đặt, cho mọi object đã lưu:

| Header | Giá trị |
|---|---|
| `Content-Disposition` | `inline` chỉ cho PNG, JPEG, GIF, WebP, AVIF, MP4, WebM; `attachment` cho mọi thứ khác (SVG, PDF, HTML, văn bản, không rõ) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox` |

Tên file trong `Content-Disposition` được bỏ phần thư mục, dấu nháy, ký tự điều
khiển và ký tự bidi; tên không phải ASCII có thêm `filename*` theo RFC 5987.
Object không ghi nhận loại được phục vụ là `application/octet-stream`.

Middleware toàn cục `withSecurityHeaders` giữ CSP riêng của route và thêm policy
nền làm header thứ hai — trình duyệt thực thi cả hai, nên kết quả không bao giờ
yếu hơn bất kỳ policy nào.

## Kiểm soát theo site

Các kiểm tra nằm chồng lên upload policy theo site sẵn có
(**Studio → Settings → Uploads**, `GET/PUT /api/v1/uploads/config`): allowlist
MIME và giới hạn kích thước được áp trước, không đổi. MP4 và WebM giờ có trong
catalogue nhưng **tắt mặc định** — admin site chủ động bật, và khi đó các kiểm
tra dò nội dung và polyglot áp dụng cho chúng như mọi loại khác.

## Những gì cơ chế này không phải

- Không phải trình quét malware/AV. Hãy kết hợp với trình quét ngoài cho tenant
  chịu quản lý (`.kiro/specs/upload-file-controls/` task F2).
- Không phải bộ re-encode. Re-encode ảnh để bỏ mọi thứ trừ pixel là cách chống
  polyglot không có dương tính giả; việc này vẫn đang lên kế hoạch (task F1).
- Header chỉ bảo vệ bytes được phục vụ **qua CMS**. Nếu bạn mở bucket storage
  công khai (R2 public bucket / S3 website), hãy cấu hình `Content-Disposition`,
  `nosniff` và CSP sandbox trên bucket hoặc CDN đó nữa, hoặc phục vụ file người
  dùng từ một domain riêng không có cookie.
- PDF có JavaScript tính toán form bị từ chối cùng với PDF độc hại. Hãy làm
  phẳng (flatten) các form như vậy trước khi upload.
