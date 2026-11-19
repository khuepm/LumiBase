-- Memberships, newsletters & audience (epic #672: N01 members/tiers/portal,
-- N07 segments, N03 newsletters, N04 sequences, N06 sending domains).
-- Additive: new tables only, no backfill. Re-runnable.
-- Rollback (reverse order): DROP TABLE lumibase_sending_domains, lumibase_sequence_enrollments,
--   lumibase_email_sequences, lumibase_newsletter_deliveries, lumibase_newsletter_sends,
--   lumibase_member_newsletters, lumibase_newsletters, lumibase_member_segments,
--   lumibase_member_login_tokens, lumibase_members, lumibase_member_tiers, lumibase_member_settings;
CREATE TABLE IF NOT EXISTS lumibase_member_settings (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  portal_enabled boolean NOT NULL DEFAULT false,
  allow_self_signup boolean NOT NULL DEFAULT true,
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_newsletter_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  signup_copy jsonb NOT NULL DEFAULT '{}'::jsonb,
  sender_name text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_settings_site_unique ON lumibase_member_settings(site_id);

CREATE TABLE IF NOT EXISTS lumibase_member_tiers (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'paid',
  active boolean NOT NULL DEFAULT true,
  monthly_price_cents integer,
  yearly_price_cents integer,
  currency text,
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_id text REFERENCES lumibase_policies(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_tiers_site_key_unique ON lumibase_member_tiers(site_id, key);

CREATE TABLE IF NOT EXISTS lumibase_members (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  user_id text REFERENCES lumibase_users(id) ON DELETE SET NULL,
  email text NOT NULL,
  email_lower text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'free',
  tier_id text REFERENCES lumibase_member_tiers(id) ON DELETE SET NULL,
  tier_expires_at timestamp,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  source text NOT NULL DEFAULT 'admin',
  email_verified_at timestamp,
  external_customer_id text,
  email_count integer NOT NULL DEFAULT 0,
  email_opened_count integer NOT NULL DEFAULT 0,
  last_email_opened_at timestamp,
  last_seen_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS members_site_email_unique ON lumibase_members(site_id, email_lower);
CREATE INDEX IF NOT EXISTS members_site_status_idx ON lumibase_members(site_id, status);
CREATE INDEX IF NOT EXISTS members_site_created_idx ON lumibase_members(site_id, created_at);
CREATE INDEX IF NOT EXISTS members_user_idx ON lumibase_members(user_id);

CREATE TABLE IF NOT EXISTS lumibase_member_login_tokens (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  email_lower text NOT NULL,
  purpose text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  redirect_uri text,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_login_tokens_hash_unique ON lumibase_member_login_tokens(token_hash);
CREATE INDEX IF NOT EXISTS member_login_tokens_site_email_idx ON lumibase_member_login_tokens(site_id, email_lower, created_at);

CREATE TABLE IF NOT EXISTS lumibase_member_segments (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_segments_site_idx ON lumibase_member_segments(site_id);

CREATE TABLE IF NOT EXISTS lumibase_newsletters (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  sender_name text,
  sender_email text,
  reply_to text,
  status text NOT NULL DEFAULT 'active',
  audience text NOT NULL DEFAULT 'members',
  subscribe_on_signup boolean NOT NULL DEFAULT true,
  track_opens boolean NOT NULL DEFAULT false,
  track_clicks boolean NOT NULL DEFAULT false,
  layout_key text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletters_site_key_unique ON lumibase_newsletters(site_id, key);

CREATE TABLE IF NOT EXISTS lumibase_member_newsletters (
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES lumibase_members(id) ON DELETE CASCADE,
  newsletter_id text NOT NULL REFERENCES lumibase_newsletters(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, newsletter_id)
);
CREATE INDEX IF NOT EXISTS member_newsletters_site_newsletter_idx ON lumibase_member_newsletters(site_id, newsletter_id, member_id);

CREATE TABLE IF NOT EXISTS lumibase_newsletter_sends (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  newsletter_id text NOT NULL REFERENCES lumibase_newsletters(id) ON DELETE CASCADE,
  collection text NOT NULL,
  item_id text NOT NULL,
  segment_id text REFERENCES lumibase_member_segments(id) ON DELETE SET NULL,
  segment_filter jsonb,
  subject text NOT NULL,
  html text NOT NULL,
  text text,
  link_base text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  cursor text,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  created_by text,
  lease_owner text,
  lease_until timestamp,
  started_at timestamp,
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sends_site_item_unique ON lumibase_newsletter_sends(site_id, newsletter_id, collection, item_id);
CREATE INDEX IF NOT EXISTS newsletter_sends_status_lease_idx ON lumibase_newsletter_sends(status, lease_until);

CREATE TABLE IF NOT EXISTS lumibase_newsletter_deliveries (
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  send_id text NOT NULL REFERENCES lumibase_newsletter_sends(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES lumibase_members(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  error text,
  opened_at timestamp,
  clicked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (send_id, member_id)
);
CREATE INDEX IF NOT EXISTS newsletter_deliveries_site_send_idx ON lumibase_newsletter_deliveries(site_id, send_id);

CREATE TABLE IF NOT EXISTS lumibase_email_sequences (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  trigger text NOT NULL,
  trigger_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  template_key text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_sequences_site_key_unique ON lumibase_email_sequences(site_id, key);

CREATE TABLE IF NOT EXISTS lumibase_sequence_enrollments (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  sequence_id text NOT NULL REFERENCES lumibase_email_sequences(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES lumibase_members(id) ON DELETE CASCADE,
  step_index integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  stopped_reason text,
  next_run_at timestamp,
  lease_until timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_sequence_member_unique ON lumibase_sequence_enrollments(sequence_id, member_id);
CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx ON lumibase_sequence_enrollments(status, next_run_at);
CREATE INDEX IF NOT EXISTS sequence_enrollments_site_member_idx ON lumibase_sequence_enrollments(site_id, member_id);

CREATE TABLE IF NOT EXISTS lumibase_sending_domains (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dkim_selector text NOT NULL,
  dkim_public_key text NOT NULL,
  dkim_private_key_sealed text NOT NULL,
  next_selector text,
  next_public_key text,
  next_private_key_sealed text,
  previous_selector text,
  previous_public_key text,
  previous_retire_after timestamp,
  rotate_after timestamp,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamp,
  verified_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sending_domains_site_domain_unique ON lumibase_sending_domains(site_id, domain);
