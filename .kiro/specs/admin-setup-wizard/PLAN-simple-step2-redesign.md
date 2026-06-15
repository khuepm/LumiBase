# Plan — Redesign Simple Setup Step 2 + Final-step Docs link

> Status: draft for approval. Scope = Simple setup wizard only. Advanced wizard
> (`/setup/advance…`) is left unchanged.

## Goal (from user)

1. **Step 2 (Simple, "Security review")** → simplify into:
   - **Top half:** pick security preset via a single **dropdown** (default `standard`)
     + a **Docs link** explaining how to choose.
   - **Bottom half:** an **invite-users** UI (email + role) right inside the step.
2. **Final step (Recovery codes)** → keep the "Go to admin login" button, **add a
   Docs link** (intro page).

The decisive constraint: inviting users *during* setup is **not** possible with the
current backend (`/api/v1/users/invite` requires an authenticated site admin, which
does not exist mid-setup). User chose to **extend the backend** so `POST
/api/v1/setup/complete` accepts an `invites[]` list and creates them in the same
transaction. Role choice = **2 presets: Admin / Member**.

---

## Backend changes (`apps/cms`)

### B1. Accept `invites[]` in the setup-complete request schema
File: `apps/cms/src/modules/setup/routes.ts` (`completeBodySchema`, ~line 33)

Add an optional array:
```ts
invites: z
  .array(
    z.object({
      email: z.string().email().max(254),
      role: z.enum(['admin', 'member']).default('member'),
    }),
  )
  .max(20)            // sane cap; tune if needed
  .optional(),
```
- De-dup by lowercased email at the route layer; reject if an invite email equals
  the bootstrap admin email (VALIDATION_ERROR).

### B2. Mirror the input type in the service
File: `apps/cms/src/modules/setup/service.ts`
- Extend `SetupCompleteInput` with `readonly invites?: ReadonlyArray<{ email: string; role: 'admin' | 'member' }>`.
- No change to `SetupCompleteResult` shape required for the wizard, but **add**
  `invitedCount: number` (or `invitedEmails: string[]`) so the Recovery step can
  confirm "N users invited". (Cheap, optional — include it.)

### B3. Seed a `Member` role + create invited users inside the existing tx
File: `apps/cms/src/modules/setup/service.ts`, inside `complete()`'s `db.transaction`,
**after** the bootstrap admin + Administrator role block (currently ~lines 569–588),
**before** backup-code persistence.

Steps:
1. Reuse existing `upsertAdministratorRole(tx, DEFAULT_SITE_ID)` (already returns
   `adminRoleId`).
2. Add a sibling `upsertMemberRole(tx, DEFAULT_SITE_ID)` — `systemKey: 'member'`,
   `adminAccess: false`, `appAccess: true`, idempotent via the existing
   `roles_site_system_key_unique` index. Returns `memberRoleId`.
3. For each invite: insert a `users` row with `status: 'invited'`,
   `externalId: 'shadow_' + nanoid()` (mirrors `routes/users.ts` invite),
   `email` lowercased. `onConflictDoNothing` on the users email unique index, then
   re-select to get the id (handles the conflict-skip case).
4. Bind each invited user to the role.
   - **Decision needed in code:** setup binds the admin via `user_roles`, but
     `routes/users.ts` invite binds via `user_sites.roleId`. For consistency with
     the rest of the auth stack, bind invited users via **both** `user_roles`
     (role resolution) **and** `user_sites` (site membership), matching how a
     fully-onboarded user looks. Verify against `PermissionService` resolution
     during implementation — if `user_sites.roleId` alone is sufficient, drop the
     `user_roles` write to avoid drift. (This is a verification step, not a guess.)
5. All inserts run on the same `tx` → atomic; a failure rolls back invites too
   (Req 1.5: no partial side effects).

### B4. Audit
- Emit one `user_invited` audit entry per invite (best-effort, via the same
  `resolveAuditLogger()`), `targetEmail` = invitee. Non-fatal.

### B5. Tests
- `apps/cms/src/modules/setup/*.test.ts` (integration): add a case posting
  `invites: [{email, role:'admin'}, {email, role:'member'}]` → assert two
  `users` rows with `status='invited'` and correct role bindings, plus rollback
  behaviour on a forced failure.
- Update any snapshot of the request/response shape.

---

## Frontend changes (`apps/studio`)

All in `apps/studio/src/modules/setup/simple-setup-wizard.tsx` unless noted.

### F1. Replace the 3-card radio with a dropdown + Docs link
`ReviewStep` (~lines 583–607): swap the `grid sm:grid-cols-3` radio block for:
- a `<select>` (native, styled with `inputClass`) bound to `securityPreset`,
  options `standard | strict | lenient`, default `standard`;
- a short helper line + **Docs link** → `https://docs.lumibase.dev/setup/security`
  (external, `target="_blank" rel="noreferrer"`). Use a `lucide` icon
  (`BookOpen` / `ExternalLink`) per repo convention (no emoji).
- Keep the existing "Security defaults" review table (it now reflects the dropdown
  selection live) — that's the "explain what's applied" value, keep it.
- Keep the existing "Open advanced setup instead" affordance.

### F2. Add the invite-users sub-section to Step 2
Below the preset block in `ReviewStep`:
- Local state: `invites: Array<{ email: string; role: 'admin' | 'member' }>`,
  lifted to the `SimpleSetupWizard` component (so it survives Back/forward and is
  passed into `handleComplete`).
- A small repeatable row: email `<input>` + role `<select>` (Admin/Member) +
  remove button; an "Add another" button; per-row email validation (reuse
  `z.string().email()`); skip empty rows on submit.
- This section is **optional** — zero invites is valid (button still says
  "Create setup").

### F3. Send invites on completion
- `postSetupComplete` (~line 985) + `handleComplete` (~line 205): include
  `invites` (filtered: non-empty, valid email, de-duped) in the POST body.
- Extend `SetupCompleteResponse` type (~line 71) if B2 adds `invitedCount`.

### F4. Final step (Recovery): add Docs link, keep login button
`RecoveryStep` (~lines 774–789):
- Keep the `adminUrl` code block + "Go to admin login" primary button.
- Add a **secondary link** "View docs" → `https://docs.lumibase.dev` (intro page),
  `target="_blank"`, styled with `secondaryButtonClass` + a `lucide` icon.
- If B2 returns `invitedCount > 0`, show a one-line confirmation
  ("N teammates invited — they'll appear under Users after first login").

### F5. Docs URL constant
- Introduce a tiny module-local constant (or reuse existing pattern from
  `apps/studio/src/lib/release-updates.ts` which already hardcodes
  `https://docs.lumibase.dev/...`). Define `DOCS_BASE_URL`, `DOCS_SECURITY_URL`
  near the other consts at the bottom of the file. **Confirm the real docs paths**
  exist before linking; if unknown, link the base `https://docs.lumibase.dev` and
  note the anchor as a TODO rather than inventing a path.

---

## Out of scope / not doing
- No changes to the Advanced wizard.
- No new standalone invite API (we extend setup-complete, not `/users/invite`).
- No granular permission model — only Admin vs Member presets.
- Invited users are `status='invited'`; actual onboarding/login of invitees is the
  existing post-setup flow, unchanged.

## Definition of Done checklist (per CLAUDE.md)
- `pnpm -F @lumibase/cms test` green (incl. new setup invite tests).
- `pnpm typecheck` green.
- **Setup Impact Registry** (`.kiro/specs/admin-setup-wizard/setup-impact.md`):
  this adds a new seeded role (`Member`) + invited users at bootstrap → must add
  a Registry row recording the impact (cannot be `n/a` — it changes what setup
  creates).
- Manual verify via preview: Simple flow → step 2 dropdown + invite a user →
  complete → step 3 shows Docs link + login button + invite confirmation.

## Open items to confirm during implementation (not blockers)
1. Exact role-binding table(s) for invitees (`user_roles` vs `user_sites`) — verify
   against `PermissionService`.
2. Real docs URLs/anchors for the security guide and intro page.
