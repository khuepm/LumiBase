-- 0039_lumibase_prefix
-- Rename every LumiBase system table into the `lumibase_` namespace so that
-- any table WITHOUT that prefix is unambiguously user-created (or a `mat_*`
-- materialization). Data-preserving: ALTER TABLE RENAME keeps rows, indexes,
-- foreign keys and sequences intact; Postgres auto-updates FK definitions to
-- point at the renamed tables. Idempotent via IF EXISTS (safe on fresh installs
-- and partially-migrated databases alike).
--
-- NOTE: the out-of-band RLS script (packages/database/migrations/rls-policies.sql)
-- must be re-applied AFTER this migration; it targets the new lumibase_* names.

ALTER TABLE IF EXISTS "roles" RENAME TO "lumibase_roles";
--> statement-breakpoint
ALTER TABLE IF EXISTS "policies" RENAME TO "lumibase_policies";
--> statement-breakpoint
ALTER TABLE IF EXISTS "role_policies" RENAME TO "lumibase_role_policies";
--> statement-breakpoint
ALTER TABLE IF EXISTS "user_policies" RENAME TO "lumibase_user_policies";
--> statement-breakpoint
ALTER TABLE IF EXISTS "user_roles" RENAME TO "lumibase_user_roles";
--> statement-breakpoint
ALTER TABLE IF EXISTS "api_keys" RENAME TO "lumibase_api_keys";
--> statement-breakpoint
ALTER TABLE IF EXISTS "api_key_roles" RENAME TO "lumibase_api_key_roles";
--> statement-breakpoint
ALTER TABLE IF EXISTS "api_key_policies" RENAME TO "lumibase_api_key_policies";
--> statement-breakpoint
ALTER TABLE IF EXISTS "shares" RENAME TO "lumibase_shares";
--> statement-breakpoint
ALTER TABLE IF EXISTS "permissions" RENAME TO "lumibase_permissions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "scim_tokens" RENAME TO "lumibase_scim_tokens";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ai_approvals" RENAME TO "lumibase_ai_approvals";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ai_conversations" RENAME TO "lumibase_ai_conversations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ai_messages" RENAME TO "lumibase_ai_messages";
--> statement-breakpoint
ALTER TABLE IF EXISTS "ai_embeddings" RENAME TO "lumibase_ai_embeddings";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_goals" RENAME TO "lumibase_agent_goals";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_runs" RENAME TO "lumibase_agent_runs";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_plans" RENAME TO "lumibase_agent_plans";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_tools" RENAME TO "lumibase_agent_tools";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_permissions" RENAME TO "lumibase_agent_permissions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_tool_calls" RENAME TO "lumibase_agent_tool_calls";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_approvals" RENAME TO "lumibase_agent_approvals";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_artifacts" RENAME TO "lumibase_agent_artifacts";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_evaluations" RENAME TO "lumibase_agent_evaluations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_memory" RENAME TO "lumibase_agent_memory";
--> statement-breakpoint
ALTER TABLE IF EXISTS "cdc_pipelines" RENAME TO "lumibase_cdc_pipelines";
--> statement-breakpoint
ALTER TABLE IF EXISTS "cdc_pipeline_health" RENAME TO "lumibase_cdc_pipeline_health";
--> statement-breakpoint
ALTER TABLE IF EXISTS "cdc_deployments" RENAME TO "lumibase_cdc_deployments";
--> statement-breakpoint
ALTER TABLE IF EXISTS "pages" RENAME TO "lumibase_pages";
--> statement-breakpoint
ALTER TABLE IF EXISTS "collections" RENAME TO "lumibase_collections";
--> statement-breakpoint
ALTER TABLE IF EXISTS "fields" RENAME TO "lumibase_fields";
--> statement-breakpoint
ALTER TABLE IF EXISTS "relations" RENAME TO "lumibase_relations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "items" RENAME TO "lumibase_items";
--> statement-breakpoint
ALTER TABLE IF EXISTS "revisions" RENAME TO "lumibase_revisions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "activity" RENAME TO "lumibase_activity";
--> statement-breakpoint
ALTER TABLE IF EXISTS "flows" RENAME TO "lumibase_flows";
--> statement-breakpoint
ALTER TABLE IF EXISTS "flow_runs" RENAME TO "lumibase_flow_runs";
--> statement-breakpoint
ALTER TABLE IF EXISTS "operations" RENAME TO "lumibase_operations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "materialized_collections" RENAME TO "lumibase_materialized_collections";
--> statement-breakpoint
ALTER TABLE IF EXISTS "dashboards" RENAME TO "lumibase_dashboards";
--> statement-breakpoint
ALTER TABLE IF EXISTS "panels" RENAME TO "lumibase_panels";
--> statement-breakpoint
ALTER TABLE IF EXISTS "content_versions" RENAME TO "lumibase_content_versions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "email_suppressions" RENAME TO "lumibase_email_suppressions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "processing_restrictions" RENAME TO "lumibase_processing_restrictions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "user_consents" RENAME TO "lumibase_user_consents";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_autonomy_grants" RENAME TO "lumibase_agent_autonomy_grants";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_incidents" RENAME TO "lumibase_agent_incidents";
--> statement-breakpoint
ALTER TABLE IF EXISTS "content_intents" RENAME TO "lumibase_content_intents";
--> statement-breakpoint
ALTER TABLE IF EXISTS "content_drifts" RENAME TO "lumibase_content_drifts";
--> statement-breakpoint
ALTER TABLE IF EXISTS "constitutions" RENAME TO "lumibase_constitutions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_roles" RENAME TO "lumibase_agent_roles";
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_freezes" RENAME TO "lumibase_agent_freezes";
--> statement-breakpoint
ALTER TABLE IF EXISTS "sites" RENAME TO "lumibase_sites";
--> statement-breakpoint
ALTER TABLE IF EXISTS "users" RENAME TO "lumibase_users";
--> statement-breakpoint
ALTER TABLE IF EXISTS "user_sites" RENAME TO "lumibase_user_sites";
--> statement-breakpoint
ALTER TABLE IF EXISTS "teams" RENAME TO "lumibase_teams";
--> statement-breakpoint
ALTER TABLE IF EXISTS "team_members" RENAME TO "lumibase_team_members";
--> statement-breakpoint
ALTER TABLE IF EXISTS "notifications" RENAME TO "lumibase_notifications";
--> statement-breakpoint
ALTER TABLE IF EXISTS "deployment_targets" RENAME TO "lumibase_deployment_targets";
--> statement-breakpoint
ALTER TABLE IF EXISTS "deployments" RENAME TO "lumibase_deployments";
--> statement-breakpoint
ALTER TABLE IF EXISTS "folders" RENAME TO "lumibase_folders";
--> statement-breakpoint
ALTER TABLE IF EXISTS "files" RENAME TO "lumibase_files";
--> statement-breakpoint
ALTER TABLE IF EXISTS "presets" RENAME TO "lumibase_presets";
--> statement-breakpoint
ALTER TABLE IF EXISTS "translations" RENAME TO "lumibase_translations";
--> statement-breakpoint
ALTER TABLE IF EXISTS "settings" RENAME TO "lumibase_settings";
--> statement-breakpoint
ALTER TABLE IF EXISTS "webhooks" RENAME TO "lumibase_webhooks";
--> statement-breakpoint
ALTER TABLE IF EXISTS "extensions" RENAME TO "lumibase_extensions";
--> statement-breakpoint
ALTER TABLE IF EXISTS "email_layouts" RENAME TO "lumibase_email_layouts";
--> statement-breakpoint
ALTER TABLE IF EXISTS "email_templates" RENAME TO "lumibase_email_templates";
--> statement-breakpoint
ALTER TABLE IF EXISTS "translation_memory" RENAME TO "lumibase_translation_memory";
--> statement-breakpoint
ALTER TABLE IF EXISTS "glossary" RENAME TO "lumibase_glossary";
--> statement-breakpoint
ALTER TABLE IF EXISTS "encryption_keys" RENAME TO "lumibase_encryption_keys";
--> statement-breakpoint
ALTER TABLE IF EXISTS "field_access_log" RENAME TO "lumibase_field_access_log";
--> statement-breakpoint
ALTER TABLE IF EXISTS "content_reviews" RENAME TO "lumibase_content_reviews";
--> statement-breakpoint
ALTER TABLE IF EXISTS "erasure_requests" RENAME TO "lumibase_erasure_requests";
--> statement-breakpoint
ALTER TABLE IF EXISTS "system_state" RENAME TO "lumibase_system_state";
--> statement-breakpoint
ALTER TABLE IF EXISTS "audit_log" RENAME TO "lumibase_audit_log";
--> statement-breakpoint
ALTER TABLE IF EXISTS "login_attempts" RENAME TO "lumibase_login_attempts";
--> statement-breakpoint
ALTER TABLE IF EXISTS "login_baselines" RENAME TO "lumibase_login_baselines";
--> statement-breakpoint
ALTER TABLE IF EXISTS "admin_backup_codes" RENAME TO "lumibase_admin_backup_codes";
