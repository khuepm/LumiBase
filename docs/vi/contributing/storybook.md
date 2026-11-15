---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:56:37.070Z
translatedFrom: en
sourceHash: f07af56f0b41a29c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:56:37.070Z
codeVerifiedHash: f07af56f0b41a29c
codeVerifiedClaims: 16
---

# Storybook: catalogue UI, a11y và visual test

LumiBase có một Storybook cho các primitive của `@lumibase/ui` và một tập component tiêu biểu của Studio: field interface, display, bảng dữ liệu và dialog. Storybook được publish cùng site docs tại [`/storybook/`](/storybook/).

Storybook nằm trong workspace package riêng là `apps/storybook`. `packages/ui` và `apps/studio` không mang dependency nào của Storybook. Story import component Studio trực tiếp từ source qua alias `@/` của Studio, nên story luôn render đúng code được ship.

| Nội dung | Vị trí |
| --- | --- |
| Cấu hình Storybook (addon, Vite alias, base tương đối) | `apps/storybook/.storybook/main.ts` |
| Thanh theme, decorator QueryClient, cổng a11y | `apps/storybook/.storybook/preview.tsx` |
| Story của `@lumibase/ui` | `apps/storybook/src/ui/` |
| Story của Studio | `apps/storybook/src/studio/` |
| Fixture field và khung label | `apps/storybook/src/support/fixtures.tsx` |
| Ngoại lệ a11y có lý do | `apps/storybook/src/support/a11y.ts` |
| Script visual regression | `apps/storybook/scripts/visual-snapshots.mjs` |
| Workflow CI | `.github/workflows/storybook.yml` |

Phiên bản: Storybook `10.6.7` với `@storybook/react-vite`, nhận Vite 5 đến 8 (Studio đang dùng Vite 8), và `@storybook/addon-vitest` chạy trên browser mode của Vitest 5 với Playwright.

## Chạy

```bash
pnpm storybook                                   # dev server tại http://localhost:6006
pnpm storybook:build                             # build tĩnh → apps/storybook/storybook-static
pnpm --filter @lumibase/storybook test           # guard (node, nhanh)
pnpm storybook:test                              # mọi story trong Chromium, sáng + tối
pnpm --filter @lumibase/storybook test:visual    # ảnh chụp → apps/storybook/visual-output/current
```

Test trên trình duyệt cần bản Chromium khớp với devDependency `playwright`. Trên máy mới, chạy `pnpm --filter @lumibase/storybook exec playwright install chromium` một lần.

## Viết story

1. Đặt cạnh các story cùng loại: `src/ui/<name>.stories.tsx` cho một export của `@lumibase/ui`, `src/studio/<area>.stories.tsx` cho Studio.
2. Dùng CSF 3 với `title` nằm dưới `UI/` hoặc `Studio/`. Truyền cho mỗi story đúng các prop nó cần. Không bao giờ gọi CMS.
3. Dữ liệu: component đọc qua TanStack Query được cấp một `QueryClient` mới cho mỗi story, đã tắt retry. Nạp dữ liệu bằng `parameters.queryData: [[queryKey, data], …]`. Không mock `fetch`.
4. Label: interface của Studio được render trong một dòng form có label. Bọc chúng trong `FieldFrame`, hoặc `FieldGroupFrame` khi interface có nhiều control, để bản quét a11y đánh giá control đúng như người dùng gặp.
5. Thêm hàm `play` cho các hành vi quan trọng (gõ phím, bật/tắt, nút submit bị vô hiệu). Hàm này chạy như một test trong CI.
6. Giữ tính tất định: ngày cố định (hoặc ngày tính tương đối theo thời điểm render), không dữ liệu ngẫu nhiên, không timer. Visual check chụp trạng thái cuối cùng sau `play`.

### Mọi primitive của `@lumibase/ui` đều có story

Project `guards` dùng TypeScript compiler API để resolve mọi value export của `packages/ui/src/index.ts`. Nó fail khi có export không được story nào dưới `src/ui/` import. Khi thêm một primitive (`Button`, `Dialog`, …), hãy thêm story của nó trong cùng PR.

## Cổng accessibility

`@storybook/addon-a11y` chạy axe trên mọi story, và `.storybook/preview.tsx` đặt `parameters.a11y.test = 'error'`. Bất kỳ vi phạm nào cũng làm `pnpm storybook:test` fail. Lượt chạy diễn ra hai lần, mỗi theme một lần (các project Vitest `stories-light`, `stories-dark`), nên độ tương phản màu được kiểm tra trên cả hai bảng màu.

Hãy sửa component bất cứ khi nào có thể. Khi một vi phạm thực sự không thuộc trách nhiệm của component, tắt đúng rule đó cho đúng story đó bằng `a11yException()`:

```tsx
import { a11yException } from '../support/a11y';

export const InsideShellOnly: Story = {
  parameters: a11yException([
    { rule: 'region', justification: 'Rendered without the app shell landmarks; the real page wraps it in <main>.' },
  ]),
};
```

Lý do phải dài ít nhất 40 ký tự. Guard sẽ fail khi một story tắt cổng theo bất kỳ cách nào khác (`enabled: false`, `test: 'off' | 'todo'`, `disable: true`, `manual: true`). Hiện chưa có ngoại lệ nào. Khi nối cổng vào, nó đã phát hiện các lỗi thật, và chúng đã được sửa trong Studio:

- token `--muted-foreground` của theme sáng và cả hai token `--destructive` chưa đạt WCAG AA 4.5:1 (chữ destructive ở dark mode chỉ khoảng 2:1);
- `rating-stars` đặt `aria-label` trên một `span` thường (nay là `role="img"`);
- dialog lưu bookmark không có accessible name;
- các interface slider, màu và tags có input không có tên.

## Sáng và tối

Global **Theme** trên thanh công cụ bật/tắt class `.dark` trên `<html>`, cùng công tắc mà `site-theme.tsx` của Studio dùng. Mọi story phải dễ đọc ở cả hai theme. CI test cả hai, và visual check chụp cả hai.

## Visual regression

`scripts/visual-snapshots.mjs capture` phục vụ một bản build tĩnh và chụp ảnh mọi story ở cả hai theme, với thiết lập cố định: viewport 800×600, scale 1, `en-US`, UTC, giảm chuyển động, và tắt animation, transition cùng con trỏ nhập liệu. `compare` so sánh hai lần chụp bằng pixelmatch. Một ảnh được tính là thay đổi khi hơn 0.1% số pixel khác nhau.

Trên pull request, job `visual` chụp bản build **base** và **head** trên **cùng một runner** rồi so sánh. Chúng tôi chọn cách này thay vì commit ảnh PNG baseline. Baseline render trên máy của người đóng góp không bao giờ khớp với cách runner CI raster hoá font. Chúng cũng thêm thay đổi nhị phân vào mọi thay đổi UI. So sánh trên một máy triệt tiêu cả hai vấn đề. Ảnh diff, cùng cả hai lần chụp, được upload thành artifact `storybook-visual-diff`, và job summary liệt kê các ảnh đã thay đổi. Một thay đổi giao diện có chủ đích sẽ làm job fail cho đến khi maintainer gắn label `visual-change-approved`.

## Publish

Workflow release (`pages-deploy.yml`) chạy `pnpm storybook:build` trước `pnpm docs:build`. Bước cuối của docs build là `apps/docs/scripts/copy-storybook.mjs`, sao chép `storybook-static` vào `apps/docs/dist/storybook/`. Storybook build với base tương đối, nên chạy được từ sub-path đó mà không cần rule redirect. `STORYBOOK_REQUIRED=1` khiến bản release fail thay vì ship link **Storybook** trên navbar trỏ vào chỗ trống. Docs build ở local khi chưa có Storybook build sẽ in cảnh báo và bỏ qua bước sao chép. Bước kiểm tra deploy cũng tải `/storybook/index.json`.
