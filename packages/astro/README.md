# `@lumibase/astro`

Astro 5–7 integration, Content Layer loader and client realtime helper for [LumiBase](https://lumibase.dev). A thin, typed layer over [`@lumibase/sdk`](../sdk).

```bash
pnpm add @lumibase/astro @lumibase/sdk
```

```js
// astro.config.mjs
import lumibase from '@lumibase/astro';
export default defineConfig({ integrations: [lumibase({ url, siteId })] });
```

```ts
// any .astro frontmatter: server-only, token read from LUMIBASE_TOKEN at runtime
import { lumi } from 'virtual:lumibase';

// src/content.config.ts
import { lumibaseLoader } from '@lumibase/astro/loader';
```

Full guide: [docs/en/sdk/frameworks.md](../../docs/en/sdk/frameworks.md).
