---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:54:44.994Z
contentHash: e77f7c67c470a420
codeVerified: 2026-11-15T16:54:44.994Z
codeVerifiedHash: e77f7c67c470a420
codeVerifiedClaims: 40
---

# Extension Hot Reload (`lumibase-ext dev`)

`lumibase-ext dev` watches one extension's source folder, rebuilds it incrementally with esbuild and hot-swaps the result into a running Studio (UI slots) and a running CMS (hooks, endpoints, operations). You do not restart anything. The target is under 2 seconds from saving a file to seeing the change in Studio. The automated test measures the whole pipeline at about 30–40 ms on a fixture extension.

> **Local development only.** Hot reload runs on **Node/Docker only**. A Cloudflare Workers deployment never loads code from the dev hub. The CMS refuses to enable it in production; see [Security model](#security-model).

## How it works

```
 your editor ──save──▶ fs watcher ──▶ esbuild (incremental) ──▶ dev hub (127.0.0.1:4790)
                                                                  │  SSE: hello / reload / build-error
                                    ┌─────────────────────────────┴──────────────────────────┐
                                    ▼                                                        ▼
                    Studio (vite dev server)                                  CMS (Node, NODE_ENV=development)
          import(`/bundle/<name>?v=<version>`)                    fetch bundle → verify sha256 → import
          swap the component in place                             swap the module atomically in the registry
```

| Piece | Where |
|------|-------|
| CLI command | `packages/extension-cli/src/commands/dev.ts` |
| Dev hub (SSE + bundle server) | `packages/extension-cli/src/dev/hub.ts` |
| Incremental builder | `packages/extension-cli/src/dev/builder.ts` |
| Watch → build → notify loop | `packages/extension-cli/src/dev/pipeline.ts` |
| Wire protocol (shared) | `packages/contracts/src/extensions/dev-reload.ts` |
| Studio client | `apps/studio/src/lib/extension-dev-client.ts` |
| Studio hot swap | `hotSwapExtension` in `apps/studio/src/lib/extension-loader.tsx` |
| CMS guard | `apps/cms/src/extensions/dev-reload/config.ts` |
| CMS client | `apps/cms/src/extensions/dev-reload/client.ts` |
| CMS override registry | `apps/cms/src/extensions/dev-reload/registry.ts` |

- **Only successful builds are published.** A build that does not compile is broadcast as `build-error`. Studio and the CMS keep running the previous version and log the error.
- **Each build gets a new `version`.** It is a per-session counter and also the cache-busting key of the bundle URL (`?v=<version>`). Clients ignore a version older than the one they run, so a late event never rolls back.

## Usage

The extension folder needs a valid `lumibase-extension.json` (`name`, `version`, `type`, `entry`).

```bash
npx tsx packages/extension-cli/src/cli.ts dev --dir ./my-extension
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--dir` | current directory | Extension folder (with `lumibase-extension.json`) |
| `--port` | `4790` | Hub port (`0` = any free port) |
| `--host` | `127.0.0.1` | Hub interface. Must be loopback; anything else is refused |
| `--site` | all sites | Apply a server-side extension to one site only |
| `--studio` | `http://localhost:2026` | Studio URL used to print the connect link |
| `--token` | random | Pin the session token (≥ 32 chars). `LUMIBASE_EXTENSION_DEV_TOKEN` also works |
| `--token-file` / `--no-token-file` | `<tmpdir>/lumibase-ext-dev/<port>.token` | Where the token is written for the CMS (mode 0600, removed on exit) |

The command prints the hub URL, the **per-session token**, and the next step for your extension type.

### UI extensions (`interface`, `display`, `layout`, `panel`, `module`)

1. Run Studio's dev server: `pnpm studio:dev`.
2. Open the link that `lumibase-ext dev` prints: `http://localhost:2026/#lumibase-ext-dev=…`. The hub URL and token travel in the URL **fragment**, which the browser never sends to a server. Studio moves them to `sessionStorage` and removes them from the address bar.
3. Edit and save. Studio imports `<hub>/bundle/<name>?v=<version>` and swaps the component in place.

What survives a swap: the page, the router, the query cache and **host state** such as the form values an interface edits through `value`/`onChange`. Only the extension's own subtree remounts, so state *inside* the extension component resets. If an earlier version crashed during render, the next good build clears the error.

UI bundles use **Studio's React**. The builder resolves `react`, `react/jsx-runtime` and `react-dom` to shims that read `globalThis.__lumibaseShared`, which the Studio dev client sets. Two copies of React would break hooks.

### Server-side extensions (`hook`, `endpoint`, `operation`)

Start the CMS on the **Node** entry (not `wrangler dev`) with the dev flag:

```bash
NODE_ENV=development LUMIBASE_EXTENSION_DEV=1 npx tsx apps/cms/src/serve.ts
```

| Variable | Default | Meaning |
|------|---------|---------|
| `LUMIBASE_EXTENSION_DEV` | unset | `1`/`true` turns the client on; it is off otherwise |
| `LUMIBASE_EXTENSION_DEV_URL` | `http://127.0.0.1:4790` | Hub URL; must be loopback |
| `LUMIBASE_EXTENSION_DEV_TOKEN` | unset | Session token. When unset, the CMS reads the token file |
| `LUMIBASE_EXTENSION_DEV_TOKEN_FILE` | `<tmpdir>/lumibase-ext-dev/<port>.token` | Token file written by the CLI |

The CMS reconnects every second and re-reads the token file on each attempt, so you can start the CMS and the CLI in either order.

- **Atomic swap.** The registry is a single immutable map, replaced as a whole on each reload (copy-on-write). Each request's `ExtensionSandbox` pins the generation that was current when the request started. A request that began on version N runs **all** its hooks, before and after, on N. Requests that start after the swap get N+1.
- **Integrity.** The CMS fetches the bundle for the exact version in the event and checks its SHA-256 against the event before it imports anything. Every version is imported as its own module (a `data:` URL), so Node's module cache never serves stale code.
- **No install needed.** A `hook` extension under development runs even before you install it. If an extension with the same name *is* installed, the dev build replaces its bundle for the session.

## Security model

The dev path imports code pushed from outside the CMS process. That is remote code execution by design, so it is fenced on every axis and fails closed:

1. **Explicit opt-in.** `LUMIBASE_EXTENSION_DEV=1` is required.
2. **Never production.**
   - The client is refused when `NODE_ENV` or `LUMIBASE_ENV` is `production`.
   - `NODE_ENV` must explicitly be `development` (or `test`).
   - `validateProductionConfig` fails a production start that sets the flag.
   - The registry itself throws if it is activated in production. While it is inactive, `ExtensionSandbox` never sees an override.
3. **Loopback only.**
   - The hub refuses to bind a non-loopback interface.
   - The hub rejects requests whose `Host` or `Origin` is not loopback, which defeats DNS rebinding.
   - The CMS and Studio refuse a non-loopback hub URL.
4. **Authenticated.**
   - Every hub request needs the per-session token: `Authorization: Bearer`, or `?token=` for `EventSource`/`import()`.
   - The token is 32 random bytes and is compared in constant time.
   - The token file is mode 0600 and is deleted when the session ends.
5. **Studio dev server only.** The client starts only under `import.meta.env.DEV`, so production builds drop it.
6. **Node/Docker only.** Only `apps/cms/src/serve.ts` starts the CMS client. The Workers entry never imports it.

A refused start logs `[extension-dev] hot reload REFUSED: <reason>` and the CMS keeps running without hot reload.

## Limits

- One extension per `lumibase-ext dev` process. Run one per extension, each on its own `--port`.
- Every reloaded version stays in Node's module map until the CMS restarts. This is fine for a dev session.
- `--site` narrows server-side extensions only. Studio UI slots are per browser session.

## Tests

| What | Test |
|------|------|
| Edit → reflected in (mock) Studio, asserted < 1000 ms against the 2 s budget | `packages/extension-cli/src/dev/__tests__/pipeline.latency.test.ts` |
| Hub auth, loopback/DNS-rebinding refusal, versioned bundles | `packages/extension-cli/src/dev/__tests__/hub.test.ts` |
| Production refusal, hook swap atomicity, CMS client integrity | `apps/cms/src/extensions/dev-reload/__tests__/dev-reload.test.ts` |
| Studio swap that keeps host state, fragment session, dev-only guard | `apps/studio/src/lib/__tests__/extension-dev-client.test.tsx` |
