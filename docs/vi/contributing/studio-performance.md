---
sourceLang: en
translatedFrom: en
mtEngine: manual
version: 1
lastUpdated: 2026-11-15T16:56:12.953Z
sourceHash: c51a484b04f8fbf2
syncStatus: human-translated
codeVerified: 2026-11-15T16:56:12.953Z
codeVerifiedHash: c51a484b04f8fbf2
codeVerifiedClaims: 24
---

# Hiệu năng Studio và ngân sách bundle

Studio (`apps/studio`) là một SPA React build bằng Vite. Mỗi lần tải một trang quản trị, trình duyệt phải tải **payload ban đầu** — chunk entry của HTML, mọi chunk mà chunk đó import tĩnh, cùng CSS của chúng — trước khi màn hình đầu tiên có thể hiển thị. Trang này là chính sách giữ payload đó nhỏ, và cách CI thực thi nó (#757).

## Ngân sách

Các giới hạn nằm trong `apps/studio/bundle-budget.json`, tính bằng byte gzip:

| Chỉ số | Ngân sách | Đo được khi đặt |
| --- | --- | --- |
| `initialJsGzipBytes` | 200000 | 182502 |
| `initialCssGzipBytes` | 15000 | 13329 |

Chỉ đồ thị ban đầu được tính. Một chunk chỉ đến được qua `import()` động — một route lazy, một component lazy — vẫn được liệt kê trong báo cáo nhưng không bị tính vào ngân sách, vì nó tải sau lần vẽ đầu tiên và chỉ cho những màn hình cần đến nó.

## Chạy kiểm tra

```bash
pnpm -F @lumibase/studio exec vite build --manifest
pnpm studio:budget
```

`pnpm studio:budget` chạy `scripts/check-studio-bundle-budget.mjs`. Script đọc `apps/studio/dist/.vite/manifest.json`, đi từ mỗi chunk entry chỉ qua các `imports` tĩnh, đo từng file (raw, gzip mức 9, brotli quality 11), in ra các chunk lớn nhất kèm cột `initial`/`lazy`, và thoát với mã khác 0 khi một chỉ số có ngân sách vượt giới hạn. Giới hạn bị thiếu hoặc không dương là lỗi cấu hình và cũng làm kiểm tra thất bại.

CI chạy đúng hai bước này trong `.github/workflows/studio-bundle-budget.yml` cho mọi pull request đụng đến Studio hoặc các package mà nó bundle, và ghi bảng kết quả vào job summary.

## Khi kiểm tra thất bại

1. Đọc bảng. Một dòng `initial` mới, hoặc một dòng `initial` lớn lên, chính là chỗ hồi quy.
2. Đưa phần nặng ra sau một ranh giới thay vì nâng giới hạn:
   - cả một màn hình → một route lazy trong `apps/studio/src/router.tsx` (`lazy(() => import(...))` + `withSuspense`);
   - một component nặng bên trong màn hình → `React.lazy` + `Suspense` với fallback có kích thước cố định (xem `components/lazy-monaco-editor.tsx`);
   - UI chỉ dùng khi tương tác (palette, kéo-thả) → chỉ mount khi được mở (xem `components/sortable-module-nav.tsx`).
3. Cẩn thận với **import tĩnh làm vô hiệu ranh giới lazy**. Nếu một module trên đường boot import một giá trị từ module được tải lazy, bundler sẽ giữ module đó trong chunk ban đầu và in ra `INEFFECTIVE_DYNAMIC_IMPORT`. Hãy chuyển giá trị dùng chung vào một module nhỏ không có dependency (như `modules/setup/setup-drafts.ts` và `modules/setup/schemas/admin-path-rules.ts`).
4. Chỉ khi phần nặng thực sự thuộc về lần vẽ đầu tiên, mới nâng giới hạn trong `apps/studio/bundle-budget.json` ngay trong PR đó và nêu lý do.

## Request lúc boot

Một lần boot Studio từ trạng thái lạnh gửi **tối đa hai** request về quyền/danh tính: một `GET /api/v1/permissions/me` (permission bundle đã biên dịch) và một `GET /api/v1/me/preferences`. Mọi nơi gọi — app shell, `usePermissions`, đồng bộ ngôn ngữ, hook save-action, ma trận quyền — đều đọc qua các query option dùng chung trong `apps/studio/src/lib/me-queries.ts`, nên React Query khử trùng lặp chúng. Đừng tạo query key mới cho hai endpoint này; hãy spread `permissionsQueryOptions()` / `mePreferencesQueryOptions()` và invalidate `PERMISSIONS_QUERY_KEY` / `ME_PREFERENCES_QUERY_KEY`. `components/__tests__/boot-requests.test.tsx` sẽ thất bại nếu một lần boot gửi nhiều hơn hai request như vậy.

## Dashboard tải dần

Các widget của dashboard hiển thị độc lập: mỗi widget tự sở hữu query và placeholder loading của riêng nó, nên bảng được vẽ dần khi từng nguồn trả lời thay vì chờ nguồn chậm nhất. Bọc widget trong `DashboardWidget` (`apps/studio/src/components/dashboard-widget.tsx`) để có skeleton Suspense và error boundary riêng, nhờ đó một widget bị lỗi chỉ hiện một thẻ "unavailable" khoanh vùng kèm nút thử lại thay vì làm trống cả trang. Một thẻ thống kê có nguồn còn đang tải sẽ hiện placeholder, không bao giờ hiện số `0` giả.

## Công cụ build

Studio và trang docs build bằng Vite 8 (Rolldown) và `@vitejs/plugin-react` 6; test dùng Vitest 5. Dải `pnpm.overrides.vite` ở root phải giao với dải mà các app khai báo (`pnpm drift:check`). `examples/extension-color-picker` nằm ngoài pnpm workspace và tự ghim phiên bản Vite riêng, như một template độc lập cho tác giả extension.
