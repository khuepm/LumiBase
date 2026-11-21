# Studio native-host contract

The Studio SPA can run inside a **native host**: a Tauri 2 webview wrapper that
ships it as a desktop or mobile app. The host is built and distributed outside
this repository; it embeds the output of `pnpm -F @lumibase/studio build` and,
in release builds, may navigate to a hosted Studio deployment instead.

A host is a thin wrapper, so it depends on a handful of Studio/CMS contracts. A
change here can break the desktop/mobile app **without breaking the browser
build**, and nothing in this repository compiles the host. Before changing any
of the items below, keep them working (see the "Native host impact" step in
`.kiro/steering/definition-of-done.md`, §2d).

## What the Studio expects from a host

| Surface | Shape | Consumer |
|---|---|---|
| Detection | `window.__TAURI_INTERNALS__` (or `window.isTauri`) is present | `src/lib/shell.ts` → `isDesktopShell()` |
| Origin | `tauri://localhost` (`https://tauri.localhost` on Windows) in bundled mode | CMS CORS, WebAuthn RP resolution |
| Secure storage (optional) | IPC commands `secure_get(key)`, `secure_set(key, value)`, `secure_delete(key)` | `src/lib/token-store.ts` |
| Deep links | event `shell://deep-link` carrying `string[]` of opened URLs | `src/lib/intents/shell-deep-link.ts` |

When the secure-storage commands are missing or fail (mobile, or a Linux box
with no Secret Service daemon), the token store falls back to `localStorage`.

## Contracts future work must not break

| # | Contract | Where | Break it and… |
|---|----------|-------|---------------|
| C1 | Session tokens go through `token-store.ts` / the `api.ts` accessors — **never** `localStorage.setItem('lumibase.dev.token', …)` directly. | `src/lib/token-store.ts`, `api.ts` | tokens bypass the OS keychain in the host and are lost on next launch / left in plaintext. |
| C2 | The CMS origin is always resolved via `getApiBaseUrl()` — never hardcode `/api` same-origin or read `import.meta.env.VITE_API_URL` directly. | `src/lib/api-base.ts` | the runtime server override + cross-origin bundled mode stop working. |
| C3 | Studio builds to `apps/studio/dist` with a root Vite `base`. | `vite.config.ts` | a host that embeds the build fails to bundle, or assets 404 under `tauri://localhost`. |
| C4 | Studio dev server runs on port **2026**. | `vite.config.ts` | a host started in dev mode loads a blank window. |
| C5 | New browser APIs must degrade gracefully — hosts run WKWebView (macOS/iOS), WebView2 (Windows), WebKitGTK (Linux). | Studio features | a feature works in Chrome but throws in the host. |
| C6 | Cross-origin auth: in bundled mode the SPA calls the CMS from `tauri://localhost`. Auth flows must work with the token-in-body path (not only same-origin cookies), and new SPA-called endpoints must be CORS-reachable (`CORS_ALLOWED_ORIGINS`). | CMS auth/CORS, `@lumibase/sdk` refresh | login/refresh fails only in the bundled host. |
| C7 | The server-connection probe hits `GET {origin}/health` (public, no auth). | `src/components/server-connection.tsx` ↔ CMS `/health` | the "Connect to LumiBase" screen can never validate a server. |
| C8 | Deep links arrive as the `shell://deep-link` event; auth callbacks should consume it rather than assume a browser redirect. | `src/lib/intents/shell-deep-link.ts` | OAuth/magic-link callbacks silently drop on desktop/mobile. |

C3 and C4 are the two a host hardcodes in its own build configuration. Changing
either is a breaking change for hosts: call it out in the changelog.

## Server connection

Bundled mode has no co-located backend, so on first run inside a host the Studio
shows a **Connect to LumiBase** screen (`src/components/server-connection.tsx`).
The entered origin is validated against the CMS `/health` endpoint and persisted
as a runtime API-base override (`src/lib/api-base.ts`). Self-hosted CMS servers
must allow the host origin via `CORS_ALLOWED_ORIGINS`.

## Not available inside a host

- **Passkeys (WebAuthn).** The Studio hides every passkey control (C5): the
  webviews either lack WebAuthn or run it under `tauri://localhost`, which no
  server RP ID can match. See `docs/en/security/passkeys.md` §6.
