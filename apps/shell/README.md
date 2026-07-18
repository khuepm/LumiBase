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

## Auto-update (desktop)

Desktop builds check for updates in the background on launch (`src/lib.rs`) via
`tauri-plugin-updater`. Updates are verified against the minisign public key in
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
