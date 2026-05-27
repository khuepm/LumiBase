# Requirements Document

## Introduction

Tài liệu yêu cầu cho **LumiBase Docs i18n** — mở rộng `apps/docs` để phục vụ nội dung Markdown ở nhiều ngôn ngữ. Mỗi locale có URL prefix riêng (`/{locale}/docs/{slug}`) và nội dung đặt trong thư mục `docs/{locale}/`. Locale mặc định là `en`. Khi một file chưa có ở locale yêu cầu, hệ thống fallback về locale mặc định và hiển thị banner cho biết bản dịch chưa hoàn thiện. Locale list được khai báo trong `docs.config.json` để dễ thêm ngôn ngữ mới (vi, ja, ko, zh, ...) mà không cần sửa code.

## Glossary

- **Docs Viewer**: Ứng dụng web `apps/docs` (Vite + React).
- **Locale**: Mã ngôn ngữ ngắn theo BCP 47 (`en`, `vi`, `ja`, `ko`, `zh`, ...).
- **Default Locale**: Locale mặc định khi user truy cập URL không có prefix locale, lấy từ `docs.config.json.i18n.defaultLocale`.
- **Active Locale**: Locale hiện tại đang hiển thị, lấy từ URL prefix.
- **Locale List**: Danh sách locale được hỗ trợ, lấy từ `docs.config.json.i18n.locales`.
- **Locale Folder**: Thư mục chứa nội dung của một locale, đặt tại `docs/{locale}/`.
- **Doc Slug**: Đường dẫn tương đối của file `.md` so với locale folder, không có đuôi `.md`. Ví dụ `docs/vi/features/ai-copilot.md` → slug `features/ai-copilot`.
- **Locale Switcher**: Dropdown trong header cho phép chuyển locale.
- **Translation Banner**: Thông báo hiển thị trên trang đã fallback về default locale.
- **Doc Registry**: Object chứa `docTree`, `docIndex`, `docList` của tất cả locale, đẩy ra qua `virtual:docs-registry`.

## Requirements

### Requirement 1: Cấu trúc thư mục theo locale

**User Story:** Là một biên tập viên tài liệu, tôi muốn nội dung của mỗi ngôn ngữ nằm trong thư mục riêng, để tôi có thể quản lý bản dịch một cách rõ ràng và độc lập.

#### Acceptance Criteria

1. THE Docs_Viewer SHALL đọc tài liệu từ các thư mục `docs/{locale}/**/*.md` cho mỗi `locale` được khai báo trong `docs.config.json.i18n.locales`.
2. THE Docs_Viewer SHALL chấp nhận đường dẫn tương đối (Doc Slug) của file `.md` đối với Locale Folder làm slug, ví dụ `docs/en/features/ai-copilot.md` có slug `features/ai-copilot`.
3. WHEN một file `.md` được thêm vào `docs/{locale}/`, THE Docs_Viewer SHALL include nó vào Doc Registry trên build/HMR mà không cần cấu hình thêm.
4. THE Docs_Viewer SHALL không yêu cầu locale folder phải tồn tại đầy đủ — locale folder rỗng vẫn hợp lệ và sẽ fallback về default locale cho mọi slug.

### Requirement 2: URL routing với explicit locale prefix

**User Story:** Là một độc giả, tôi muốn URL chứa locale rõ ràng (`/en/docs/...`, `/vi/docs/...`), để tôi có thể chia sẻ link đúng ngôn ngữ và bookmark được tin cậy.

#### Acceptance Criteria

1. THE Router SHALL map mỗi (locale, slug) tới URL path có dạng `/{locale}/docs/{slug}`.
2. WHEN người dùng truy cập `/`, THE Router SHALL redirect tới `/{defaultLocale}/docs/README` với defaultLocale lấy từ `docs.config.json.i18n.defaultLocale`.
3. WHEN người dùng truy cập URL cũ không có prefix locale, có dạng `/docs/{slug}`, THE Router SHALL redirect (HTTP 302 hoặc client-side `<Navigate>` replace) tới `/{defaultLocale}/docs/{slug}` để giữ tương thích link cũ.
4. WHEN người dùng truy cập `/{locale}/docs/{slug}` mà `locale` không có trong Locale List, THE Router SHALL hiển thị 404 Not Found page.
5. WHEN người dùng truy cập `/{locale}/docs/{slug}` mà slug không có trong Doc Registry của locale ấy, THE Docs_Viewer SHALL áp dụng cơ chế fallback ở Requirement 4 thay vì 404.
6. THE Router SHALL dùng HTML5 History API (no hash fragments) để giữ URL sạch.

### Requirement 3: Locale Switcher

**User Story:** Là một độc giả, tôi muốn chuyển sang ngôn ngữ khác từ menu, để tôi đọc được tài liệu mà không phải gõ URL bằng tay.

#### Acceptance Criteria

1. THE Layout SHALL hiển thị một Locale Switcher dạng dropdown trong header.
2. THE Locale Switcher SHALL liệt kê tất cả locale từ `docs.config.json.i18n.locales` với tên hiển thị từ map cấu hình (ví dụ `en` → "English", `vi` → "Tiếng Việt").
3. WHEN người dùng chọn một locale `L` khác từ Locale Switcher, THE Locale Switcher SHALL điều hướng tới `/{L}/docs/{currentSlug}` mà không gây full page reload.
4. WHEN URL không chứa slug (ví dụ user đang ở `/{locale}` rỗng), THE Locale Switcher SHALL điều hướng tới `/{L}/docs/README`.
5. THE Locale Switcher SHALL highlight locale đang active.
6. THE Locale Switcher SHALL ghi nhớ locale đã chọn vào `localStorage` (key `lumibase-docs:locale`) để mở app lần sau ưu tiên hiển thị locale đó khi user truy cập URL không có locale prefix (chỉ ảnh hưởng `/`, không override URL có prefix).

### Requirement 4: Fallback khi nội dung chưa dịch

**User Story:** Là một độc giả, tôi muốn vẫn đọc được nội dung khi bản dịch chưa hoàn thiện, để tôi không gặp 404 khi locale của tôi thiếu file.

#### Acceptance Criteria

1. WHEN người dùng truy cập `/{locale}/docs/{slug}` mà file không tồn tại trong `docs/{locale}/`, THE Docs_Viewer SHALL load nội dung từ `docs/{defaultLocale}/{slug}.md` nếu file đó tồn tại.
2. WHEN nội dung được fallback về default locale, THE Doc_Page SHALL hiển thị Translation Banner ở đầu trang với thông báo cho biết bản dịch chưa có và liên kết về repo để đóng góp.
3. WHEN cả hai file (locale yêu cầu và default locale) đều không tồn tại, THE Router SHALL hiển thị 404 Not Found page.
4. WHEN slug không tồn tại ở bất kỳ locale nào, THE Sidebar SHALL không hiển thị link đến slug đó cho locale active.
5. THE Sidebar SHALL hiển thị link đến slug có ở default locale ngay cả khi locale active không có file (để user thấy được toàn bộ tài liệu, click vào sẽ trigger fallback ở Acceptance Criteria 1).
6. THE Sidebar SHALL đánh dấu trực quan (ví dụ icon hoặc opacity giảm) cho các slug chưa có ở locale active.

### Requirement 5: Search trong locale active

**User Story:** Là một độc giả, tôi muốn search chỉ trả về kết quả của locale tôi đang đọc, để tôi không bị nhiễu bởi nội dung ngôn ngữ khác.

#### Acceptance Criteria

1. THE Search_Engine SHALL build index riêng cho mỗi locale.
2. WHEN người dùng search ở locale `L`, THE Search_Engine SHALL chỉ trả về kết quả từ `docs/{L}/`.
3. WHEN một slug không có ở locale `L` nhưng có ở default locale, THE Search_Engine SHALL không bao gồm slug đó trong index của locale `L` (search không trigger fallback).
4. WHEN người dùng chuyển locale, THE Search_Engine SHALL switch sang index của locale mới mà không cần reload trang.

### Requirement 6: UI strings được dịch

**User Story:** Là một độc giả, tôi muốn các nút, label, thông báo trong UI hiển thị bằng ngôn ngữ của tôi, để trải nghiệm nhất quán.

#### Acceptance Criteria

1. THE Docs_Viewer SHALL có một bảng UI strings ở `apps/docs/src/translations/ui.ts` với key cho mỗi string sử dụng trong UI và value là object `{ [locale]: string }`.
2. THE Docs_Viewer SHALL render mỗi UI string dựa trên locale active.
3. IF một UI string thiếu translation cho locale active, THEN THE Docs_Viewer SHALL fallback hiển thị string ở default locale.
4. THE UI strings cần dịch tối thiểu bao gồm: navbar items label (Docs/API/Roadmap), search placeholder, search "no results", search "type at least 2 characters", 404 message, 404 home link label, footer column titles, footer copyright, sidebar empty state, translation banner content, locale switcher tooltip.
5. THE Layout, Search Dialog, Not Found page, và DocPage SHALL render UI strings qua một helper `useUiTranslation(locale)` hoặc `t(key, locale)` thay vì hard-code chuỗi.

### Requirement 7: Cấu hình docs.config.json hỗ trợ i18n

**User Story:** Là một maintainer, tôi muốn khai báo locale list, tên hiển thị, và label dịch của navbar/sidebar trong một file config, để thêm ngôn ngữ mới không cần thay đổi code.

#### Acceptance Criteria

1. THE docs.config.json SHALL có khối `i18n` chứa các trường: `defaultLocale: string`, `locales: string[]`, `localeNames: { [locale]: string }`.
2. THE Docs_Viewer SHALL đọc `i18n.localeNames` để lấy tên hiển thị cho Locale Switcher; nếu thiếu cho locale nào, hiển thị mã locale ấy (vd `en`).
3. THE docs.config.json SHALL hỗ trợ key `label` ở navbar items, sidebar categories và footer column dạng:
   - String đơn giản (áp dụng mọi locale, giữ tương thích cũ), HOẶC
   - Object `{ [locale]: string }` để dịch theo locale.
4. THE Docs_Viewer SHALL render label dựa trên locale active; nếu label là object và thiếu locale active, fallback hiển thị label của default locale; nếu cả hai đều thiếu, hiển thị raw key/string của locale đầu tiên trong object.
5. WHEN `docs.config.json.i18n.defaultLocale` không nằm trong `i18n.locales`, THE Docs_Viewer SHALL log một build-time error rõ ràng và fail build.

### Requirement 8: Internal link giữ nguyên locale

**User Story:** Là một độc giả, tôi muốn click vào link nội bộ giữa các trang tài liệu vẫn giữ ngôn ngữ tôi đang đọc, để không bị nhảy về EN ngẫu nhiên.

#### Acceptance Criteria

1. WHEN MarkdownRenderer encounter một relative link tới file `.md` khác, THE MarkdownRenderer SHALL rewrite href thành `/{currentLocale}/docs/{targetSlug}` thay vì `/docs/{targetSlug}`.
2. WHEN user navigate qua link đã rewrite, THE Router SHALL giữ locale active.
3. WHEN target slug không tồn tại trong locale active nhưng có ở default locale, THE MarkdownRenderer SHALL vẫn rewrite link bình thường (broken-link styling không áp dụng); fallback sẽ kích hoạt khi user navigate.
4. WHEN target slug không tồn tại ở bất kỳ locale nào, THE MarkdownRenderer SHALL render link ở dạng broken-link như hiện tại (strikethrough, không navigate).

### Requirement 9: Build & deploy support

**User Story:** Là một maintainer, tôi muốn build static site phục vụ tất cả locale, để deploy lên CDN không cần xử lý đặc biệt.

#### Acceptance Criteria

1. WHEN chạy `pnpm --filter @lumibase/docs build`, THE Vite build SHALL bundle nội dung của tất cả locale vào output static.
2. THE Docs_Viewer SHALL hoạt động đúng khi serve sau một static file server với SPA fallback (mọi route trỏ về `index.html`).
3. THE Docs_Viewer SHALL hỗ trợ deep-linking: trỏ trực tiếp `/{locale}/docs/{slug}` từ external link phải hiển thị đúng nội dung sau khi load.
4. THE script `docs:deploy` (nếu có) hoặc tài liệu deploy hiện tại SHALL không cần sửa đổi gì khác ngoài việc build vẫn produce output static — cấu hình SPA fallback của host nắm tất cả route.

### Requirement 10: Unit tests và property tests

**User Story:** Là một lập trình viên, tôi muốn có test coverage cho hành vi i18n quan trọng, để regression không lọt qua khi thêm ngôn ngữ mới.

#### Acceptance Criteria

1. THE Plugin Tests SHALL cover scenario: build registry với nhiều locale, slug có ở mọi locale, slug chỉ có ở default locale, slug chỉ có ở non-default locale.
2. THE useLocale Hook Tests SHALL cover: đọc locale từ URL prefix hợp lệ, đọc locale từ URL không có prefix (trả về default), đọc locale từ URL có prefix không hợp lệ (trả về default), `setLocale()` điều hướng đúng URL mới.
3. THE Fallback Tests SHALL cover: render DocPage với slug chỉ có ở default locale (banner hiện), slug có ở locale active (banner ẩn), slug không tồn tại ở đâu (404).
4. THE Search Tests SHALL cover: search ở locale `L` chỉ trả document từ `docs/{L}/`; chuyển locale làm refresh kết quả.
5. THE Property Tests SHALL có ít nhất 2 properties:
   - **Property 1 — Locale prefix idempotency**: Với mọi `slug` hợp lệ và locale `L`, đường dẫn được sinh từ `pathFor(L, slug)` rồi parse lại bằng `parseLocale(path)` phải trả về `L` và `slug` ban đầu.
   - **Property 2 — Fallback chain**: Với mọi `slug` và locale `L`, `resolveDoc(L, slug)` không bao giờ trả về một entry có `locale !== L && locale !== defaultLocale`. Nếu trả về entry với `locale === defaultLocale`, thì `docs/{L}/{slug}.md` không tồn tại.
