-- Auth session hardening (review findings H1 + H3).
--
-- H1 — single-use password-reset tokens: add `users.password_changed_at`.
-- The `/auth/reset-password` and `/me/change-password` handlers stamp this
-- on every password change; a stateless reset token whose `iat` predates it
-- is rejected, so a leaked/replayed reset link can't set a second password.
--
-- H3 — global case-insensitive email uniqueness: `users` is identity-global
-- (one row per human across sites), so an email must map to one account.
-- This unique index is the DB backstop behind the check-then-insert in
-- `/auth/register`, closing the concurrent-registration race.
--
-- ⚠️ The unique index creation FAILS if the `users` table already holds
--    case-insensitive duplicate emails. De-duplicate first, e.g.:
--      SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
--    and merge/remove the extras before running this migration.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_unique" ON "users" USING btree (lower("email"));
