---
version: 1
lastUpdated: 2026-06-23T12:59:56.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: 48ccd8b0c2aa4504
mtEngine: claude
syncStatus: machine-translated
---

# System Configuration

> LumiBase has a **layered config**: `env` (Workers Secret) → `site` (`settings` table) → `user` (preferences).

## 1. Scopes & precedence

1. **System (env)** — secret, not editable via the UI (DB URL, Logto secret, R2 keys).
2. **Site (settings table)** — admin-editable in Studio: branding, locales, modules enabled, default role, security policies.
3. **User (users.preferences)** — theme, language, default presets.

Resolver: `getSetting(key, { siteId, userId })` → returns the merged value by precedence.

Realtime adds one collection-level opt-in layer: env/bindings decide whether the deployment supports WebSocket, `settings.realtime.enabled` enables it for the site, and `collections.meta.realtime.enabled` selects the collections users may subscribe to.

## 2. Settings categories

| Category | Example key |
|---|---|
| Branding | `branding.logo`, `branding.primaryColor`, `branding.appName` |
| Locales | `locales.default`, `locales.available` |
| Security | `security.session.maxAge`, `security.password.policy`, `security.cors.origins` |
| Files | `files.maxUploadSize`, `files.allowedMimes`, `files.transformations` |
| Realtime | `realtime.enabled`, `realtime.maxConnectionsPerUser` |
| Modules | `modules.bookmarks.enabled`, `modules.translations.enabled`, … |
| Webhooks | (managed in the `webhooks` table) |
| Notifications | `notifications.email.from`, `notifications.email.templates` |
| AI | `ai.provider`, `ai.translationDefault` |

## 3. UI Settings

The **Settings** module (admin only):
- *General* — branding, app name, default locale.
- *Project Configuration* — modules toggle, feature flags.
- *Roles & Policies* (re-exported from the permissions module).
- *Locales & Translations*.
- *Webhooks & Flows*.
- *Files & Storage*.
- *Extensions*.
- *Security* — session, CORS, IP allowlist, audit retention.
- *Email Templates*.
- *Activity Log*.
- *Backups* (Phase 2).

## 4. Hot reload

- Update settings → write DB + KV (`settings:{site}`) + broadcast `settings.changed`.
- Hono routes read settings via the `withSettings` middleware (cached in KV with SWR).

## 5. Config-as-Code

- CLI `lumibase config:export --site <id> --out ./lumibase.config.yaml`.
- `lumibase config:apply ./lumibase.config.yaml` — diff + apply (collections, fields, roles, policies, settings, webhooks, presets).
- Requires the `config:write` permission.

## 6. Diff / Rollback

- Each settings save is written to `activity` with the old→new `payload`; a "Rollback to revision" button is available.

## 7. Tasks: Phase MVP-D & GA-F.
