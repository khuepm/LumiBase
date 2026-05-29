# User Management

## 1. Mô hình

- IdP: **Logto** (OIDC). Mỗi `users.logtoId` map 1-1.
- Membership: `user_sites` (role per site) + `user_policies` (override).
- Team/Group: `teams` + `team_members` để dễ gán policy theo nhóm (policy có thể `appliesToTeams: [...]`).

## 2. Tính năng

- **Invite user** qua email (Resend), token 1 lần, chọn role mặc định + policy.
- **SSO**: redirect Logto, on first login → auto-create `users` row, gán role default site.
- **Bulk import**: CSV / SCIM (Phase 2).
- **Impersonate**: admin có thể "view as user" (chỉ read-only; ghi activity).
- **Session manager**: list session active (Logto session API + local cache), revoke từng cái.
- **Device list**: theo `userAgent` + IP + lastSeen.
- **TFA**: hỗ trợ qua Logto (TOTP, WebAuthn).
- **Password reset**: delegate Logto.
- **Suspend / reactivate**: set `users.status`.

## 3. Profile

- Avatar (upload R2), tên, ngôn ngữ, theme (light/dark/system), preferred timezone, default presets per collection.

## 4. Activity & Audit

- Tab "Activity" trong user detail: filter theo action, collection.
- Tab "Permissions": preview matrix permission của user (computed) — gọi `/permissions/me?as=<userId>` (admin).

## 5. API

- `GET /users` (filter, paginate)
- `POST /users/invite`
- `PATCH /users/:id`
- `POST /users/:id/suspend` / `/activate`
- `POST /users/:id/impersonate` → trả về short-lived token
- `GET /users/:id/sessions` / `DELETE /sessions/:id`

## 6. UI

- Module **Users**:
  - List: search, filter status/role, bulk actions (assign role, suspend).
  - Detail: tabs *Profile*, *Roles & Policies*, *Sessions & Devices*, *Activity*, *Notifications*.
- Module **Teams**: list + drag-drop user vào team.

## 7. Tasks: Phase MVP-D.
