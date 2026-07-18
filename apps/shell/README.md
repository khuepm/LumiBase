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

## Roadmap / not yet implemented

- **OS-keychain token storage.** Studio currently persists the session token in
  the webview's `localStorage`, which the shell inherits. Moving it to the OS
  keychain/keystore (e.g. `tauri-plugin-stronghold`) is a deliberate follow-up:
  it touches the auth flow shared with the browser build and requires making the
  token accessors async, so it is intentionally out of scope for the initial
  build-enablement work rather than done shallowly.
- **iOS/Android store submission** (Fastlane lanes, provisioning) beyond the CI
  build jobs.
