-- Public (anonymous) realm hardening.
--
-- The `public` system role is what an unauthenticated request resolves to, so
-- an elevation flag on it would be an unauthenticated admin bypass. Pin both
-- flags off in the database: the service layer refuses these edits too, but a
-- constraint holds for hand-written SQL, imports and future code paths alike.
--
-- `is distinct from` (not `<>`) so the predicate is FALSE-or-TRUE rather than
-- NULL for the many rows with a NULL system_key / key.

ALTER TABLE "lumibase_roles"
  ADD CONSTRAINT "roles_public_least_privilege"
  CHECK (
    "system_key" is distinct from 'public'
    or ("admin_access" = false and "app_access" = false)
  );
--> statement-breakpoint
ALTER TABLE "lumibase_policies"
  ADD CONSTRAINT "policies_public_least_privilege"
  CHECK (
    "key" is distinct from 'public'
    or ("admin_access" = false and "app_access" = false and "enforce_tfa" = false)
  );
