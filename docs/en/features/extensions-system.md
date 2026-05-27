# Extension System

> Mục tiêu: cho phép cộng đồng viết extension như Directus nhưng **an toàn ở edge** nhờ capability sandbox.

## 1. Extension types

| Type | Mô tả | Chạy ở |
|---|---|---|
| `hook` | Trigger trước/sau item action, schema change, login | apps/cms (Worker) |
| `endpoint` | Mount thêm route Hono dưới `/extensions/:name` | apps/cms |
| `operation` | Node cho flow engine (Phase 2) | apps/cms |
| `interface` | Field editor React | apps/studio |
| `display` | Field display React | apps/studio |
| `layout` | List layout (cards, kanban, …) | apps/studio |
| `panel` | Insight panel cho dashboard | apps/studio |
| `module` | Trang tuỳ biến trong Studio | apps/studio |

## 2. Manifest

`lumibase-extension.json`:
```json
{
  "name": "wordcount",
  "version": "1.0.0",
  "type": "hook",
  "entry": "./dist/index.mjs",
  "capabilities": [
    "items:read:posts",
    "items:update:posts",
    "log:write"
  ],
  "config": [
    { "key": "minWords", "type": "integer", "default": 100 }
  ]
}
```

### Capabilities (chuỗi hình `<resource>:<action>:<target?>`)
- `items:read:<collection>`, `items:update:<collection>`, `items:create:<collection>`.
- `files:read`, `files:write`.
- `http:fetch:<host>` (whitelist).
- `secrets:read:<key>`.
- `log:write`, `metrics:emit`.
- `ws:emit`, `ws:listen`.
- `schema:read`, `schema:write`.

Extension chỉ được dùng API ứng với capability đã khai báo; gọi ngoài phạm vi → throw `CapabilityDenied`.

## 3. Sandbox runtime (Workers)

- Bundle ESM upload lên R2, import động qua `await import(bundleUrl)`.
- Wrap context truyền vào extension là **proxy** chỉ expose API hợp lệ với capabilities.
- `fetch` toàn cục bị thay bằng `ctx.fetch` chỉ allow host whitelist.
- Timeout: 5s per hook; memory cap qua Workers limit.
- Versioning: cài nhiều version, switch active.

## 4. Hook events

- `items.<collection>.<action>.<before|after>` (action ∈ create/update/delete/read).
- `schema.collections.created|updated|deleted`.
- `auth.login`, `auth.logout`.
- `realtime.connection.opened|closed`.

Handler:
```ts
export default defineHook({
  on: 'items.posts.update.before',
  async handler({ payload, item, ctx }) {
    if (payload.body?.length < ctx.config.minWords) {
      throw new ctx.errors.ValidationError('Body too short');
    }
  }
});
```

## 5. UI extension API

```ts
defineInterface({
  id: 'color-picker',
  types: ['string'],
  optionsSchema: z.object({ presets: z.array(z.string()).optional() }),
  Component: ColorPickerComponent
});
```

- Studio load extension JS từ endpoint `/extensions/ui/manifest` → dynamic import (vite preserves esm).
- Permission sandbox UI: extension không truy cập `localStorage` thô; phải qua `ctx.storage` (scoped key).

## 6. Lifecycle

1. Developer build → produce `dist/` + manifest.
2. Upload qua Studio (`/settings/extensions/upload`) — server validate manifest, scan capabilities, lưu vào R2 + bảng `extensions`.
3. Site admin **review + grant** capabilities trước khi enable.
4. Enable → load vào registry; broadcast `extensions.changed` để các Worker instance reload.

## 7. Signing (Phase 2)

- Marketplace ký bundle bằng key; verify SHA + signature trước khi load production.

## 8. Tutorial: Build Your First Extension (Word Count Validator)

Trong hướng dẫn này, chúng ta sẽ xây dựng một extension thuộc loại `hook` tên là **Word Count Validator**. Hook này sẽ tự động chặn không cho lưu bài viết thuộc collection `posts` nếu nội dung quá ngắn (ít hơn số từ được cấu hình).

### Step 1: Chuẩn bị cấu trúc thư mục

Tạo một thư mục mới độc lập hoặc bên trong monorepo của bạn:

```bash
mkdir -p lumibase-extension-wordcount/src
cd lumibase-extension-wordcount
```

Khởi tạo dự án Node.js và cài đặt các dependencies cần thiết:

```bash
npm init -y
npm install -D typescript esbuild
npm install @lumibase/extension-sdk
```

### Step 2: Khai báo Manifest (`lumibase-extension.json`)

Tạo file `lumibase-extension.json` ở thư mục gốc của extension. File này định nghĩa các thuộc tính cơ bản của extension, các capabilities (quyền hạn) cần thiết, và các trường cấu hình tùy biến:

```json
{
  "name": "word-count-validator",
  "version": "1.0.0",
  "type": "hook",
  "entry": "./dist/index.js",
  "capabilities": [
    "items:read:posts",
    "items:update:posts"
  ],
  "config": [
    {
      "key": "minWords",
      "type": "integer",
      "default": 100
    }
  ]
}
```

*Giải thích:*
- `"type": "hook"`: Xác định đây là một Hook chạy ở backend (CMS Worker).
- `"capabilities"`: Extension yêu cầu quyền đọc và cập nhật đối với collection `posts`. Bất kỳ hành động nào vượt ngoài quyền này sẽ bị sandbox chặn (`CapabilityDenied`).
- `"config"`: Cấu hình cho phép admin thay đổi ngưỡng số từ tối thiểu (`minWords`) trực tiếp từ giao diện Lumibase Studio mà không cần sửa code.

### Step 3: Viết mã nguồn Extension (`src/index.ts`)

Tạo file `src/index.ts` và sử dụng hàm `defineHook` từ SDK để viết logic kiểm tra độ dài bài viết:

```typescript
import { defineHook } from '@lumibase/extension-sdk';

export default defineHook({
  on: 'items.posts.update.before',
  async handler({ payload, ctx }) {
    // 1. Lấy thông tin cấu hình từ context (được truyền an toàn vào sandbox)
    const minWords = (ctx.config.minWords as number) || 100;

    // 2. Kiểm tra xem payload cập nhật có chứa nội dung bài viết không
    if (payload && typeof payload === 'object' && 'body' in payload) {
      const bodyText = String(payload.body || '').trim();
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

      // 3. Sử dụng Logger an toàn tích hợp sẵn trong Sandbox
      ctx.logger.info(`Word Count Validator: Checking post. Word count: ${wordCount}, Minimum required: ${minWords}`);

      // 4. Nếu không đủ từ, ném lỗi ValidationError có sẵn trong context
      if (wordCount < minWords) {
        throw new ctx.errors.ValidationError(
          `Bài viết quá ngắn! Nội dung hiện tại chỉ có ${wordCount} từ, yêu cầu tối thiểu ${minWords} từ.`
        );
      }
    }
  }
});
```

### Step 4: Cấu hình Build với esbuild

Chúng ta cần đóng gói (bundle) mã nguồn thành một file Javascript tự chứa duy nhất chạy được trong môi trường V8 sandbox ở Edge.

Tạo file `build.js` ở thư mục gốc dự án:

```javascript
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser', // Chạy trong Cloudflare Worker / Edge environment
  target: 'es2022',
  minify: false,
}).catch(() => process.exit(1));
```

Thêm script build vào `package.json`:

```json
"scripts": {
  "build": "node build.js"
}
```

Tiến hành build dự án:

```bash
npm run build
```

Sau khi build thành công, file đóng gói cuối cùng sẽ nằm tại `dist/index.js`.

### Step 5: Upload và cài đặt trên Lumibase Studio

1. Truy cập vào **Lumibase Studio** của bạn.
2. Vào phần **Settings** -> **Extensions**.
3. Tại giao diện upload, bạn nhập đường dẫn bundle URL (ví dụ trỏ đến file `dist/index.js` đã upload lên host thử nghiệm của bạn) hoặc tải trực tiếp file lên hệ thống.
4. Hệ thống sẽ tự động quét file cấu hình `lumibase-extension.json` để lấy danh sách capabilities (`items:read:posts`, `items:update:posts`).
5. Trang quản trị sẽ hiển thị danh sách quyền yêu cầu này. Nhấp chọn **Review and Grant Capabilities** để phê duyệt quyền hoạt động của extension.
6. Gạt công tắc chuyển đổi trạng thái của extension sang **Enabled**.

### Step 6: Kiểm thử hoạt động

1. Quay lại trang **Content** và chọn collection `posts`.
2. Tạo mới hoặc chỉnh sửa một bài viết hiện có.
3. Nhập nội dung bài viết cực ngắn (ví dụ dưới 100 từ) và bấm **Save**.
4. Bạn sẽ nhận được thông báo lỗi từ sandbox: `"Bài viết quá ngắn! Nội dung hiện tại chỉ có ... từ, yêu cầu tối thiểu 100 từ."` chặn đứng hành động lưu bài viết lỗi.
5. Để điều chỉnh ngưỡng từ tối thiểu, quay lại **Settings** -> **Extensions**, mở phần cấu hình của extension **Word Count Validator**, đổi `minWords` thành `50` hoặc bất cứ con số nào bạn mong muốn rồi bấm lưu.

