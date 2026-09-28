# 1.0.0-rc.4 — acceptance from the published packages

Date: 2026-09-29. Implementer's evidence, not a reviewer verdict.

## What was installed

- `npx create-lumibase@next` (registry, not a local tarball) into an empty
  directory, Next.js template.
- Lockfile resolves `lumibase@1.0.0-rc.4`; compose pins
  `ghcr.io/khuepm/lumibase-cms:1.0.0-rc.4`.

## Passed on the published artifacts

- `cms:bootstrap`, `cms:seed`, `cms:verify`, typecheck and build of the site.
- Studio at `/admin-a7f3c1` with the prefix kept on navigation and reload.
- Access, measured with real logins:

  | Caller | `/permissions/me` | `/roles` | `/users` | `/settings` |
  |---|---|---|---|---|
  | invited Administrator | 200 | 200 | 200 | 200 |
  | invited Editor (no admin access) | 200 | 403 | 403 | 403 |
  | publishable key | — | 403 | — | — |

- `POST /users/invite` with `roleId: ""` or without `email`: 400 `VALIDATION`.
- Invited Administrator sees the content list with New item, Users, Access,
  Settings.

## Found on the published image (fixed on `fix/studio-bundled-docker-gaps`)

| Backlog | Symptom on rc.4 | Cause |
|---|---|---|
| B103 | Versions panel, presets, Mission Control actions, AI approvals, Insights, email, materialisation, transform presets, push: `400 TENANT_REQUIRED` | 11 helpers sent `x-site-id` |
| B104 | Header shows "Realtime connecting" forever; console `TypeError: Invalid URL`; presence ticket `400` | relative `baseUrl` passed to `new URL`; presence read unwritten storage keys |
| B105 | Footer "Backend unavailable"; `/api/v1/system/version` → `version: "unknown"` | footer read `.data` of a bare body; Node bundle never received build metadata |

## Re-check on a locally built image from the branch

Same database, CMS swapped to the branch image, Studio bundle from the branch:

- `/api/v1/system/version` → `1.0.0-rc.4`, channel `production`; footer
  "Backend v1.0.0-rc.4".
- `presets/effective`, `presets/bookmarks`, item `versions`, both
  `realtime/ticket` calls, Mission Control, Insights and email settings: 200.
- Header "Realtime connected" on the content list; no console errors except
  the 404s for unset settings keys (`settings/locales`,
  `settings/translations.learnTm`), which the Studio already handles.
- Release smoke assertions pass on the branch image and fail on the published
  rc.4 image (`unknown`), so the gate detects this defect.

## Not checked

- A release built by `release.yml` with the new build args. The first tag after
  merge is the real check.
- Realtime on the Cloudflare Pages Studio (absolute `VITE_API_URL`; the change
  keeps that path as before).
- yarn/bun, `default`/`cloudflare` templates on rc.4.
