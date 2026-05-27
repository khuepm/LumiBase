# Implementation Plan: LumiBase Docs i18n

## Overview

Triển khai i18n cho `apps/docs` qua 5 layer: filesystem migration → multi-locale plugin → routing với prefix → UI strings + LocaleSwitcher + DocPage fallback → search per-locale. Default locale = `en`. Cấu trúc thư mục `docs/{locale}/`. URL pattern explicit prefix `/{locale}/docs/{slug}`. Locale list khai báo trong `docs.config.json`.

Tasks ordered theo dependency: migration trước (build mới chạy được), plugin trước routing, hook trước UI, search sau cùng.

## Tasks

- [ ] 1. Filesystem migration & config
  - [ ] 1.1 Mở rộng `docs.config.json` với `i18n.localeNames` và validate `defaultLocale ∈ locales`
    - Thêm `i18n.localeNames: { en: "English", vi: "Tiếng Việt" }`
    - Đảm bảo `defaultLocale: "en"` nằm trong `locales`
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ] 1.2 Migrate `docs/*` → `docs/en/*` bằng `git mv`
    - Move toàn bộ subfolder và file `.md` (trừ `.kiro` config nếu có) sang `docs/en/`
    - Tạo `docs/vi/` rỗng (file `.gitkeep`) để locale folder tồn tại trên git
    - Verify không có file ngoài `docs/{en,vi}/`
    - _Requirements: 1.1, 1.2_

  - [ ] 1.3 Update tất cả internal markdown links trong `docs/en/**/*.md` không cần thay đổi
    - Relative path giữa các file `.md` không phụ thuộc folder root nên migrate xong vẫn work
    - Verify bằng `grep -r '\](\\.\\./' docs/en/` không tăng lên broken
    - _Requirements: 8.1_

- [ ] 2. Multi-locale plugin (build-time registry)
  - [ ] 2.1 Mở rộng `vite-plugin-docs-loader.ts` để discover theo locale
    - Đọc config `i18n.locales` và `i18n.defaultLocale` từ option (truyền từ `vite.config.ts`)
    - Throw build-time Error nếu `defaultLocale ∉ locales`
    - Glob `${docsDir}/${locale}/**/*.md` cho từng locale
    - Build `DocEntry` với field `locale: string`, `filePath: "{locale}/relative/path.md"`, `slug` derive từ path relative tới `${docsDir}/${locale}/`
    - _Requirements: 1.1, 1.2, 1.3, 7.5_

  - [ ] 2.2 Build `MultiLocaleDocRegistry` structure
    - `docList: DocEntry[]` flat
    - `docIndexByLocale: Record<locale, Record<slug, DocEntry>>`
    - `docTreeByLocale: Record<locale, DocNode[]>` (chỉ slug có file ở locale ấy)
    - `docTreeUnion: DocNode[]` (union của tất cả slug, sort như cũ)
    - `docSlugsByLocale: Record<locale, string[]>` (serialize Set sang Array để JSON-stringify được)
    - _Requirements: 4.4, 4.5, 4.6_

  - [ ] 2.3 Update virtual module exports
    - Update `src/types/virtual-docs-registry.d.ts` với types mới
    - Export thêm `locales`, `defaultLocale`, `localeNames`, `docIndexByLocale`, `docTreeByLocale`, `docTreeUnion`, `docSlugsByLocale`
    - Giữ backward-compat aliases: `docIndex` = `docIndexByLocale[defaultLocale]`, `docTree` = `docTreeUnion`
    - _Requirements: 1.1, 7.1_

  - [ ] 2.4 Wire config vào plugin trong `vite.config.ts`
    - Import `docs.config.json` rồi pass `config` option vào plugin factory
    - _Requirements: 7.1_

  - [ ] 2.5 Unit test cho plugin multi-locale
    - Setup fixture có 2 locale với slug overlap và non-overlap
    - Verify: `docIndexByLocale.en['README']` có; `docIndexByLocale.vi['README']` không có nếu vi rỗng
    - Verify: `docTreeUnion` chứa cả slug chỉ có ở en
    - Verify: throw khi `defaultLocale='zz'` ∉ locales
    - _Requirements: 1.1, 4.5, 7.5_

  - [ ] 2.6 Property test 3 — Sidebar union completeness
    - **Property 3**: `s ∈ docTreeUnion` ⇔ `∃ L : s ∈ docSlugsByLocale[L]`
    - Generate random sets of (locale, slug), verify invariant
    - **Validates: Requirements 4.4, 4.5**

- [ ] 3. URL routing với explicit locale prefix
  - [ ] 3.1 Tạo helper `lib/url.ts` với `pathFor`, `parseUrl`
    - `pathFor(locale, slug)`: `/${locale}/docs/${slug}`
    - `parseUrl(path)`: extract `{locale, slug}` hoặc trả `null`
    - _Requirements: 2.1, 2.2_

  - [ ] 3.2 Property test 1 — Locale prefix idempotency
    - **Property 1**: `parseUrl(pathFor(L, s)) === { locale: L, slug: s }` cho mọi L hợp lệ và s
    - **Validates: Requirements 2.1, 2.2**

  - [ ] 3.3 Update `router.tsx` thêm locale prefix routes
    - Root `/` → `<Navigate to={pathFor(defaultLocale, 'README')} replace />`
    - `/docs/*` → `<LegacyRedirect />` redirect tới `/${defaultLocale}/docs/${slug}`
    - `/:locale` route với `<LocaleGuard>` validate; child routes `index` redirect tới `docs/README`, `docs/*` → DocPage
    - `*` → NotFoundPage
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [ ] 3.4 Tạo `LocaleGuard` component
    - Đọc `useParams().locale`, kiểm tra ∈ `locales`
    - Hợp lệ → render children; không hợp lệ → render NotFoundPage (không redirect — preserve URL để user thấy đường dẫn lỗi)
    - _Requirements: 2.4_

  - [ ] 3.5 Tạo `LegacyRedirect` component
    - Đọc wildcard slug từ URL, navigate tới `pathFor(defaultLocale, slug)` với `replace: true`
    - _Requirements: 2.3_

- [ ] 4. Hook & helpers
  - [ ] 4.1 Tạo `hooks/useLocale.ts`
    - Đọc locale từ `useParams().locale`, fallback `defaultLocale` nếu thiếu hoặc không hợp lệ
    - Expose `locale`, `defaultLocale`, `locales`, `setLocale(next, slug?)`
    - `setLocale` navigate tới `pathFor(next, slug ?? currentSlug ?? 'README')` và ghi `localStorage['lumibase-docs:locale']`
    - _Requirements: 3.3, 3.4, 3.6_

  - [ ] 4.2 Tạo helper `useCurrentSlug()`
    - Extract slug từ `useLocation().pathname` bằng `parseUrl()`
    - Trả về string (rỗng nếu không có)

  - [ ] 4.3 Tạo `translations/ui.ts` + helper `t(key, locale, params?)`
    - Bảng UI strings cho keys liệt kê ở Requirement 6.4
    - `t()` lookup theo locale, fallback default locale, replace `{name}` placeholder
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 4.4 Tạo hook `useT()` wrapping `t(...)` với locale từ `useLocale()`
    - Convenience để components không phải pass locale mỗi lần
    - _Requirements: 6.5_

  - [ ] 4.5 Unit test useLocale
    - URL hợp lệ → đọc đúng locale
    - URL không có prefix → trả default
    - URL có locale invalid → trả default (để LocaleGuard handle 404)
    - `setLocale('vi', 'features/ai-copilot')` → navigate đúng path
    - localStorage persistence
    - _Requirements: 3.3, 3.4, 3.6_

- [ ] 5. Components
  - [ ] 5.1 Tạo `LocaleSwitcher` component
    - Dropdown render từ `useLocale().locales` với label từ `localeNames`
    - Active locale highlighted
    - Click → `setLocale(next, currentSlug)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ] 5.2 Mount LocaleSwitcher vào `Layout.tsx` header
    - Đặt cạnh SearchDialog, bên phải navbar
    - _Requirements: 3.1_

  - [ ] 5.3 Update `Layout.tsx` dùng `useT()` cho navbar items label
    - Read label theo logic: nếu là object `{[locale]: string}` → render qua locale; nếu string → render thẳng
    - Tạo helper `resolveLabel(label, locale)` trong `lib/site-config.ts`
    - _Requirements: 7.3, 7.4, 6.5_

  - [ ] 5.4 Update `Layout.tsx` dùng `useT()` cho footer column titles + copyright + sidebar empty state
    - Áp dụng `resolveLabel()` cho footer column titles
    - _Requirements: 6.4, 6.5_

  - [ ] 5.5 Update `Layout.tsx` extract `activeSlug` qua `useCurrentSlug()` và pass vào Sidebar
    - Replace logic hard-code `/docs/` prefix bằng `parseUrl()`
    - _Requirements: 2.1_

  - [ ] 5.6 Update `Sidebar.tsx` mark slug missing ở locale active
    - Đọc `docSlugsByLocale[locale]` → set
    - Pass `missingSlugs: Set<string>` xuống `SidebarNode`
    - SidebarNode render slug missing với opacity giảm + icon translate-pending
    - _Requirements: 4.4, 4.5, 4.6_

- [ ] 6. DocPage fallback + Translation Banner
  - [ ] 6.1 Tạo `lib/resolveDoc.ts` với `resolveDoc(locale, slug)`
    - Trả về `{ entry, isFallback }` hoặc `null`
    - Nếu `docIndexByLocale[locale][slug]` có → `{ entry, isFallback: false }`
    - Else nếu `docIndexByLocale[defaultLocale][slug]` có → `{ entry: <default entry>, isFallback: true }`
    - Else null
    - _Requirements: 4.1, 4.3_

  - [ ] 6.2 Property test 2 — Fallback chain correctness
    - **Property 2**: `resolveDoc` không bao giờ trả entry có `locale !== L && locale !== defaultLocale`. Nếu `isFallback: true` thì `docIndexByLocale[L][s]` undefined.
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ] 6.3 Update `DocPage.tsx` dùng `useLocale()` + `resolveDoc()`
    - Lấy slug từ `useParams()['*']`, locale từ `useLocale()`
    - Gọi `resolveDoc(locale, slug)`. Null → `<Navigate to="/404" />`
    - Render `MarkdownRenderer` với `currentLocale` truyền xuống
    - _Requirements: 4.1, 4.3_

  - [ ] 6.4 Tạo `TranslationBanner` component
    - Hiển thị bên dưới H1, trước nội dung
    - Text qua `useT('banner.translation-pending', { default: 'English' })`
    - Link "Contribute translation" tới repo + path file source
    - _Requirements: 4.2_

  - [ ] 6.5 Update `DocPage` render TranslationBanner khi `isFallback`
    - _Requirements: 4.2_

  - [ ] 6.6 Update browser title qua `useT()` cho suffix " — Lumibase Docs"
    - Vẫn giữ tên doc; chỉ "Lumibase Docs" có thể giữ tiếng Anh hoặc dịch theo locale
    - _Requirements: 6.5_

- [ ] 7. Internal link rewriting với locale awareness
  - [ ] 7.1 Update `LinkRewriter` (`MarkdownRenderer`'s anchor override) nhận thêm `currentLocale`
    - Relative `.md` link → href = `pathFor(currentLocale, targetSlug)` thay vì `/docs/${targetSlug}`
    - Logic broken-link: target slug ∉ ANY locale → broken; target slug ở default chỉ → vẫn rewrite, fallback sẽ trigger
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 7.2 Update `MarkdownRenderer` pass `currentLocale` xuống `LinkRewriter`
    - _Requirements: 8.1_

  - [ ] 7.3 Update tests cho `LinkRewriter` với multi-locale
    - Verify href có locale prefix
    - Verify giữ locale khi navigate
    - _Requirements: 8.1, 8.2_

- [ ] 8. Search per-locale
  - [ ] 8.1 Refactor `lib/search.ts` thành `getSearchIndex(locale)` lazy cache
    - Build index lần đầu khi gọi cho locale; cache trong Map
    - `search(locale, query)` dùng index của locale
    - Helper `createSearchIndex(documents)` (testing) giữ nguyên
    - _Requirements: 5.1, 5.2_

  - [ ] 8.2 Update `SearchDialog.tsx` consume `useLocale()`
    - Truyền `locale` vào `search()`
    - Reset `query` + `results` khi locale thay đổi
    - Placeholder dùng `useT('search.placeholder')`
    - "No results" và "min chars" cũng qua `t()`
    - _Requirements: 5.2, 5.4, 6.5_

  - [ ] 8.3 Property test 4 — Search locale isolation
    - **Property 4**: với mọi `(L, q)`, `search(L, q)` chỉ trả slug ∈ `docSlugsByLocale[L]`
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [ ] 9. NotFound + edge cases
  - [ ] 9.1 Update `NotFoundPage` dùng `useT()` cho title và home link
    - Home link điều hướng tới `/{currentLocale}/docs/README` thay vì `/docs/README`
    - Lấy locale từ URL nếu có, ngược lại default
    - _Requirements: 6.4_

- [ ] 10. Initial Vietnamese content (low-priority deliverable)
  - [ ] 10.1 Tạo `docs/vi/README.md` (dịch từ `docs/en/README.md`)
    - Bản dịch ngắn gọn — không bắt buộc full translation
    - Verify Sidebar / DocPage render đúng khi user truy cập `/vi/docs/README`
    - _Requirements: 1.1, 4.1_

  - [ ] 10.2 Tạo `docs/vi/vision-and-positioning.md` (dịch)
    - _Requirements: 1.1_

  - [ ] 10.3 Tạo `docs/vi/deployment/overview.md` (placeholder hoặc dịch)
    - _Requirements: 1.1_

- [ ] 11. Final integration + verification
  - [ ] 11.1 Verify build `pnpm --filter @lumibase/docs build` xanh
    - Output bundle có nội dung tất cả locale
    - _Requirements: 9.1_

  - [ ] 11.2 Verify deep-link flow
    - Truy cập `/en/docs/features/ai-copilot` từ external → đúng nội dung
    - Truy cập `/vi/docs/features/ai-copilot` (chưa dịch) → fallback en + banner
    - Truy cập `/docs/README` (legacy) → redirect `/en/docs/README`
    - Truy cập `/zz/docs/anything` (locale invalid) → 404
    - _Requirements: 2.3, 2.4, 4.1, 4.2, 9.3_

  - [ ] 11.3 Run đầy đủ `pnpm -r typecheck && lint && test && build`
    - _Requirements: 10.1-10.5_

## Notes

- Property tests dùng `fast-check` với ≥100 iterations như các spec khác.
- Backward-compat: `virtual:docs-registry` vẫn export `docIndex`/`docTree` (alias của default locale view) để code nào chưa migrate vẫn work — dần loại bỏ ở các task sau.
- Khi thêm locale mới (ja, ko, zh), chỉ cần: thêm vào `i18n.locales`, thêm `localeNames[locale]`, thêm `translations/ui.ts` cho locale đó, optional dịch `docs/{locale}/`. Không cần sửa code core.
- Migration `git mv` sẽ tạo nhiều rename trong commit; consider chia commit migration riêng để diff sạch.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "3.1"] },
    { "id": 4, "tasks": ["3.2", "3.3"] },
    { "id": 5, "tasks": ["3.4", "3.5", "4.1", "4.2", "4.3"] },
    { "id": 6, "tasks": ["4.4", "4.5", "5.1"] },
    { "id": 7, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6"] },
    { "id": 8, "tasks": ["6.1"] },
    { "id": 9, "tasks": ["6.2", "6.3"] },
    { "id": 10, "tasks": ["6.4", "6.5", "6.6"] },
    { "id": 11, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 12, "tasks": ["8.1"] },
    { "id": 13, "tasks": ["8.2", "8.3"] },
    { "id": 14, "tasks": ["9.1"] },
    { "id": 15, "tasks": ["10.1", "10.2", "10.3"] },
    { "id": 16, "tasks": ["11.1", "11.2", "11.3"] }
  ]
}
```
