# `@lumibase/extension-sdk`

Types and helpers for building [LumiBase](https://lumibase.dev) extensions — hooks, endpoints, UI interfaces, and change-feed subscribers.

```bash
npm install @lumibase/extension-sdk
# or
pnpm add @lumibase/extension-sdk
```

## Quick start

```ts
import { defineHook, defineInterface, defineCdcSubscriber } from '@lumibase/extension-sdk'

export const onItemCreate = defineHook({
  on: 'items.create',
  async handler({ payload, ctx }) {
    ctx.logger.info('item created', { id: payload.id })
  },
})

export const colorPicker = defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  types: ['string'],
  group: 'selection',
  component: (props) => {
    // return your UI element; Studio mounts this in the field editor
    return props.value
  },
})

export const onPostsChange = defineCdcSubscriber({
  collections: ['posts'],
  operations: ['create', 'update'],
  payloadMode: 'reference',
  async handler({ events, ctx }) {
    for (const event of events) {
      ctx.logger.info('cdc event', { id: event.id, itemId: event.itemId })
    }
  },
})
```

## Extension types

| Type | Purpose |
| --- | --- |
| `hook` | Sync lifecycle handlers (`items.create`, …) |
| `endpoint` | Custom HTTP routes inside the CMS |
| `operation` | Flow/automation operations |
| `interface` / `display` / `layout` / `panel` / `module` | Studio UI surfaces |
| CDC subscriber | Async change-feed consumer (at-least-once, idempotent on `event.id`) |

Declare capabilities in your extension manifest (e.g. `items:read:posts`, `cdc:subscribe:posts`, `http:fetch:api.example.com`). The host enforces the sandbox — your code only sees what it declared.

## Docs

- [Extensions system](https://docs.lumibase.dev/en/features/extensions-system) (see repo `docs/features/extensions-system.md`)
- Example: `examples/extension-color-picker` in the monorepo

## Related packages

| Package | Role |
| --- | --- |
| [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | Typed REST / realtime client |
| [`@lumibase/contracts`](https://www.npmjs.com/package/@lumibase/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@lumibase/mcp-server`](https://www.npmjs.com/package/@lumibase/mcp-server) | Stdio MCP server for AI assistants |

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
