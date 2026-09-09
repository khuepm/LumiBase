---
version: 2
lastUpdated: 2026-09-09T02:49:02.007Z
sourceLang: en
contentHash: 9ad56a846efd4625
---

# SDK Reference

> **For AI agents:** See `docs/en/llms.txt` for the full docs index.

LumiBase provides an official JavaScript/TypeScript SDK to interact with the API without writing raw HTTP requests.

## Packages

| Package | Install as | Description |
|---------|-----------|-------------|
| `lumibase` | `dependencies` | **Start here.** The same client re-exported, plus the `lumibase` CLI (`types`, `doctor`, `init`) — one name for both. |
| `@lumibase/sdk` | `dependencies` | The underlying JS/TS client SDK — items, auth, files, realtime, AI Copilot. Use it directly when you want the client without the CLI. |

```bash
npm install lumibase
```

```ts
// identical to @lumibase/sdk
import { createLumiClient } from 'lumibase';
```

`lumibase` *depends on* `@lumibase/sdk` rather than bundling it, so a project
importing both still gets one copy of every class (`LumiError` `instanceof`
checks keep working) and one set of types. Not sure which path you are on? See
the [decision tree in Getting Started](../getting-started.md#which-path-do-i-need).

## Guides

- [JavaScript SDK](./javascript.md) — full client API reference with examples
- [TypeGen](./typegen.md) — generate TypeScript types from your live schema
