# System Configuration

> LumiBase có **layered config**: `env` (Workers Secret) → `site` (`settings` table) → `user` (preferences).

## 1. Scopes & precedence

1. **System (env)** — bí mật, không edit qua UI (DB URL, Logto secret, R2 keys).
2. **Site (settings table)** — admin edit qua Studio: branding, locales, modules enabled, default role, security policies.
3. **User (users.preferences)** — theme, language, default presets.

Resolver: `getSetting(key, { siteId, userId })` → trả về giá trị merge theo precedence.

## 2. Settings categories

| Category | Ví dụ key |
|---|---|
| Branding | `branding.logo`, `branding.primaryColor`, `branding.appName` |
| Locales | `locales.default`, `locales.available` |
| Security | `security.session.maxAge`, `security.password.policy`, `security.cors.origins` |
| Files | `files.maxUploadSize`, `files.allowedMimes`, `files.transformations` |
| Realtime | `realtime.enabled`, `realtime.maxConnectionsPerUser` |
| Modules | `modules.bookmarks.enabled`, `modules.translations.enabled`, … |
| Webhooks | (managed in `webhooks` table) |
| Notifications | `notifications.email.from`, `notifications.email.templates` |
| AI | `ai.provider`, `ai.translationDefault` |

## 3. UI Settings

Module **Settings** (chỉ admin):
- *General* — branding, app name, default locale.
- *Project Configuration* — modules toggle, feature flags.
- *Roles & Policies* (re-export từ permissions module).
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
- Hono routes lấy settings qua middleware `withSettings` (cache trong KV với SWR).

## 5. Config-as-Code

- CLI `lumibase config:export --site <id> --out ./lumibase.config.yaml`.
- `lumibase config:apply ./lumibase.config.yaml` — diff + apply (collections, fields, roles, policies, settings, webhooks, presets).
- Yêu cầu permission `config:write`.

## 6. Diff / Rollback

- Mỗi save settings ghi vào `activity` với `payload` cũ→mới; có nút "Rollback to revision".

## 7. Tasks: Phase MVP-D & GA-F.
