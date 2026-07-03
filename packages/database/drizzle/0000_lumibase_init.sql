CREATE TABLE "lumibase_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"recipient" text NOT NULL,
	"sender" text,
	"subject" text NOT NULL,
	"message" text,
	"collection" text,
	"item" text,
	"status" text DEFAULT 'unread' NOT NULL,
	"pushed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_sites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"display_title" text,
	"site_url" text,
	"descriptor" text,
	"default_language" text DEFAULT 'en' NOT NULL,
	"default_appearance" text DEFAULT 'auto' NOT NULL,
	"default_save_action" text DEFAULT 'stay' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_css" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_sites_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "lumibase_team_members" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_user_sites" (
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"role_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_user_sites_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_users" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text,
	"password_hash" text,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"avatar" text,
	"status" text DEFAULT 'active' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tfa" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp,
	"is_bootstrap" boolean DEFAULT false NOT NULL,
	"locked_until" timestamp,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"failed_count_window_start" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_api_key_policies" (
	"api_key_id" text NOT NULL,
	"site_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_api_key_policies_api_key_id_policy_id_pk" PRIMARY KEY("api_key_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_api_key_roles" (
	"api_key_id" text NOT NULL,
	"site_id" text NOT NULL,
	"role_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_api_key_roles_api_key_id_role_id_pk" PRIMARY KEY("api_key_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"rotated_at" timestamp,
	"rotated_by" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by" text,
	"last_used_at" timestamp,
	"last_used_ip" text,
	"last_used_user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"collection" text NOT NULL,
	"action" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"presets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '["*"]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"icon" text,
	"description" text,
	"admin_access" boolean DEFAULT false NOT NULL,
	"app_access" boolean DEFAULT false NOT NULL,
	"enforce_tfa" boolean DEFAULT false NOT NULL,
	"ip_allow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip_deny" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_role_policies" (
	"role_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "lumibase_role_policies_role_id_policy_id_pk" PRIMARY KEY("role_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text,
	"system_key" text,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"parent_id" text,
	"admin_access" boolean DEFAULT false NOT NULL,
	"app_access" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_scim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"role_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" text,
	"created_by" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shares_max_uses_positive" CHECK ("lumibase_shares"."max_uses" is null or "lumibase_shares"."max_uses" >= 1),
	CONSTRAINT "shares_used_count_non_negative" CHECK ("lumibase_shares"."used_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lumibase_user_policies" (
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "lumibase_user_policies_user_id_site_id_policy_id_pk" PRIMARY KEY("user_id","site_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_user_roles" (
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_user_roles_user_id_site_id_role_id_pk" PRIMARY KEY("user_id","site_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_user_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"consent_type" text NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp,
	"withdrawn_at" timestamp,
	"source" text,
	"version" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"email_lower" text NOT NULL,
	"reason" text DEFAULT 'unsubscribe' NOT NULL,
	"source" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_processing_restrictions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"action" text NOT NULL,
	"user_id" text,
	"collection" text,
	"item_id" text,
	"ip" text,
	"user_agent" text,
	"comment" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"plural_label" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"singleton" boolean DEFAULT false NOT NULL,
	"icon" text,
	"color" text,
	"note" text,
	"primary_key_field" text DEFAULT 'id' NOT NULL,
	"primary_key_type" text DEFAULT 'nanoid' NOT NULL,
	"storage_mode" text DEFAULT 'jsonb' NOT NULL,
	"display_template" text,
	"sort_field" text,
	"archive_field" text,
	"archive_value" text,
	"unarchive_value" text,
	"item_duplication_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accountability" text DEFAULT 'all' NOT NULL,
	"versioning" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_content_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"interface" text NOT NULL,
	"display" text,
	"label" text,
	"note" text,
	"default_value" jsonb,
	"nullable" boolean DEFAULT true NOT NULL,
	"unique" boolean DEFAULT false NOT NULL,
	"indexed" boolean DEFAULT false NOT NULL,
	"searchable" boolean DEFAULT true NOT NULL,
	"length" integer,
	"precision" integer,
	"scale" integer,
	"special" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{"rules":[]}'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"readonly" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"classification" text DEFAULT 'none' NOT NULL,
	"versioned" boolean DEFAULT false NOT NULL,
	"raw_enabled" boolean DEFAULT true NOT NULL,
	"width" text DEFAULT 'full' NOT NULL,
	"group" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_flow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[]}'::jsonb NOT NULL,
	"next_run_at" timestamp,
	"accountability" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_items" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"publish_at" timestamp,
	"unpublish_at" timestamp,
	"editorial_state" text,
	"dek_wrapped" text,
	"user_created" text,
	"user_updated" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_materialized_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"target" text NOT NULL,
	"refresh_strategy" text DEFAULT 'manual' NOT NULL,
	"refresh_cron" text,
	"projection" jsonb DEFAULT '{"fields":["*"]}'::jsonb NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_refreshed_at" timestamp,
	"row_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"layout_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_panels" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"position" jsonb DEFAULT '{"x":0,"y":0,"w":4,"h":4}'::jsonb NOT NULL,
	"query" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"many_collection" text NOT NULL,
	"many_field" text NOT NULL,
	"one_collection" text NOT NULL,
	"one_field" text,
	"junction_collection" text,
	"type" text DEFAULT 'm2o' NOT NULL,
	"alias_field" text,
	"related_display_template" text,
	"junction_many_field" text,
	"junction_one_field" text,
	"sort_field" text,
	"on_delete" text DEFAULT 'no action' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_release_items" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"release_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"target_status" text DEFAULT 'published' NOT NULL,
	"revision_id" text,
	"outcome" text,
	"outcome_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"atomicity_mode" text DEFAULT 'all_or_nothing' NOT NULL,
	"publish_at" timestamp,
	"published_at" timestamp,
	"maintenance_window" jsonb,
	"status_reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"delta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_id" text,
	"user_id" text,
	"author_type" text DEFAULT 'human' NOT NULL,
	"created_by_run_id" text,
	"model" text,
	"constitution_hash" text,
	"sources" jsonb,
	"confidence" real,
	"staged" boolean DEFAULT false NOT NULL,
	"auto_commit_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_email_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"layout_id" text,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"key" text,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"bundle_url" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"installed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"signature" text,
	"signature_alg" text,
	"publisher_key_id" text,
	"publisher" text,
	"marketplace_slug" text,
	"published_at" timestamp,
	"bundle_sha256" text
);
--> statement-breakpoint
CREATE TABLE "lumibase_files" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"storage" text DEFAULT 'r2' NOT NULL,
	"filename_disk" text NOT NULL,
	"filename_download" text NOT NULL,
	"mime" text NOT NULL,
	"filesize" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration" integer,
	"folder" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"parent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_glossary" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"term" text NOT NULL,
	"translation" text NOT NULL,
	"rule" text DEFAULT 'prefer' NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"bookmark" text,
	"collection" text NOT NULL,
	"user_id" text,
	"role_id" text,
	"layout" text DEFAULT 'tabular' NOT NULL,
	"layout_query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"layout_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search" text,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"icon" text,
	"color" text,
	"refresh_interval" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text DEFAULT 'site' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_translation_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"source_text" text NOT NULL,
	"target_text" text NOT NULL,
	"context" text,
	"quality" integer DEFAULT 100 NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"provider" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_translations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"language" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"site_id" text NOT NULL,
	"legacy_approval_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_policy" text DEFAULT 'before_execute' NOT NULL,
	"kind" text DEFAULT 'approval' NOT NULL,
	"auto_commit_at" timestamp,
	"requested_by_agent" text DEFAULT 'lumibase-copilot' NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"approver_type" text DEFAULT 'human' NOT NULL,
	"approver_run_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"site_id" text NOT NULL,
	"type" text NOT NULL,
	"target" text,
	"title" text NOT NULL,
	"content_ref" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"site_id" text NOT NULL,
	"artifact_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"score" integer,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"artifact_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'user' NOT NULL,
	"created_by" text,
	"assignee_agent" text DEFAULT 'lumibase-copilot' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"deadline" timestamp,
	"status" text DEFAULT 'open' NOT NULL,
	"success_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_goal_id" text,
	"origin" text DEFAULT 'user' NOT NULL,
	"intent_id" text,
	"drift_fingerprint" text,
	"agent_role" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"source_type" text NOT NULL,
	"source_id" text,
	"content" text NOT NULL,
	"embedding" jsonb,
	"confidence" integer DEFAULT 100 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"principal_type" text DEFAULT 'agent' NOT NULL,
	"principal_id" text,
	"policy_id" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment" text DEFAULT 'all' NOT NULL,
	"valid_from" timestamp DEFAULT now() NOT NULL,
	"valid_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"site_id" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"risk" text DEFAULT 'safe' NOT NULL,
	"approval_policy" text DEFAULT 'none' NOT NULL,
	"approved_at" timestamp,
	"approved_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"site_id" text NOT NULL,
	"agent_name" text DEFAULT 'lumibase-copilot' NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"model" text DEFAULT 'tool-registry' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_snapshot_hash" text,
	"risk" text DEFAULT 'safe' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"retry_of_run_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"site_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"risk" text DEFAULT 'safe' NOT NULL,
	"approval_id" text,
	"latency_ms" integer,
	"cost" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_policy" jsonb DEFAULT '{"level":"safe"}'::jsonb NOT NULL,
	"rate_limit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner" text DEFAULT 'core' NOT NULL,
	"extension_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"agent_name" text DEFAULT 'lumibase-copilot' NOT NULL,
	"skill_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text,
	"field_name" text,
	"chunk_text" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_admin_backup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"used_at" timestamp,
	"used_from_ip" text
);
--> statement-breakpoint
CREATE TABLE "lumibase_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"site_id" text,
	"event" text NOT NULL,
	"actor_email" text,
	"target_email" text,
	"ip" text,
	"user_agent" text,
	"country_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "lumibase_login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"email_lower" text NOT NULL,
	"user_id" text,
	"ip" text NOT NULL,
	"user_agent" text,
	"country_code" text,
	"geo_lookup_status" text,
	"result" text NOT NULL,
	"reason" text,
	"anomaly_score" numeric(4, 2),
	"anomaly_triggered" boolean DEFAULT false NOT NULL,
	"baseline_warmup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_login_baselines" (
	"user_id" text PRIMARY KEY NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hour_histogram" jsonb DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb NOT NULL,
	"device_fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"successful_logins" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_system_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"state" text DEFAULT 'uninitialized' NOT NULL,
	"admin_path" text,
	"setup_token_hash" text,
	"initialized_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_singleton_chk" CHECK ("lumibase_system_state"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "lumibase_cdc_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text,
	"site_id" text NOT NULL,
	"approach" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_cdc_pipeline_health" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"replication_lag_ms" integer NOT NULL,
	"events_per_second" integer NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_cdc_pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"pipeline_name" text NOT NULL,
	"connector_type" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"status_message" text,
	"source_connection" text NOT NULL,
	"sink_connection" text NOT NULL,
	"intermediary_connection" text,
	"replication_tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_record_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_autonomy_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"agent_role" text NOT NULL,
	"capability" text NOT NULL,
	"level" integer DEFAULT 2 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by" text,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_freezes" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"scope" text NOT NULL,
	"target_role" text,
	"reason" text,
	"frozen_by" text,
	"lifted_at" timestamp,
	"lifted_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"agent_role" text NOT NULL,
	"capability" text,
	"source" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"run_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_prompt_ref" text,
	"model" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_constitutions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"version" integer NOT NULL,
	"evaluators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"activated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_content_drifts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"item_id" text NOT NULL,
	"rule_type" text NOT NULL,
	"rule_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"goal_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_content_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"collection" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" text NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"autonomy_cap" integer DEFAULT 2 NOT NULL,
	"maintenance_window" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"scan_cursor" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_firebase_sync_log" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_firebase_sync_pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"project_id" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_path" text DEFAULT '{collection}' NOT NULL,
	"sync_on_create" integer DEFAULT 1 NOT NULL,
	"sync_on_update" integer DEFAULT 1 NOT NULL,
	"sync_on_delete" integer DEFAULT 1 NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_item_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_content_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text,
	"revision_id" text,
	"requested_by" text,
	"assigned_to" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_encryption_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"key_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"algo" text DEFAULT 'AES-GCM' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_erasure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject_hash" text,
	"reason" text,
	"requested_by" text,
	"confirmed_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_field_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"request_id" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_deployment_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"project_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"default_branch" text,
	"production_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"target_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_deployment_id" text,
	"status" text NOT NULL,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"url" text,
	"triggered_by" text,
	"trigger_source" text NOT NULL,
	"error_message" text,
	"log_excerpt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lumibase_auth_external_issuers" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"issuer" text NOT NULL,
	"jwks_uri" text,
	"discovery_url" text,
	"audience" jsonb NOT NULL,
	"algorithms" jsonb NOT NULL,
	"claim_mapping" jsonb NOT NULL,
	"role_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_role_id" text,
	"jit_provisioning" boolean DEFAULT false NOT NULL,
	"clock_skew_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_notifications" ADD CONSTRAINT "lumibase_notifications_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_notifications" ADD CONSTRAINT "lumibase_notifications_recipient_lumibase_users_id_fk" FOREIGN KEY ("recipient") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_notifications" ADD CONSTRAINT "lumibase_notifications_sender_lumibase_users_id_fk" FOREIGN KEY ("sender") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_team_members" ADD CONSTRAINT "lumibase_team_members_team_id_lumibase_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."lumibase_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_team_members" ADD CONSTRAINT "lumibase_team_members_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_teams" ADD CONSTRAINT "lumibase_teams_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_sites" ADD CONSTRAINT "lumibase_user_sites_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_sites" ADD CONSTRAINT "lumibase_user_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_policies" ADD CONSTRAINT "lumibase_api_key_policies_api_key_id_lumibase_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."lumibase_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_policies" ADD CONSTRAINT "lumibase_api_key_policies_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_policies" ADD CONSTRAINT "lumibase_api_key_policies_policy_id_lumibase_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lumibase_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_roles" ADD CONSTRAINT "lumibase_api_key_roles_api_key_id_lumibase_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."lumibase_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_roles" ADD CONSTRAINT "lumibase_api_key_roles_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_key_roles" ADD CONSTRAINT "lumibase_api_key_roles_role_id_lumibase_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."lumibase_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_keys" ADD CONSTRAINT "lumibase_api_keys_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_keys" ADD CONSTRAINT "lumibase_api_keys_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_keys" ADD CONSTRAINT "lumibase_api_keys_rotated_by_lumibase_users_id_fk" FOREIGN KEY ("rotated_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_api_keys" ADD CONSTRAINT "lumibase_api_keys_revoked_by_lumibase_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_permissions" ADD CONSTRAINT "lumibase_permissions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_permissions" ADD CONSTRAINT "lumibase_permissions_policy_id_lumibase_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lumibase_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_policies" ADD CONSTRAINT "lumibase_policies_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_role_policies" ADD CONSTRAINT "lumibase_role_policies_role_id_lumibase_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."lumibase_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_role_policies" ADD CONSTRAINT "lumibase_role_policies_policy_id_lumibase_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lumibase_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_roles" ADD CONSTRAINT "lumibase_roles_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_scim_tokens" ADD CONSTRAINT "lumibase_scim_tokens_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shares" ADD CONSTRAINT "lumibase_shares_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shares" ADD CONSTRAINT "lumibase_shares_role_id_lumibase_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."lumibase_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shares" ADD CONSTRAINT "lumibase_shares_revoked_by_lumibase_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shares" ADD CONSTRAINT "lumibase_shares_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_policies" ADD CONSTRAINT "lumibase_user_policies_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_policies" ADD CONSTRAINT "lumibase_user_policies_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_policies" ADD CONSTRAINT "lumibase_user_policies_policy_id_lumibase_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lumibase_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_roles" ADD CONSTRAINT "lumibase_user_roles_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_roles" ADD CONSTRAINT "lumibase_user_roles_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_roles" ADD CONSTRAINT "lumibase_user_roles_role_id_lumibase_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."lumibase_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_consents" ADD CONSTRAINT "lumibase_user_consents_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_user_consents" ADD CONSTRAINT "lumibase_user_consents_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_email_suppressions" ADD CONSTRAINT "lumibase_email_suppressions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_processing_restrictions" ADD CONSTRAINT "lumibase_processing_restrictions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_processing_restrictions" ADD CONSTRAINT "lumibase_processing_restrictions_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_activity" ADD CONSTRAINT "lumibase_activity_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_activity" ADD CONSTRAINT "lumibase_activity_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_collections" ADD CONSTRAINT "lumibase_collections_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD CONSTRAINT "lumibase_content_versions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD CONSTRAINT "lumibase_content_versions_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD CONSTRAINT "lumibase_content_versions_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_dashboards" ADD CONSTRAINT "lumibase_dashboards_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_fields" ADD CONSTRAINT "lumibase_fields_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_fields" ADD CONSTRAINT "lumibase_fields_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ADD CONSTRAINT "lumibase_flow_runs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_flow_runs" ADD CONSTRAINT "lumibase_flow_runs_flow_id_lumibase_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."lumibase_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_flows" ADD CONSTRAINT "lumibase_flows_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "lumibase_items_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "lumibase_items_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "lumibase_items_user_created_lumibase_users_id_fk" FOREIGN KEY ("user_created") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "lumibase_items_user_updated_lumibase_users_id_fk" FOREIGN KEY ("user_updated") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_materialized_collections" ADD CONSTRAINT "lumibase_materialized_collections_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_operations" ADD CONSTRAINT "lumibase_operations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_operations" ADD CONSTRAINT "lumibase_operations_flow_id_lumibase_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."lumibase_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_pages" ADD CONSTRAINT "lumibase_pages_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_panels" ADD CONSTRAINT "lumibase_panels_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_panels" ADD CONSTRAINT "lumibase_panels_dashboard_id_lumibase_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."lumibase_dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_relations" ADD CONSTRAINT "lumibase_relations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_release_items" ADD CONSTRAINT "lumibase_release_items_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_release_items" ADD CONSTRAINT "lumibase_release_items_release_id_lumibase_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."lumibase_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_release_items" ADD CONSTRAINT "lumibase_release_items_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_release_items" ADD CONSTRAINT "lumibase_release_items_revision_id_lumibase_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."lumibase_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_releases" ADD CONSTRAINT "lumibase_releases_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_releases" ADD CONSTRAINT "lumibase_releases_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD CONSTRAINT "lumibase_revisions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD CONSTRAINT "lumibase_revisions_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD CONSTRAINT "lumibase_revisions_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD CONSTRAINT "lumibase_revisions_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD CONSTRAINT "lumibase_revisions_created_by_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_email_layouts" ADD CONSTRAINT "lumibase_email_layouts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_email_templates" ADD CONSTRAINT "lumibase_email_templates_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_email_templates" ADD CONSTRAINT "lumibase_email_templates_layout_id_lumibase_email_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."lumibase_email_layouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD CONSTRAINT "lumibase_extensions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD CONSTRAINT "lumibase_extensions_installed_by_lumibase_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD CONSTRAINT "lumibase_files_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD CONSTRAINT "lumibase_files_folder_lumibase_folders_id_fk" FOREIGN KEY ("folder") REFERENCES "public"."lumibase_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_files" ADD CONSTRAINT "lumibase_files_uploaded_by_lumibase_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."lumibase_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_folders" ADD CONSTRAINT "lumibase_folders_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_glossary" ADD CONSTRAINT "lumibase_glossary_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_presets" ADD CONSTRAINT "lumibase_presets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_presets" ADD CONSTRAINT "lumibase_presets_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_push_subscriptions" ADD CONSTRAINT "lumibase_push_subscriptions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_push_subscriptions" ADD CONSTRAINT "lumibase_push_subscriptions_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_settings" ADD CONSTRAINT "lumibase_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_memory" ADD CONSTRAINT "lumibase_translation_memory_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translations" ADD CONSTRAINT "lumibase_translations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_webhooks" ADD CONSTRAINT "lumibase_webhooks_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_approvals" ADD CONSTRAINT "lumibase_agent_approvals_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_approvals" ADD CONSTRAINT "lumibase_agent_approvals_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_approvals" ADD CONSTRAINT "lumibase_agent_approvals_legacy_approval_id_lumibase_ai_approvals_id_fk" FOREIGN KEY ("legacy_approval_id") REFERENCES "public"."lumibase_ai_approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_approvals" ADD CONSTRAINT "lumibase_agent_approvals_decided_by_lumibase_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_approvals" ADD CONSTRAINT "lumibase_agent_approvals_approver_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("approver_run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_artifacts" ADD CONSTRAINT "lumibase_agent_artifacts_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_artifacts" ADD CONSTRAINT "lumibase_agent_artifacts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_evaluations" ADD CONSTRAINT "lumibase_agent_evaluations_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_evaluations" ADD CONSTRAINT "lumibase_agent_evaluations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_evaluations" ADD CONSTRAINT "lumibase_agent_evaluations_artifact_id_lumibase_agent_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."lumibase_agent_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_goals" ADD CONSTRAINT "lumibase_agent_goals_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_goals" ADD CONSTRAINT "lumibase_agent_goals_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_goals" ADD CONSTRAINT "lumibase_agent_goals_parent_goal_id_lumibase_agent_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "public"."lumibase_agent_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_memory" ADD CONSTRAINT "lumibase_agent_memory_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_permissions" ADD CONSTRAINT "lumibase_agent_permissions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_plans" ADD CONSTRAINT "lumibase_agent_plans_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_plans" ADD CONSTRAINT "lumibase_agent_plans_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_plans" ADD CONSTRAINT "lumibase_agent_plans_approved_by_lumibase_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_runs" ADD CONSTRAINT "lumibase_agent_runs_goal_id_lumibase_agent_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."lumibase_agent_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_runs" ADD CONSTRAINT "lumibase_agent_runs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_tool_calls" ADD CONSTRAINT "lumibase_agent_tool_calls_run_id_lumibase_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lumibase_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_tool_calls" ADD CONSTRAINT "lumibase_agent_tool_calls_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_tools" ADD CONSTRAINT "lumibase_agent_tools_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_approvals" ADD CONSTRAINT "lumibase_ai_approvals_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_approvals" ADD CONSTRAINT "lumibase_ai_approvals_decided_by_lumibase_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_conversations" ADD CONSTRAINT "lumibase_ai_conversations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_conversations" ADD CONSTRAINT "lumibase_ai_conversations_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_embeddings" ADD CONSTRAINT "lumibase_ai_embeddings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_messages" ADD CONSTRAINT "lumibase_ai_messages_conversation_id_lumibase_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."lumibase_ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_admin_backup_codes" ADD CONSTRAINT "lumibase_admin_backup_codes_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_audit_log" ADD CONSTRAINT "lumibase_audit_log_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_login_attempts" ADD CONSTRAINT "lumibase_login_attempts_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_login_baselines" ADD CONSTRAINT "lumibase_login_baselines_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_deployments" ADD CONSTRAINT "lumibase_cdc_deployments_pipeline_id_lumibase_cdc_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."lumibase_cdc_pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_deployments" ADD CONSTRAINT "lumibase_cdc_deployments_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_pipeline_health" ADD CONSTRAINT "lumibase_cdc_pipeline_health_pipeline_id_lumibase_cdc_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."lumibase_cdc_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_pipelines" ADD CONSTRAINT "lumibase_cdc_pipelines_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_autonomy_grants" ADD CONSTRAINT "lumibase_agent_autonomy_grants_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_autonomy_grants" ADD CONSTRAINT "lumibase_agent_autonomy_grants_granted_by_lumibase_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_freezes" ADD CONSTRAINT "lumibase_agent_freezes_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_freezes" ADD CONSTRAINT "lumibase_agent_freezes_frozen_by_lumibase_users_id_fk" FOREIGN KEY ("frozen_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_freezes" ADD CONSTRAINT "lumibase_agent_freezes_lifted_by_lumibase_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_incidents" ADD CONSTRAINT "lumibase_agent_incidents_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_incidents" ADD CONSTRAINT "lumibase_agent_incidents_resolved_by_lumibase_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_roles" ADD CONSTRAINT "lumibase_agent_roles_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_constitutions" ADD CONSTRAINT "lumibase_constitutions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_constitutions" ADD CONSTRAINT "lumibase_constitutions_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_drifts" ADD CONSTRAINT "lumibase_content_drifts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_drifts" ADD CONSTRAINT "lumibase_content_drifts_intent_id_lumibase_content_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."lumibase_content_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_drifts" ADD CONSTRAINT "lumibase_content_drifts_goal_id_lumibase_agent_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."lumibase_agent_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_intents" ADD CONSTRAINT "lumibase_content_intents_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_intents" ADD CONSTRAINT "lumibase_content_intents_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_firebase_sync_log" ADD CONSTRAINT "lumibase_firebase_sync_log_pipeline_id_lumibase_firebase_sync_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."lumibase_firebase_sync_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_firebase_sync_log" ADD CONSTRAINT "lumibase_firebase_sync_log_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_firebase_sync_pipelines" ADD CONSTRAINT "lumibase_firebase_sync_pipelines_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_reviews" ADD CONSTRAINT "lumibase_content_reviews_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_reviews" ADD CONSTRAINT "lumibase_content_reviews_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_reviews" ADD CONSTRAINT "lumibase_content_reviews_requested_by_lumibase_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_reviews" ADD CONSTRAINT "lumibase_content_reviews_decided_by_lumibase_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_encryption_keys" ADD CONSTRAINT "lumibase_encryption_keys_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_erasure_requests" ADD CONSTRAINT "lumibase_erasure_requests_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_erasure_requests" ADD CONSTRAINT "lumibase_erasure_requests_requested_by_lumibase_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_erasure_requests" ADD CONSTRAINT "lumibase_erasure_requests_confirmed_by_lumibase_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_field_access_log" ADD CONSTRAINT "lumibase_field_access_log_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_deployment_targets" ADD CONSTRAINT "lumibase_deployment_targets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_deployments" ADD CONSTRAINT "lumibase_deployments_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_deployments" ADD CONSTRAINT "lumibase_deployments_target_id_lumibase_deployment_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."lumibase_deployment_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_auth_external_issuers" ADD CONSTRAINT "lumibase_auth_external_issuers_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "lumibase_notifications" USING btree ("recipient","status");--> statement-breakpoint
CREATE INDEX "notifications_site_idx" ON "lumibase_notifications" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "teams_site_idx" ON "lumibase_teams" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "user_sites_site_idx" ON "lumibase_user_sites" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_unique" ON "lumibase_users" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_is_bootstrap_unique" ON "lumibase_users" USING btree ("is_bootstrap") WHERE "lumibase_users"."is_bootstrap" = true;--> statement-breakpoint
CREATE INDEX "api_key_policies_site_policy_idx" ON "lumibase_api_key_policies" USING btree ("site_id","policy_id");--> statement-breakpoint
CREATE INDEX "api_key_roles_site_role_idx" ON "lumibase_api_key_roles" USING btree ("site_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_token_hash_unique" ON "lumibase_api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_keys_site_prefix_idx" ON "lumibase_api_keys" USING btree ("site_id","prefix");--> statement-breakpoint
CREATE INDEX "api_keys_site_active_idx" ON "lumibase_api_keys" USING btree ("site_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "lumibase_api_keys" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "permissions_policy_idx" ON "lumibase_permissions" USING btree ("policy_id","collection","action");--> statement-breakpoint
CREATE INDEX "permissions_site_collection_idx" ON "lumibase_permissions" USING btree ("site_id","collection");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_policy_collection_action_unique" ON "lumibase_permissions" USING btree ("policy_id","collection","action");--> statement-breakpoint
CREATE INDEX "policies_site_idx" ON "lumibase_policies" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_site_key_unique" ON "lumibase_policies" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_site_name_unique" ON "lumibase_roles" USING btree ("site_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_site_key_unique" ON "lumibase_roles" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_site_system_key_unique" ON "lumibase_roles" USING btree ("site_id","system_key");--> statement-breakpoint
CREATE INDEX "roles_parent_idx" ON "lumibase_roles" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "scim_tokens_site_hash_idx" ON "lumibase_scim_tokens" USING btree ("site_id","token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_hash_unique" ON "lumibase_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "shares_site_collection_item_idx" ON "lumibase_shares" USING btree ("site_id","collection","item_id");--> statement-breakpoint
CREATE INDEX "shares_site_role_idx" ON "lumibase_shares" USING btree ("site_id","role_id");--> statement-breakpoint
CREATE INDEX "shares_site_revoked_idx" ON "lumibase_shares" USING btree ("site_id","revoked_at");--> statement-breakpoint
CREATE INDEX "user_roles_site_role_idx" ON "lumibase_user_roles" USING btree ("site_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_consents_user_type_unique" ON "lumibase_user_consents" USING btree ("site_id","user_id","consent_type");--> statement-breakpoint
CREATE INDEX "user_consents_site_idx" ON "lumibase_user_consents" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "user_consents_user_idx" ON "lumibase_user_consents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_site_email_unique" ON "lumibase_email_suppressions" USING btree ("site_id","email_lower");--> statement-breakpoint
CREATE INDEX "email_suppressions_site_idx" ON "lumibase_email_suppressions" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_restrictions_site_user_unique" ON "lumibase_processing_restrictions" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE INDEX "processing_restrictions_site_idx" ON "lumibase_processing_restrictions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "activity_site_created_idx" ON "lumibase_activity" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "lumibase_activity" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_site_name_unique" ON "lumibase_collections" USING btree ("site_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_key_unique" ON "lumibase_content_versions" USING btree ("site_id","collection_id","item_id","key");--> statement-breakpoint
CREATE INDEX "content_versions_item_idx" ON "lumibase_content_versions" USING btree ("site_id","item_id");--> statement-breakpoint
CREATE INDEX "dashboards_site_idx" ON "lumibase_dashboards" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_collection_name_unique" ON "lumibase_fields" USING btree ("collection_id","name");--> statement-breakpoint
CREATE INDEX "fields_site_idx" ON "lumibase_fields" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "flow_runs_flow_idx" ON "lumibase_flow_runs" USING btree ("flow_id","started_at");--> statement-breakpoint
CREATE INDEX "flow_runs_status_idx" ON "lumibase_flow_runs" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "flows_site_idx" ON "lumibase_flows" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "flows_next_run_idx" ON "lumibase_flows" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "items_collection_status_idx" ON "lumibase_items" USING btree ("site_id","collection_id","status");--> statement-breakpoint
CREATE INDEX "items_data_gin_idx" ON "lumibase_items" USING gin ("data") WHERE "lumibase_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "items_site_idx" ON "lumibase_items" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "items_publish_due_idx" ON "lumibase_items" USING btree ("site_id","status","publish_at");--> statement-breakpoint
CREATE INDEX "items_unpublish_due_idx" ON "lumibase_items" USING btree ("site_id","status","unpublish_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mc_site_collection_unique" ON "lumibase_materialized_collections" USING btree ("site_id","collection","target");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_flow_key_unique" ON "lumibase_operations" USING btree ("flow_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_site_slug_unique" ON "lumibase_pages" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "panels_site_dashboard_idx" ON "lumibase_panels" USING btree ("site_id","dashboard_id");--> statement-breakpoint
CREATE INDEX "relations_site_idx" ON "lumibase_relations" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "relations_many_idx" ON "lumibase_relations" USING btree ("many_collection","many_field");--> statement-breakpoint
CREATE UNIQUE INDEX "release_items_release_item_unique" ON "lumibase_release_items" USING btree ("release_id","collection","item_id");--> statement-breakpoint
CREATE INDEX "release_items_release_idx" ON "lumibase_release_items" USING btree ("site_id","release_id");--> statement-breakpoint
CREATE INDEX "releases_site_status_idx" ON "lumibase_releases" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "releases_publish_due_idx" ON "lumibase_releases" USING btree ("site_id","status","publish_at");--> statement-breakpoint
CREATE INDEX "revisions_item_idx" ON "lumibase_revisions" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "revisions_staged_idx" ON "lumibase_revisions" USING btree ("site_id","auto_commit_at") WHERE "lumibase_revisions"."staged" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "email_layouts_site_key_unique" ON "lumibase_email_layouts" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_site_key_unique" ON "lumibase_email_templates" USING btree ("site_id","key");--> statement-breakpoint
CREATE INDEX "extensions_site_name_idx" ON "lumibase_extensions" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX "extensions_site_key_idx" ON "lumibase_extensions" USING btree ("site_id","key");--> statement-breakpoint
CREATE INDEX "extensions_publisher_idx" ON "lumibase_extensions" USING btree ("publisher","published_at");--> statement-breakpoint
CREATE INDEX "extensions_marketplace_slug_idx" ON "lumibase_extensions" USING btree ("marketplace_slug");--> statement-breakpoint
CREATE INDEX "files_site_idx" ON "lumibase_files" USING btree ("site_id","folder");--> statement-breakpoint
CREATE INDEX "folders_site_idx" ON "lumibase_folders" USING btree ("site_id","parent");--> statement-breakpoint
CREATE INDEX "glossary_site_pair_idx" ON "lumibase_glossary" USING btree ("site_id","source_lang","target_lang");--> statement-breakpoint
CREATE INDEX "glossary_term_idx" ON "lumibase_glossary" USING btree ("site_id","term");--> statement-breakpoint
CREATE INDEX "presets_site_collection_idx" ON "lumibase_presets" USING btree ("site_id","collection");--> statement-breakpoint
CREATE INDEX "presets_scope_idx" ON "lumibase_presets" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_site_endpoint_idx" ON "lumibase_push_subscriptions" USING btree ("site_id","endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_site_user_idx" ON "lumibase_push_subscriptions" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_site_key_unique" ON "lumibase_settings" USING btree ("site_id","key");--> statement-breakpoint
CREATE INDEX "tm_site_pair_idx" ON "lumibase_translation_memory" USING btree ("site_id","source_lang","target_lang");--> statement-breakpoint
CREATE INDEX "tm_context_idx" ON "lumibase_translation_memory" USING btree ("site_id","context");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_unique" ON "lumibase_translations" USING btree ("site_id","language","namespace","key");--> statement-breakpoint
CREATE INDEX "webhooks_site_idx" ON "lumibase_webhooks" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_approvals_site_status_idx" ON "lumibase_agent_approvals" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_approvals_run_created_idx" ON "lumibase_agent_approvals" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_approvals_subject_idx" ON "lumibase_agent_approvals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "agent_approvals_veto_due_idx" ON "lumibase_agent_approvals" USING btree ("site_id","auto_commit_at") WHERE "lumibase_agent_approvals"."kind" = 'veto' and "lumibase_agent_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_artifacts_site_status_idx" ON "lumibase_agent_artifacts" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_artifacts_run_created_idx" ON "lumibase_agent_artifacts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_artifacts_hash_idx" ON "lumibase_agent_artifacts" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "agent_evaluations_site_status_idx" ON "lumibase_agent_evaluations" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_evaluations_artifact_idx" ON "lumibase_agent_evaluations" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_evaluations_run_created_idx" ON "lumibase_agent_evaluations" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_goals_site_status_idx" ON "lumibase_agent_goals" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_goals_site_created_idx" ON "lumibase_agent_goals" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_goals_site_parent_idx" ON "lumibase_agent_goals" USING btree ("site_id","parent_goal_id");--> statement-breakpoint
CREATE INDEX "agent_goals_site_origin_idx" ON "lumibase_agent_goals" USING btree ("site_id","origin");--> statement-breakpoint
CREATE INDEX "agent_memory_site_scope_idx" ON "lumibase_agent_memory" USING btree ("site_id","scope","scope_id");--> statement-breakpoint
CREATE INDEX "agent_memory_site_source_idx" ON "lumibase_agent_memory" USING btree ("site_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "agent_permissions_site_agent_idx" ON "lumibase_agent_permissions" USING btree ("site_id","agent_name");--> statement-breakpoint
CREATE INDEX "agent_permissions_site_principal_idx" ON "lumibase_agent_permissions" USING btree ("site_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "agent_plans_run_created_idx" ON "lumibase_agent_plans" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_plans_site_status_idx" ON "lumibase_agent_plans" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_site_status_idx" ON "lumibase_agent_runs" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_goal_created_idx" ON "lumibase_agent_runs" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_run_created_idx" ON "lumibase_agent_tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_site_status_idx" ON "lumibase_agent_tool_calls" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_site_tool_idx" ON "lumibase_agent_tool_calls" USING btree ("site_id","tool_name");--> statement-breakpoint
CREATE INDEX "agent_tools_site_name_idx" ON "lumibase_agent_tools" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX "agent_tools_site_enabled_idx" ON "lumibase_agent_tools" USING btree ("site_id","enabled");--> statement-breakpoint
CREATE INDEX "ai_approvals_site_status_idx" ON "lumibase_ai_approvals" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "ai_conversations_site_user_idx" ON "lumibase_ai_conversations" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_embeddings_site_collection_idx" ON "lumibase_ai_embeddings" USING btree ("site_id","collection");--> statement-breakpoint
CREATE INDEX "ai_embeddings_item_idx" ON "lumibase_ai_embeddings" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "lumibase_ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_backup_codes_user_unused_idx" ON "lumibase_admin_backup_codes" USING btree ("user_id") WHERE "lumibase_admin_backup_codes"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_site_ts_idx" ON "lumibase_audit_log" USING btree ("site_id","timestamp");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "lumibase_audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_log_event_idx" ON "lumibase_audit_log" USING btree ("event","timestamp");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "lumibase_audit_log" USING btree ("actor_email","timestamp");--> statement-breakpoint
CREATE INDEX "login_attempts_email_window_idx" ON "lumibase_login_attempts" USING btree ("email_lower","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_window_idx" ON "lumibase_login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "system_state_admin_path_unique" ON "lumibase_system_state" USING btree ("admin_path");--> statement-breakpoint
CREATE INDEX "cdc_deployments_site_idx" ON "lumibase_cdc_deployments" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "cdc_health_pipeline_time_idx" ON "lumibase_cdc_pipeline_health" USING btree ("pipeline_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cdc_pipelines_site_name_unique" ON "lumibase_cdc_pipelines" USING btree ("site_id","pipeline_name");--> statement-breakpoint
CREATE INDEX "cdc_pipelines_site_status_idx" ON "lumibase_cdc_pipelines" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_autonomy_site_role_cap_unique" ON "lumibase_agent_autonomy_grants" USING btree ("site_id","agent_role","capability");--> statement-breakpoint
CREATE INDEX "agent_autonomy_site_role_idx" ON "lumibase_agent_autonomy_grants" USING btree ("site_id","agent_role");--> statement-breakpoint
CREATE INDEX "agent_freezes_site_active_idx" ON "lumibase_agent_freezes" USING btree ("site_id","lifted_at");--> statement-breakpoint
CREATE INDEX "agent_freezes_site_scope_idx" ON "lumibase_agent_freezes" USING btree ("site_id","scope","target_role");--> statement-breakpoint
CREATE INDEX "agent_incidents_site_created_idx" ON "lumibase_agent_incidents" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_incidents_site_role_idx" ON "lumibase_agent_incidents" USING btree ("site_id","agent_role");--> statement-breakpoint
CREATE INDEX "agent_incidents_site_open_idx" ON "lumibase_agent_incidents" USING btree ("site_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_site_name_unique" ON "lumibase_agent_roles" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX "agent_roles_site_enabled_idx" ON "lumibase_agent_roles" USING btree ("site_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "constitutions_site_version_unique" ON "lumibase_constitutions" USING btree ("site_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "constitutions_site_active_unique" ON "lumibase_constitutions" USING btree ("site_id") WHERE "lumibase_constitutions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "constitutions_site_status_idx" ON "lumibase_constitutions" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "content_drifts_site_fingerprint_unique" ON "lumibase_content_drifts" USING btree ("site_id","fingerprint");--> statement-breakpoint
CREATE INDEX "content_drifts_site_intent_status_idx" ON "lumibase_content_drifts" USING btree ("site_id","intent_id","status");--> statement-breakpoint
CREATE INDEX "content_drifts_site_item_idx" ON "lumibase_content_drifts" USING btree ("site_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_intents_site_name_unique" ON "lumibase_content_intents" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX "content_intents_site_status_idx" ON "lumibase_content_intents" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "content_intents_site_collection_idx" ON "lumibase_content_intents" USING btree ("site_id","collection");--> statement-breakpoint
CREATE INDEX "lumibase_firebase_sync_log_pipeline_time_idx" ON "lumibase_firebase_sync_log" USING btree ("pipeline_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lumibase_firebase_sync_site_name_unique" ON "lumibase_firebase_sync_pipelines" USING btree ("site_id","name");--> statement-breakpoint
CREATE INDEX "lumibase_firebase_sync_site_status_idx" ON "lumibase_firebase_sync_pipelines" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "content_reviews_site_status_idx" ON "lumibase_content_reviews" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "content_reviews_assigned_idx" ON "lumibase_content_reviews" USING btree ("site_id","assigned_to");--> statement-breakpoint
CREATE UNIQUE INDEX "encryption_keys_site_key_unique" ON "lumibase_encryption_keys" USING btree ("site_id","key_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_site_status_idx" ON "lumibase_erasure_requests" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "field_access_log_site_ts_idx" ON "lumibase_field_access_log" USING btree ("site_id","timestamp");--> statement-breakpoint
CREATE INDEX "field_access_log_actor_ts_idx" ON "lumibase_field_access_log" USING btree ("actor","timestamp");--> statement-breakpoint
CREATE INDEX "deployment_targets_site_idx" ON "lumibase_deployment_targets" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "deployment_targets_site_provider_idx" ON "lumibase_deployment_targets" USING btree ("site_id","provider");--> statement-breakpoint
CREATE INDEX "deployments_site_target_idx" ON "lumibase_deployments" USING btree ("site_id","target_id");--> statement-breakpoint
CREATE INDEX "deployments_site_status_idx" ON "lumibase_deployments" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "deployments_provider_deploy_idx" ON "lumibase_deployments" USING btree ("provider_deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_external_issuers_site_issuer_unique" ON "lumibase_auth_external_issuers" USING btree ("site_id","issuer");--> statement-breakpoint
CREATE INDEX "auth_external_issuers_site_enabled_idx" ON "lumibase_auth_external_issuers" USING btree ("site_id","enabled");