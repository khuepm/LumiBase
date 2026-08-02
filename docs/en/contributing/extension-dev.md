---
version: 2
lastUpdated: 2026-07-25T08:11:35.552Z
sourceLang: en
contentHash: 42e2b8eba52703f7
codeVerified: 2026-07-25T08:11:35.552Z
codeVerifiedHash: 42e2b8eba52703f7
codeVerifiedClaims: 2
---

# Extension Development Guide

LumiBase extensions allow you to add custom field interfaces, displays, layouts, operation types, and API routes without modifying the core codebase.

## Extension types

| Type | Description | Example |
|------|-------------|---------|
| `interface` | Custom field input UI in the Studio | Color picker, rich text, map |
| `display` | How a field value is rendered in list/detail views | Preview thumbnail, status badge |
| `layout` | Alternative list view layouts | Kanban board, calendar, map view |
| `operation` | Custom Flows operation type | Send SMS, create Stripe invoice |
| `hook` | Server-side lifecycle hooks | Validate on create, sync to CRM |
| `endpoint` | Custom API routes mounted under `/ext/:extensionId/` | Proxy to external service |

## Setup

```bash
npm create @lumibase/extension my-extension
cd my-extension
npm install
```

This scaffolds a project with:

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

### Define the interface

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

### Register the operation

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

### Register the hook

```typescript
registerHook('item.create:articles', onArticleCreate)
```

Available hook events: `item.create:*`, `item.update:*`, `item.delete:*`, `auth.login`, `schema.change`.

## Security model

Extensions run in an **isolated module sandbox**:
- Extensions cannot import from `@lumibase/cms` internal modules
- Network requests go through a capability-gated fetch proxy
- Extensions declare `requiredCapabilities` in their manifest — granted by an admin
- File system access is not available

Available capabilities:
- `items:read` — read items from the CMS
- `items:write` — create/update/delete items
- `files:read` — read file metadata
- `files:write` — upload/delete files
- `schema:read` — read collection/field schema
- `settings:read` — read site settings
- `http:external` — make HTTP requests to external services

## Building and publishing

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

## Local development in Studio

```bash
# Install your local extension in Studio dev mode
pnpm -F @lumibase/studio dev

# In another terminal
lumibase extension install ./my-extension/dist/index.js --local --watch
```

The Studio's hot reload picks up extension changes automatically in dev mode.

## Sending email from an extension

Extensions do **not** talk to SMTP or an email API directly. LumiBase ships a
shared **EmailService** that owns the transport (SMTP / MailChannels) and a
template + layout store. An extension only decides *who* to mail and *which
template* to use, then calls the core endpoint:

```ts
await ctx.fetch(`${baseUrl}/api/v1/email/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-site-id': siteId },
  body: JSON.stringify({ to: ['x@y.z'], templateKey: 'teammate_invite', variables: { name: 'Sam' } }),
});
```

Declare only `http:fetch` (to reach the endpoint) and `env:read` (for the base
URL + token) in your manifest. Author templates in Studio → Settings → Email,
or configure the transport purely by env. Full reference:
[`features/email-service.md`](../features/email-service.md). Working example:
[`examples/extension-email-setup`](../../../examples/extension-email-setup/README.md).

## Resources

- `packages/extension-sdk/src/index.ts` — the whole SDK surface: TypeScript types for
  every extension API (`ExtensionManifest`, `HookDefinition`, `InterfaceDefinition`, …)
  plus the `define*` helpers (`defineHook`, `defineInterface`, …)
- Example extensions: `apps/studio/src/interfaces/` (built-in interfaces as reference)
