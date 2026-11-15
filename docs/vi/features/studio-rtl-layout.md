---
version: 2
sourceLang: en
lastUpdated: 2026-11-15T16:50:32.627Z
translatedFrom: en
sourceHash: 3e952805b2b9d3e6
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:50:32.627Z
codeVerifiedHash: 3e952805b2b9d3e6
codeVerifiedClaims: 20
---

# Bố cục phải-sang-trái (RTL) trong Studio

Studio lật bố cục cho các ngôn ngữ giao diện viết từ phải sang trái: **tiếng Ả Rập (`ar`)**, **tiếng Do Thái (`he`)** và **tiếng Ba Tư / Farsi (`fa`)**. Chọn một trong số đó sẽ đặt `<html dir="rtl">`, nên thanh bên, thanh công cụ, bảng, menu và các icon có hướng đều chuyển sang phía bên kia. Các trường nội dung đi theo hướng của locale *nội dung* một cách độc lập, nên một bản dịch tiếng Ả Rập vẫn được gõ từ phải sang trái ngay cả trong giao diện tiếng Anh.

Code: `apps/studio/src/lib/text-direction.ts`, `apps/studio/src/lib/ui-language.ts`, `apps/studio/src/components/site-language.tsx`, `apps/studio/src/components/ui-language-picker.tsx`.

## Chọn ngôn ngữ giao diện RTL

Ngôn ngữ giao diện được xác định theo thứ tự sau (`resolveUiLanguage`):

1. tùy chọn của người dùng đang đăng nhập, `preferences.language` (`GET /api/v1/me/preferences`);
2. ngôn ngữ mặc định của site (**Settings → Site → Default language**);
3. tiếng Anh.

Người dùng đổi ngôn ngữ của chính mình bằng bộ chọn **Interface language** trên thanh trên cùng; bộ chọn ghi `preferences.language` qua `PATCH /api/v1/me/preferences`. Quản trị viên site chọn tiếng Ả Rập, Do Thái hoặc Farsi làm mặc định của site trong **Settings → Site**.

Studio hỗ trợ `en`, `vi`, `ar`, `he` và `fa` làm ngôn ngữ giao diện (`UI_LANGUAGES`). Tag được so khớp theo ngôn ngữ gốc, nên `ar-EG` chọn `ar`; tag tiếng Do Thái cũ `iw` chọn `he`.

Ngôn ngữ xác định gần nhất được ghi nhớ trong trình duyệt (khóa `localStorage` `lumibase.ui-language`), nên trang đăng nhập và lần vẽ đầu tiên sau khi tải lại đã dùng đúng hướng thay vì chớp sang trái-sang-phải.

### Bản dịch giao diện

`ar`, `he` và `fa` được hỗ trợ cho **bố cục**. Studio không đóng gói sẵn bản dịch tiếng Ả Rập, Do Thái hay Farsi (`BUNDLED_UI_LANGUAGES` là `en` và `vi`): chuỗi nào chưa có bản dịch trong namespace `ui` do CMS quản lý (**Settings → Translations**) sẽ dùng tiếng Anh, hiển thị trong bố cục đã lật. Chuỗi không bao giờ được dịch máy tự động.

## Cách xác định hướng

`directionOf(tag)` trả về `rtl` hoặc `ltr` từ một bảng cố định, không dùng `Intl.Locale#getTextInfo()` vì Firefox và WebKit cũ (shell desktop trên macOS/Linux) không có:

- subtag chữ viết (script) tường minh quyết định: `az-Arab` là RTL, `ks-Deva` là LTR;
- nếu không có thì theo ngôn ngữ gốc: `ar`, `arc`, `ckb`, `dv`, `fa`, `he`, `iw`, `ks`, `mzn`, `pnb`, `ps`, `sd`, `syr`, `ug`, `ur` và `yi` là RTL;
- mọi trường hợp khác, kể cả tag thiếu hoặc sai dạng, là LTR.

`applyDocumentLanguage(lang)` ghi cả `lang` và `dir` lên `<html>`. Hàm chạy trước lần render đầu tiên (`main.tsx`), ở mỗi sự kiện `languageChanged` của i18next (`lib/i18n.ts`) và sau khi `SiteLanguageSync` xác định ngôn ngữ của người dùng đã đăng nhập.

## Hướng của nội dung

Trình soạn văn bản lấy hướng của locale đang được soạn, không phải của giao diện (`contentDirProps(locale)`):

| Trình soạn | Hướng |
|---|---|
| `translatable-text` — một ô nhập cho mỗi locale của site | mỗi ô nhận `dir` và `lang` của locale đó |
| Chế độ dịch — nguồn và đích đặt cạnh nhau | mỗi khung nhận `dir` và `lang` của locale đó |
| `input`, `input-multiline`, `markdown`, `wysiwyg` | prop `locale` của trường khi nơi gọi biết, nếu không thì `dir="auto"` (trình duyệt chọn hướng theo ký tự mạnh đầu tiên được gõ) |

Các locale của site lấy từ setting `locales` (`value.supported`), cùng nguồn mà module Translations dùng.

Những phần sau luôn giữ trái-sang-phải, bất kể ngôn ngữ: trình soạn code Monaco (JSON, trường code, type sinh ra, JSON của policy), canvas flow và khối code `<pre>`.

## Viết code Studio an toàn cho RTL

Dùng các utility **logic** của Tailwind (Tailwind v4 có đủ):

| Vật lý (không dùng) | Logic |
|---|---|
| `ml-*` / `mr-*` | `ms-*` / `me-*` |
| `pl-*` / `pr-*` | `ps-*` / `pe-*` |
| `left-*` / `right-*` | `start-*` / `end-*` |
| `text-left` / `text-right` | `text-start` / `text-end` |
| `border-l` / `border-r` | `border-s` / `border-e` |
| `rounded-l-*` / `rounded-r-*` | `rounded-s-*` / `rounded-e-*` |
| `float-left` / `float-right` | `float-start` / `float-end` |
| `style={{ paddingLeft }}` | `style={{ paddingInlineStart }}` |

`space-x-*` và `divide-x-*` đã là logic trong Tailwind v4. Một transform `translate-x-*` là vật lý: thêm giá trị lật dưới variant `rtl:`, như nút gạt của toggle (`translate-x-[18px] rtl:-translate-x-[18px]`).

### Chốt chặn CSS logic

`pnpm logical-css:check` (`scripts/check-logical-css.mjs`, nằm trong `pnpm check:all`, nên chạy ở pre-commit hook và CI) báo lỗi khi `apps/studio/src` hoặc `packages/ui/src` chứa utility hướng vật lý hoặc khóa inline-style vật lý. Script in ra phần thay thế logic cho từng chỗ:

```bash
pnpm logical-css:check                       # báo cáo
node scripts/check-logical-css.mjs --fix     # viết lại tại chỗ (codemod)
```

Không bị báo: class dưới variant `rtl:` hoặc `ltr:`, dòng có comment `rtl-physical-ok`, và các file trong `ALLOW_FILES` của script (renderer node của canvas flow và lớp phủ con trỏ của người cộng tác, vốn vẽ theo tọa độ vật lý).

### Icon

Icon có hướng tự lật trong RTL nhờ một rule trong `apps/studio/src/index.css` dựa trên class icon của lucide: chevron và mũi tên trỏ trái hoặc phải, first/last, mở/đóng panel, đăng nhập/đăng xuất, gửi, trả lời/chuyển tiếp, hoàn tác/làm lại và thụt lề danh sách. Icon chỉ một phía vật lý hoặc không có hướng thì không lật: logo, media, dấu tích, external-link, căn lề văn bản, mũi tên lên/xuống. Icon có class `rotate-*` riêng được giữ nguyên. Thêm `rtl-no-flip` để loại một icon, hoặc `rtl-flip` để lật một SVG tự vẽ.

Studio không dùng Radix hay thư viện headless khác cần `DirectionProvider`; các phần tử native kế thừa `dir` từ `<html>`.

## Kiểm tra end-to-end

`apps/studio/e2e/rtl-layout.e2e.mjs` phục vụ Studio bằng Vite, trả lời mọi lời gọi `/api/**` từ fixture (không cần CMS) và render trang đăng nhập, danh sách item của một collection, trình soạn item và **Settings → Site** bằng tiếng Ả Rập ở độ rộng desktop và mobile. Với mỗi màn hình, script kiểm tra `<html dir="rtl">`, không tràn ngang trang, các control tương tác nằm trong viewport, các control cùng cấp không chồng lên nhau và không icon nào trong ô nhập che chữ của ô nhập, rồi lưu ảnh chụp màn hình:

```bash
cd apps/studio
node e2e/rtl-layout.e2e.mjs                    # ảnh trong e2e/artifacts/
RTL_E2E_LANG=he node e2e/rtl-layout.e2e.mjs    # một ngôn ngữ RTL khác
```

Workflow `Studio RTL layout` (`.github/workflows/studio-rtl-e2e.yml`) chạy script này trên các pull request chạm vào Studio hoặc `packages/ui` và tải ảnh chụp lên làm artifact.

## Shell desktop và mobile

Shell Tauri render cùng một tài liệu, nên nó theo `<html dir>` mà không cần thêm code. Thanh tiêu đề và nút cửa sổ native theo ngôn ngữ của hệ điều hành, không theo ngôn ngữ của Studio. Các contract của shell (lưu token, API base URL, thư mục build, cổng dev) không đổi.
