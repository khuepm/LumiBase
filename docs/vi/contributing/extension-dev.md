---
version: 1
lastUpdated: 2026-07-08T20:22:56.148Z
sourceLang: en
translatedFrom: en
sourceHash: 62e0afccda04ab1b
mtEngine: claude
syncStatus: machine-translated
---

# Extension Development Guide

LumiBase extension cho phép bạn thêm các custom field interface, display, layout, operation type và API route mà không cần chỉnh sửa core codebase.

## Extension types

| Type | Mô tả | Ví dụ |
|------|-------------|---------|
| `interface` | UI nhập field tùy biến trong Studio | Color picker, rich text, map |
| `display` | Cách một field value được render trong list/detail view | Preview thumbnail, status badge |
| `layout` | Các layout list view thay thế | Kanban board, calendar, map view |
| `operation` | Custom Flows operation type | Send SMS, create Stripe invoice |
| `hook` | Server-side lifecycle hooks | Validate on create, sync to CRM |
| `endpoint` | Các custom API route được mount dưới `/ext/:extensionId/` | Proxy tới external service |

## Setup

```bash
npm create @lumibase/extension my-extension
cd my-extension
npm install
```

Lệnh này scaffold một project với:

```
my-extension/
  src/
    index.ts          # Extension manifest + registration
    interface.tsx     # UI component (if interface/display/layout)
    operation.ts      # Operation handler (if operation type)
    hook.ts           # Hook handler (if hook)
    endpoint.ts       # Route handler (if endpoint)
  package.json
  tsconfig.json
  vite.config.ts      # Builds to dist/index.js (ESM)
```

## Extension manifest

```typescript
// src/index.ts
import type { ExtensionManifest } from '@lumibase/extension-sdk'

export const manifest: ExtensionManifest = {
  id: 'my-company/color-picker',    // Must be unique in Marketplace
  name: 'Color Picker',
  version: '1.0.0',
  type: 'interface',                 // Extension type
  icon: 'palette',                   // Material icon name
  description: 'A color picker field interface',
  author: {
    name: 'My Company',
    email: 'dev@mycompany.com',
  },
  requiredCapabilities: [],          // Capabilities this extension needs
  compatibleWith: '^1.0.0',          // LumiBase version range
}
```

## Interface extension

```typescript
// src/interface.tsx
import type { InterfaceProps } from '@lumibase/extension-sdk'

export default function ColorPickerInterface({
  value,
  onChange,
  disabled,
  field,
}: InterfaceProps<string>) {
  return (
    <input
      type="color"
      value={value ?? '#000000'}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{ width: '100%', height: '40px' }}
    />
  )
}
```

### Định nghĩa interface

```typescript
// src/index.ts
import { defineInterface } from '@lumibase/extension-sdk'
import ColorPickerInterface from './interface'

export default defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  component: ColorPickerInterface,
  types: ['string'],   // Compatible field types
  group: 'standard',
  options: [],         // Interface config options shown in Studio
})
```

## Operation extension

```typescript
// src/operation.ts
import type { OperationHandler } from '@lumibase/extension-sdk'

export const handler: OperationHandler = async (options, context) => {
  const { to, message } = options as { to: string; message: string }
  const { runtime, siteId } = context

  // Use runtime abstraction for external calls (HTTP)
  const response = await fetch(`https://api.sms-provider.com/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SMS_API_KEY}` },
    body: JSON.stringify({ to, message }),
  })

  if (!response.ok) throw new Error(`SMS failed: ${response.statusText}`)

  return { messageId: (await response.json()).id }
}
```

### Đăng ký operation

```typescript
// src/index.ts
import { registerOperation } from '@lumibase/extension-sdk'
import { handler } from './operation'

registerOperation({
  id: 'send-sms',
  name: 'Send SMS',
  icon: 'sms',
  handler,
  options: [
    { field: 'to', name: 'Phone number', interface: 'input', required: true },
    { field: 'message', name: 'Message', interface: 'textarea', required: true },
  ],
})
```

## Hook extension

```typescript
// src/hook.ts
import type { HookHandler } from '@lumibase/extension-sdk'

export const onArticleCreate: HookHandler = async (event, context) => {
  const { item } = event
  const { runtime } = context

  // Validate: title must be at least 5 words
  const wordCount = item.title?.split(' ').length ?? 0
  if (wordCount < 5) {
    throw new Error('Article title must be at least 5 words.')
  }
}
```

### Đăng ký hook

```typescript
registerHook('item.create:articles', onArticleCreate)
```

Các hook event khả dụng: `item.create:*`, `item.update:*`, `item.delete:*`, `auth.login`, `schema.change`.

## Security model

Extension chạy trong một **isolated module sandbox**:
- Extension không thể import từ các internal module của `@lumibase/cms`
- Network request đi qua một capability-gated fetch proxy
- Extension khai báo `requiredCapabilities` trong manifest của nó — được cấp bởi admin
- Không có quyền truy cập file system

Các capability khả dụng:
- `items:read` — đọc item từ CMS
- `items:write` — tạo/cập nhật/xóa item
- `files:read` — đọc file metadata
- `files:write` — upload/xóa file
- `schema:read` — đọc collection/field schema
- `settings:read` — đọc site settings
- `http:external` — thực hiện HTTP request tới external service

## Building và publishing

```bash
# Build the extension bundle
npm run build
# Output: dist/index.js (ESM, signed with your private key)

# Sign the bundle (required for Marketplace)
npm run sign -- --key ./signing-key.pem

# Test locally
lumibase extension install ./dist/index.js --local

# Publish to Marketplace
lumibase extension publish --token $MARKETPLACE_TOKEN
```

## Local development trong Studio

```bash
# Install your local extension in Studio dev mode
pnpm -F @lumibase/studio dev

# In another terminal
lumibase extension install ./my-extension/dist/index.js --local --watch
```

Hot reload của Studio tự động nhận các thay đổi extension trong dev mode.

## Gửi email từ một extension

Extension **không** giao tiếp trực tiếp với SMTP hay một email API. LumiBase phát hành một
**EmailService** dùng chung, sở hữu transport (SMTP / MailChannels) và một
kho template + layout. Extension chỉ quyết định *ai* để gửi mail và *dùng
template nào*, rồi gọi core endpoint:

```ts
await ctx.fetch(`${baseUrl}/api/v1/email/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-site-id': siteId },
  body: JSON.stringify({ to: ['x@y.z'], templateKey: 'teammate_invite', variables: { name: 'Sam' } }),
});
```

Chỉ khai báo `http:fetch` (để gọi tới endpoint) và `env:read` (cho base
URL + token) trong manifest của bạn. Author template trong Studio → Settings → Email,
hoặc cấu hình transport hoàn toàn bằng env. Tham khảo đầy đủ:
[`features/email-service.md`](../features/email-service.md). Ví dụ thực tế:
[`examples/extension-email-setup`](../../../examples/extension-email-setup/README.md).

## Resources

- `packages/extension-sdk/src/types.ts` — đầy đủ TypeScript type cho mọi extension API
- `packages/extension-sdk/src/helpers.ts` — các utility helper (`registerInterface`, `registerOperation`, v.v.)
- Extension mẫu: `apps/studio/src/interfaces/` (các built-in interface làm tham chiếu)
