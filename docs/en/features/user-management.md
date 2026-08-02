---
version: 1
lastUpdated: 2026-07-28T00:15:09.926Z
sourceLang: vi
translatedFrom: vi
sourceHash: c3fccd8c6549cd9a
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:15:09.926Z
codeVerifiedHash: c3fccd8c6549cd9a
codeVerifiedClaims: 14
---

# User Management

## 1. The model

- IdP: **Logto** (OIDC). Each `users.logtoId` maps 1-1.
- Membership: `user_sites` (role per site) + `user_policies` (override).
- Team/Group: `teams` + `team_members`, to make it easy to assign a policy per group (a policy can carry `appliesToTeams: [...]`).

## 2. Features

- **Invite user** by email (Resend), single-use token, pick the default role + policy.
- **SSO**: redirect to Logto; on first login → auto-create the `users` row and assign the site's default role.
- **Bulk import**: CSV / SCIM (Phase 2).
- **Impersonate**: an admin can "view as user" (read-only; writes an activity record).
- **Session manager**: list active sessions (Logto session API + local cache), revoke them individually.
- **Device list**: by `userAgent` + IP + lastSeen.
- **TFA**: supported through Logto (TOTP, WebAuthn).
- **Password reset**: delegated to Logto.
- **Suspend / reactivate**: sets `users.status`.

## 3. Profile

- Avatar (uploaded to R2), name, language, theme (light/dark/system), preferred timezone, default presets per collection.

## 4. Activity & audit

- An "Activity" tab in the user detail: filter by action and collection.
- A "Permissions" tab: preview the user's computed permission matrix — calls `/permissions/me?as=<userId>` (admin).

## 5. API

- `GET /users` (filter, paginate)
- `POST /users/invite`
- `PATCH /users/:id`
- `POST /users/:id/suspend` / `/activate`
- `POST /users/:id/impersonate` → returns a short-lived token
- `GET /users/:id/sessions` / `DELETE /sessions/:id`

## 6. UI

- The **Users** module:
  - List: search, filter by status/role, bulk actions (assign role, suspend).
  - Detail: tabs *Profile*, *Roles & Policies*, *Sessions & Devices*, *Activity*, *Notifications*.
- The **Teams** module: list + drag-and-drop a user into a team.

## 7. Tasks: Phase MVP-D.

## 8. Compliance & user rights

User accounts carry personal data subject to GDPR / CCPA / PDPD and app-store
policy. For the legal rights users are entitled to (erasure, access, portability,
consent, account deletion) and how they map to current user-management features,
see [Compliance & User Rights](../compliance/README.md) — in particular the
[gap-analysis](../compliance/gap-analysis.md).
