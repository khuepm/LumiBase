# @lumibase/shell

Unified **Tauri 2** desktop + mobile shell for **LumiBase Studio**.

The shell is a thin native wrapper: it does not reimplement any UI. Desktop builds
add signed auto-update; mobile builds are distributed through the app stores.

## Frontend delivery — hybrid

The Studio SPA reaches the app in a **hybrid** model (`src/lib.rs`):

1. The compiled `apps/studio/dist` assets are **bundled** into the app and load
   first — instantly, and fully offline-capable. This is also what `tauri dev`
   uses (via the Vite dev server on port 2026).
2. On desktop **release** builds, once the window is up the shell probes the
   configured remote Studio deployment. If it answers within 3s, the webview
   navigates there, so the always-current hosted UI is used when online — a web
   deploy reaches users without any app update. If it is unreachable, the app
   quietly stays on the bundled assets.

The remote deployment defaults to production (`https://studio.lumibase.dev`) and
is overridable at build time:

```bash
# Target a non-prod environment or a self-hosted Studio:
export LUMIBASE_STUDIO_URL="https://staging.lumibase.dev"

# Force pure-bundled (never navigate away from embedded assets):
export LUMIBASE_STUDIO_URL=""
```

> The remote upgrade is skipped in dev builds, so `pnpm dev` always uses the
> local Vite server.

The API base URL the SPA talks to is a separate concern (see the Studio
`VITE_API_URL` handling), tracked independently from asset delivery.

```
apps/shell/
  package.json            # @lumibase/shell — tauri dev/build scripts
  tsconfig.json
  src-tauri/
    Cargo.toml            # Rust crate `lumibase-shell` (lib `lumibase_shell_lib`)
    build.rs
    tauri.conf.json       # dev/build wiring + updater endpoint & pubkey
    capabilities/
      default.json        # core + process + dialog + updater permissions
    icons/                # generated from icons/app-icon.svg via `tauri icon`
    src/
      main.rs             # desktop binary entry
      lib.rs              # shared entry: plugins + background update check
```

## Prerequisites

- Node ≥ 20 and `pnpm` (repo uses `pnpm@9`).
- Rust (stable) + the [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS. On Linux desktop that includes `webkit2gtk-4.1`, `libgtk-3`, and
  `libayatana-appindicator3`.
- Mobile: Android SDK/NDK for Android; Xcode for iOS.

## Develop

```bash
# From the repo root — starts the Studio dev server (port 2026) then the webview.
pnpm -F @lumibase/shell dev
```

`beforeDevCommand` launches `@lumibase/studio dev`, and the webview loads
`http://localhost:2026`. API calls are proxied by Studio's Vite config to a local
CMS (`http://127.0.0.1:1989`), so run the CMS separately for full functionality:

```bash
pnpm cms:dev
```

## Build (desktop)

```bash
pnpm -F @lumibase/shell build
```

`beforeBuildCommand` builds `@lumibase/studio`; the resulting `apps/studio/dist` is
embedded and bundled into platform installers (`bundle.targets: "all"`).

## Build (mobile)

```bash
pnpm -F @lumibase/shell android:init   # one-time, generates src-tauri/gen/android
pnpm -F @lumibase/shell android:dev

pnpm -F @lumibase/shell ios:init       # one-time, generates src-tauri/gen/apple
pnpm -F @lumibase/shell ios:dev
```

The generated `src-tauri/gen/` projects are not committed (see `.gitignore`).

## Icons

All platform icons are generated from a single source:

```bash
pnpm -F @lumibase/shell exec tauri icon src-tauri/icons/app-icon.png
```

Edit `src-tauri/icons/app-icon.svg`, re-render to `app-icon.png` (1024×1024), then
re-run the command above to regenerate every size/format.

## Releasing

Pushing a `v*.*.*` tag runs `.github/workflows/release-apps.yml`, which builds
the shell on macOS/Linux/Windows runners (plus Android, and iOS when Apple
secrets are present) and uploads the signed bundles and `latest.json` to the
GitHub Release. Required/optional secrets are documented at the top of that
workflow. The desktop `.deb`/`.rpm`/`.AppImage`/`.msi`/`.dmg` build was verified
locally end-to-end (`.deb` + `.rpm` produced from a signed release build).

## Server connection

Because the bundled app is served from `tauri://localhost` with no co-located
backend, on first run inside the shell Studio shows a **Connect to LumiBase**
screen (`apps/studio/src/components/server-connection.tsx`). The entered origin
is validated against the CMS `/health` endpoint and persisted as a runtime
API-base override (`lib/api-base.ts`). Self-hosted CMS servers must allow the
shell origin (`tauri://localhost`, `https://tauri.localhost` on Windows) via
`CORS_ALLOWED_ORIGINS`. In remote (hosted) mode this is same-origin and no CORS
is involved.

## Deep links

The `lumibase://` scheme (desktop) and `studio.lumibase.dev` universal links
(mobile) are registered via `tauri-plugin-deep-link`. Opened URLs are forwarded
to the SPA as a `shell://deep-link` event (`src/lib.rs`) for auth callbacks.
`tauri-plugin-single-instance` ensures a deep-link launch focuses the running
window instead of opening a duplicate.

## Auto-update (desktop)

Desktop builds check for updates in the background on launch (`src/lib.rs`) via
`tauri-plugin-updater`, then prompt "Update ready — restart now?" and relaunch on
confirmation. Updates are verified against the minisign public key in
`tauri.conf.json → plugins.updater.pubkey`.

The release pipeline must:

1. Build with `createUpdaterArtifacts: true` (already set) to emit `*.sig` files.
2. Sign artifacts with the **private** key. Provide it to the build via env vars —
   **never commit the private key**:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="<contents of the .key file>"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password, empty if none>"
   ```

   In CI these are GitHub Actions secrets.
3. Publish a `latest.json` manifest plus the signed bundles to the GitHub Releases
   `latest` tag, matching `plugins.updater.endpoints`.

To rotate keys, regenerate and replace the committed `pubkey`:

```bash
pnpm -F @lumibase/shell exec tauri signer generate -w lumibase-shell-updater.key
```

## Secure token storage

In the desktop shell the Studio session tokens are kept in the **OS keychain**
(macOS Keychain, Windows Credential Manager, Linux Secret Service) via the
`secure_get` / `secure_set` / `secure_delete` commands (`src/lib.rs`,
`keyring` crate) rather than plaintext webview `localStorage`. The frontend
side (`apps/studio/src/lib/token-store.ts`) keeps the public token accessors
synchronous by caching in memory and hydrating from the keychain once at
startup; it migrates any pre-existing localStorage tokens into the keychain on
first run.

If the keychain is unavailable (a Linux box with no Secret Service daemon, or
mobile — where the commands are not registered) it transparently falls back to
`localStorage`, which on iOS/Android is already app-sandboxed. In the browser,
behavior is unchanged (localStorage).

## Contracts future work must not break

The shell is a thin wrapper, so it depends on a handful of Studio/CMS contracts.
A change elsewhere in the monorepo can silently break the desktop/mobile app
without breaking the browser build. **Before changing any of these, keep the
shell working** (see the "Shell impact" step in
`.kiro/steering/definition-of-done.md`).

| # | Contract | Where | Break it and… |
|---|----------|-------|---------------|
| C1 | Session tokens go through `token-store.ts` / the `api.ts` accessors — **never** `localStorage.setItem('lumibase.dev.token', …)` directly. | `apps/studio/src/lib/token-store.ts`, `api.ts` | tokens bypass the OS keychain in the shell and are lost on next launch / left in plaintext. |
| C2 | The CMS origin is always resolved via `getApiBaseUrl()` — never hardcode `/api` same-origin or read `import.meta.env.VITE_API_URL` directly. | `apps/studio/src/lib/api-base.ts` | the shell's runtime server override + cross-origin bundled mode stop working. |
| C3 | Studio builds to `apps/studio/dist` with a root Vite `base`. | `apps/studio/vite.config.ts` ↔ `frontendDist` in `tauri.conf.json` | bundling fails, or assets 404 under `tauri://localhost`. |
| C4 | Studio dev server runs on port **2026**. | `apps/studio/vite.config.ts` ↔ `beforeDevCommand`/`devUrl` in `tauri.conf.json` | `pnpm -F @lumibase/shell dev` loads a blank window. |
| C5 | New browser APIs must degrade gracefully — the shell runs WKWebView (macOS/iOS), WebView2 (Windows), WebKitGTK (Linux). | Studio features | a feature works in Chrome but throws in the shell. |
| C6 | Cross-origin auth: in bundled mode the SPA calls the CMS from `tauri://localhost`. Auth flows must work with the token-in-body path (not only same-origin cookies), and new SPA-called endpoints must be CORS-reachable (`CORS_ALLOWED_ORIGINS`). | CMS auth/CORS, `@lumibase/sdk` refresh | login/refresh fails only in the bundled shell. |
| C7 | The server-connection probe hits `GET {origin}/health` (public, no auth). | `apps/studio/src/components/server-connection.tsx` ↔ CMS `/health` | the "Connect to LumiBase" screen can never validate a server. |
| C8 | Deep links arrive as the `shell://deep-link` event; auth callbacks should consume it rather than assume a browser redirect. | `src/lib.rs` | OAuth/magic-link callbacks silently drop on desktop/mobile. |
| C9 | Release bumps `apps/shell/package.json` **and** `src-tauri/Cargo.toml` + `tauri.conf.json` together (package.json is in `sync-version.mjs`; the Rust/Tauri versions are not — bump them by hand). | `/release` flow | updater version math / store version is wrong. |

## Roadmap / not yet implemented

- **iOS/Android store submission** (Fastlane lanes, provisioning) beyond the CI
  build jobs.
- **Mobile keystore/Keychain** for tokens (currently sandboxed webview storage
  on mobile; desktop uses the OS keychain as above).
