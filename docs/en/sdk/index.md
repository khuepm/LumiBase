---
title: SDK Reference
version: 2
lastUpdated: 2026-09-21T05:45:14.986Z
sourceLang: en
contentHash: 8a51c4697f0696d0
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

Either way it belongs in `dependencies`, not `devDependencies` — your app
imports it at request time. `lumibase` *depends on* `@lumibase/sdk` rather than
bundling it, so a project importing both still gets one copy of every class
(`LumiError` `instanceof` checks keep working) and one set of types. Not sure
which path you are on? See
[Which one do you actually want?](../getting-started.md#which-one-do-you-actually-want)
in Getting Started.

## Guides

- [JavaScript SDK](./javascript.md) — full client API reference with examples
- [TypeGen](./typegen.md) — generate TypeScript types from your live schema
