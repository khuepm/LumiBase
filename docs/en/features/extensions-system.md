---
version: 3
lastUpdated: 2026-08-02T19:24:22.964Z
sourceLang: vi
translatedFrom: vi
sourceHash: ffe9ae1d87df7293
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:22:34.688Z
codeVerifiedHash: ea702bc10561b02e
codeVerifiedClaims: 2
---

# Extension System

> Goal: let the community write extensions like Directus but **safe at the edge** thanks to a capability sandbox.

## 1. Extension types

| Type | Description | Runs in |
|---|---|---|
| `hook` | Triggers before/after an item action, schema change, login | apps/cms (Worker) |
| `endpoint` | Mounts an extra Hono route under `/extensions/:name` | apps/cms |
| `operation` | A node for the flow engine (Phase 2) | apps/cms |
| `interface` | A React field editor | apps/studio |
| `display` | A React field display | apps/studio |
| `layout` | A list layout (cards, kanban, …) | apps/studio |
| `panel` | An insight panel for the dashboard | apps/studio |
| `module` | A custom page in Studio | apps/studio |

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

### Capabilities (strings of the form `<resource>:<action>:<target?>`)
- `items:read:<collection>`, `items:update:<collection>`, `items:create:<collection>`.
- `files:read`, `files:write`.
- `http:fetch:<host>` (whitelist).
- `secrets:read:<key>`.
- `log:write`, `metrics:emit`.
- `ws:emit`, `ws:listen`.
- `schema:read`, `schema:write`.

An extension may only use the APIs corresponding to its declared capabilities; calling outside that scope → throws `CapabilityDenied`.

## 3. Sandbox runtime (Workers)

- The ESM bundle is uploaded to R2, dynamically imported via `await import(bundleUrl)`.
- The context passed into the extension is a **proxy** that only exposes APIs valid for the capabilities.
- The global `fetch` is replaced by `ctx.fetch`, which only allows whitelisted hosts.
- Timeout: 5s per hook; memory capped by the Workers limit.
- Versioning: install multiple versions, switch the active one.

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

- Studio loads extension JS from the `/extensions/ui/manifest` endpoint → dynamic import (vite preserves esm).
- UI permission sandbox: an extension does not access raw `localStorage`; it must go through `ctx.storage` (scoped key).

## 6. Lifecycle

1. The developer builds → produces `dist/` + manifest.
2. Upload via Studio (`/settings/extensions/upload`) — the server validates the manifest, scans capabilities, and stores it in R2 + the `extensions` table.
3. The site admin **reviews + grants** capabilities before enabling.
4. Enable → load into the registry; broadcast `extensions.changed` so the Worker instances reload.

## 7. Signing (Phase 2)

- The Marketplace signs the bundle with a key; verify the SHA + signature before loading in production.

## 8. Tutorial: Build Your First Extension (Word Count Validator)

In this guide, we will build a `hook`-type extension called **Word Count Validator**. This hook automatically blocks saving a post in the `posts` collection if the content is too short (fewer than the configured number of words).

### Step 1: Prepare the folder structure

Create a new standalone folder or one inside your monorepo:

```bash
mkdir -p lumibase-extension-wordcount/src
cd lumibase-extension-wordcount
```

Initialize a Node.js project and install the required dependencies:

```bash
npm init -y
npm install -D typescript esbuild
npm install @lumibase/extension-sdk
```

### Step 2: Declare the Manifest (`lumibase-extension.json`)

Create a `lumibase-extension.json` file at the extension's root. This file defines the extension's basic properties, the required capabilities, and custom configuration fields:

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

*Explanation:*
- `"type": "hook"`: Specifies this is a Hook running on the backend (CMS Worker).
- `"capabilities"`: The extension requires read and update permissions on the `posts` collection. Any action beyond these is blocked by the sandbox (`CapabilityDenied`).
- `"config"`: Configuration that lets the admin change the minimum word threshold (`minWords`) directly from the LumiBase Studio UI without editing code.

### Step 3: Write the Extension source (`src/index.ts`)

Create `src/index.ts` and use the `defineHook` function from the SDK to write the post-length check logic:

```typescript
import { defineHook } from '@lumibase/extension-sdk';

export default defineHook({
  on: 'items.posts.update.before',
  async handler({ payload, ctx }) {
    // 1. Read the config from the context (safely passed into the sandbox)
    const minWords = (ctx.config.minWords as number) || 100;

    // 2. Check whether the update payload contains the post body
    if (payload && typeof payload === 'object' && 'body' in payload) {
      const bodyText = String(payload.body || '').trim();
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

      // 3. Use the safe Logger built into the Sandbox
      ctx.logger.info(`Word Count Validator: Checking post. Word count: ${wordCount}, Minimum required: ${minWords}`);

      // 4. If there aren't enough words, throw the ValidationError available in the context
      if (wordCount < minWords) {
        throw new ctx.errors.ValidationError(
          `Post too short! The current content has only ${wordCount} words, the minimum required is ${minWords} words.`
        );
      }
    }
  }
});
```

### Step 4: Configure the build with esbuild

We need to bundle the source into a single self-contained JavaScript file that can run in the V8 sandbox environment at the Edge.

Create a `build.js` file at the project root:

```javascript
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser', // Runs in the Cloudflare Worker / Edge environment
  target: 'es2022',
  minify: false,
}).catch(() => process.exit(1));
```

Add the build script to `package.json`:

```json
"scripts": {
  "build": "node build.js"
}
```

Build the project:

```bash
npm run build
```

After a successful build, the final bundled file will be at `dist/index.js`.

### Step 5: Upload and install in LumiBase Studio

1. Open your **LumiBase Studio**.
2. Go to **Settings** -> **Extensions**.
3. In the upload UI, enter the bundle URL (e.g. pointing to the `dist/index.js` file uploaded to your test host) or upload the file directly to the system.
4. The system automatically scans the `lumibase-extension.json` config file to read the list of capabilities (`items:read:posts`, `items:update:posts`).
5. The admin page displays this list of requested permissions. Click **Review and Grant Capabilities** to approve the extension's operating permissions.
6. Toggle the extension's status switch to **Enabled**.

### Step 6: Test it

1. Go back to the **Content** page and select the `posts` collection.
2. Create a new post or edit an existing one.
3. Enter very short content (e.g. under 100 words) and click **Save**.
4. You will receive an error from the sandbox: `"Post too short! The current content has only ... words, the minimum required is 100 words."`, blocking the invalid save.
5. To adjust the minimum word threshold, go back to **Settings** -> **Extensions**, open the configuration of the **Word Count Validator** extension, change `minWords` to `50` or any number you want, then save.


## 9. Future operations plugins (observability/runtime)

LumiBase currently treats process-level observability differently from regular tenant extensions:

- Item hooks, endpoint extensions, and UI extensions run through the tenant-scoped extension sandbox.
- Tracing providers such as Apache SkyWalking need Node process bootstrap before the CMS app is imported, so they are built-in Node/Docker providers in the first POC.

Before exposing observability as marketplace extensions, add an explicit operations-plugin model:

- Extend `ExtensionType` with `observability` or `runtime`.
- Add `runtimeTargets?: ['node' | 'cloudflare']` to the manifest so Node-only packages never enter the Workers bundle.
- Add capabilities such as `observability:trace`, `observability:metrics`, and secret references for provider tokens.
- Restrict process-level providers to built-in or signed/allowlisted bundles.
- Treat provider/endpoint changes as restart-required until a safe hot-reload design exists.

This keeps the current edge-safe extension sandbox intact while leaving a migration path from the built-in SkyWalking POC to a more general plugin architecture.
