# Docs i18n Sync Log

Append-only history of automated EN ⇄ VI documentation syncs. Each run records language detection, preserved content and translation actions so no source content is silently lost.

## 2026-07-02T01:08:12.465Z — mode `apply` (effective `preserve-only`)

Engine: `claude` · API key: absent · files scanned: 119

Summary — up-to-date: 15, translated: 0, preserved: 0, conflicts: 1, planned: 103

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-07-02T01-08-12-576Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `README.md` | vi → en | source changed since last sync |
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/deployment-integrations.md` | en → vi | missing vi translation |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/push-notifications.md` | en → vi | missing vi translation |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | en → vi | source changed since last sync |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `mcp/index.md` | vi → en | en duplicates vi content; replace en with English translation |
| `mcp/mcp-application-analysis.md` | vi → en | en duplicates vi content; replace en with English translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `tutorials/index.md` | en → vi | source changed since last sync |
| `tutorials/nextjs-quickstart.md` | en → vi | source changed since last sync |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-29T16:16:44.819Z — mode `apply` (effective `preserve-only`)

Engine: `claude` · API key: absent · files scanned: 118

Summary — up-to-date: 15, translated: 0, preserved: 0, conflicts: 1, planned: 102

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-29T16-16-44-932Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `README.md` | vi → en | source changed since last sync |
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/deployment-integrations.md` | en → vi | missing vi translation |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | en → vi | source changed since last sync |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `mcp/index.md` | vi → en | en duplicates vi content; replace en with English translation |
| `mcp/mcp-application-analysis.md` | vi → en | en duplicates vi content; replace en with English translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `tutorials/index.md` | en → vi | source changed since last sync |
| `tutorials/nextjs-quickstart.md` | en → vi | source changed since last sync |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-29T14:53:06.933Z — mode `apply` (effective `preserve-only`)

Engine: `claude` · API key: absent · files scanned: 117

Summary — up-to-date: 15, translated: 0, preserved: 0, conflicts: 1, planned: 101

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-29T14-53-07-042Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `README.md` | vi → en | source changed since last sync |
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | en → vi | source changed since last sync |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `mcp/index.md` | vi → en | en duplicates vi content; replace en with English translation |
| `mcp/mcp-application-analysis.md` | vi → en | en duplicates vi content; replace en with English translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `tutorials/index.md` | en → vi | source changed since last sync |
| `tutorials/nextjs-quickstart.md` | en → vi | source changed since last sync |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-29T14:36:29.825Z — mode `apply` (effective `preserve-only`)

Engine: `deepl` · API key: absent · files scanned: 117

Summary — up-to-date: 0, translated: 0, preserved: 0, conflicts: 19, planned: 98

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | preserved → `.i18n/preserved/README.md.2026-06-29T14-36-29-919Z.bak.md` |
| `ai-native-vision.md` | vi | vi | conflict | preserved → `.i18n/preserved/ai-native-vision.md.2026-06-29T14-36-29-920Z.bak.md` |
| `architecture/overview.md` | vi | vi | conflict | preserved → `.i18n/preserved/architecture/overview.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/ai-copilot.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/ai-copilot.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/email-service.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/email-service.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/extensions-system.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/extensions-system.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/firebase-sync.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/firebase-sync.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/flows-automation.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/flows-automation.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/marketplace.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/marketplace.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/observability.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/observability.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/permissions-rbac.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/permissions-rbac.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/runtime-abstraction.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/runtime-abstraction.md.2026-06-29T14-36-29-920Z.bak.md` |
| `features/system-config.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/system-config.md.2026-06-29T14-36-29-921Z.bak.md` |
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-29T14-36-29-921Z.bak.md` |
| `mcp/index.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/index.md.2026-06-29T14-36-29-921Z.bak.md` |
| `mcp/mcp-application-analysis.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/mcp-application-analysis.md.2026-06-29T14-36-29-921Z.bak.md` |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/consumer-sdk.md.2026-06-29T14-36-29-921Z.bak.md` |
| `roadmap/tasks.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/tasks.md.2026-06-29T14-36-29-921Z.bak.md` |
| `vision-and-positioning.md` | vi | vi | conflict | preserved → `.i18n/preserved/vision-and-positioning.md.2026-06-29T14-36-29-921Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | en → vi | source changed since last sync |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `tutorials/index.md` | en → vi | source changed since last sync |
| `tutorials/nextjs-quickstart.md` | en → vi | source changed since last sync |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-29T10:08:23.068Z — mode `apply` (effective `preserve-only`)

Engine: `deepl` · API key: absent · files scanned: 117

Summary — up-to-date: 0, translated: 0, preserved: 0, conflicts: 19, planned: 98

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | preserved → `.i18n/preserved/README.md.2026-06-29T10-08-23-164Z.bak.md` |
| `ai-native-vision.md` | vi | vi | conflict | preserved → `.i18n/preserved/ai-native-vision.md.2026-06-29T10-08-23-164Z.bak.md` |
| `architecture/overview.md` | vi | vi | conflict | preserved → `.i18n/preserved/architecture/overview.md.2026-06-29T10-08-23-164Z.bak.md` |
| `features/ai-copilot.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/ai-copilot.md.2026-06-29T10-08-23-164Z.bak.md` |
| `features/email-service.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/email-service.md.2026-06-29T10-08-23-164Z.bak.md` |
| `features/extensions-system.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/extensions-system.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/firebase-sync.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/firebase-sync.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/flows-automation.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/flows-automation.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/marketplace.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/marketplace.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/observability.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/observability.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/permissions-rbac.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/permissions-rbac.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/runtime-abstraction.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/runtime-abstraction.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/system-config.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/system-config.md.2026-06-29T10-08-23-165Z.bak.md` |
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-29T10-08-23-165Z.bak.md` |
| `mcp/index.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/index.md.2026-06-29T10-08-23-165Z.bak.md` |
| `mcp/mcp-application-analysis.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/mcp-application-analysis.md.2026-06-29T10-08-23-165Z.bak.md` |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/consumer-sdk.md.2026-06-29T10-08-23-165Z.bak.md` |
| `roadmap/tasks.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/tasks.md.2026-06-29T10-08-23-165Z.bak.md` |
| `vision-and-positioning.md` | vi | vi | conflict | preserved → `.i18n/preserved/vision-and-positioning.md.2026-06-29T10-08-23-166Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `tutorials/index.md` | en → vi | source changed since last sync |
| `tutorials/nextjs-quickstart.md` | en → vi | source changed since last sync |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-27T03:31:57.080Z — mode `apply` (effective `preserve-only`)

Engine: `deepl` · API key: absent · files scanned: 115

Summary — up-to-date: 0, translated: 0, preserved: 0, conflicts: 19, planned: 96

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | preserved → `.i18n/preserved/README.md.2026-06-27T03-31-57-185Z.bak.md` |
| `ai-native-vision.md` | vi | vi | conflict | preserved → `.i18n/preserved/ai-native-vision.md.2026-06-27T03-31-57-185Z.bak.md` |
| `architecture/overview.md` | vi | vi | conflict | preserved → `.i18n/preserved/architecture/overview.md.2026-06-27T03-31-57-185Z.bak.md` |
| `features/ai-copilot.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/ai-copilot.md.2026-06-27T03-31-57-185Z.bak.md` |
| `features/email-service.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/email-service.md.2026-06-27T03-31-57-185Z.bak.md` |
| `features/extensions-system.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/extensions-system.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/firebase-sync.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/firebase-sync.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/flows-automation.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/flows-automation.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/marketplace.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/marketplace.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/observability.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/observability.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/permissions-rbac.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/permissions-rbac.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/runtime-abstraction.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/runtime-abstraction.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/system-config.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/system-config.md.2026-06-27T03-31-57-186Z.bak.md` |
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-27T03-31-57-186Z.bak.md` |
| `mcp/index.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/index.md.2026-06-27T03-31-57-186Z.bak.md` |
| `mcp/mcp-application-analysis.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/mcp-application-analysis.md.2026-06-27T03-31-57-186Z.bak.md` |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/consumer-sdk.md.2026-06-27T03-31-57-186Z.bak.md` |
| `roadmap/tasks.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/tasks.md.2026-06-27T03-31-57-186Z.bak.md` |
| `vision-and-positioning.md` | vi | vi | conflict | preserved → `.i18n/preserved/vision-and-positioning.md.2026-06-27T03-31-57-186Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-26T09:56:21.027Z — mode `apply` (effective `preserve-only`)

Engine: `deepl` · API key: absent · files scanned: 115

Summary — up-to-date: 0, translated: 0, preserved: 0, conflicts: 19, planned: 96

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | preserved → `.i18n/preserved/README.md.2026-06-26T09-56-21-123Z.bak.md` |
| `ai-native-vision.md` | vi | vi | conflict | preserved → `.i18n/preserved/ai-native-vision.md.2026-06-26T09-56-21-123Z.bak.md` |
| `architecture/overview.md` | vi | vi | conflict | preserved → `.i18n/preserved/architecture/overview.md.2026-06-26T09-56-21-123Z.bak.md` |
| `features/ai-copilot.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/ai-copilot.md.2026-06-26T09-56-21-123Z.bak.md` |
| `features/email-service.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/email-service.md.2026-06-26T09-56-21-123Z.bak.md` |
| `features/extensions-system.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/extensions-system.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/firebase-sync.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/firebase-sync.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/flows-automation.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/flows-automation.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/marketplace.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/marketplace.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/observability.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/observability.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/permissions-rbac.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/permissions-rbac.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/runtime-abstraction.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/runtime-abstraction.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/system-config.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/system-config.md.2026-06-26T09-56-21-124Z.bak.md` |
| `features/user-management.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/user-management.md.2026-06-26T09-56-21-124Z.bak.md` |
| `mcp/index.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/index.md.2026-06-26T09-56-21-124Z.bak.md` |
| `mcp/mcp-application-analysis.md` | vi | vi | conflict | preserved → `.i18n/preserved/mcp/mcp-application-analysis.md.2026-06-26T09-56-21-124Z.bak.md` |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/consumer-sdk.md.2026-06-26T09-56-21-124Z.bak.md` |
| `roadmap/tasks.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/tasks.md.2026-06-26T09-56-21-124Z.bak.md` |
| `vision-and-positioning.md` | vi | vi | conflict | preserved → `.i18n/preserved/vision-and-positioning.md.2026-06-26T09-56-21-125Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `compliance/README.md` | en → vi | source changed since last sync |
| `compliance/data-map.md` | en → vi | source changed since last sync |
| `compliance/data-residency.md` | en → vi | source changed since last sync |
| `compliance/dpa-template.md` | en → vi | source changed since last sync |
| `compliance/gap-analysis.md` | en → vi | source changed since last sync |
| `compliance/implementation-checklist.md` | en → vi | source changed since last sync |
| `compliance/market-eu-gdpr.md` | en → vi | source changed since last sync |
| `compliance/market-us.md` | en → vi | source changed since last sync |
| `compliance/market-vietnam.md` | en → vi | source changed since last sync |
| `compliance/provider-google-apple.md` | en → vi | source changed since last sync |
| `compliance/user-rights-catalog.md` | en → vi | source changed since last sync |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-22T11:37:06.122Z — mode `apply` (effective `preserve-only`)

Engine: `deepl` · API key: absent · files scanned: 104

Summary — up-to-date: 0, translated: 0, preserved: 5, conflicts: 13, planned: 91

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | preserved → `.i18n/preserved/README.md.2026-06-22T11-37-06-188Z.bak.md` |
| `ai-native-vision.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `architecture/overview.md` | vi | vi | conflict | preserved → `.i18n/preserved/architecture/overview.md.2026-06-22T11-37-06-291Z.bak.md` |
| `features/ai-copilot.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/ai-copilot.md.2026-06-22T11-37-06-291Z.bak.md` |
| `features/email-service.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `features/extensions-system.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/extensions-system.md.2026-06-22T11-37-06-291Z.bak.md` |
| `features/firebase-sync.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `features/flows-automation.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/flows-automation.md.2026-06-22T11-37-06-292Z.bak.md` |
| `features/marketplace.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/marketplace.md.2026-06-22T11-37-06-292Z.bak.md` |
| `features/observability.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/observability.md.2026-06-22T11-37-06-292Z.bak.md` |
| `features/permissions-rbac.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/permissions-rbac.md.2026-06-22T11-37-06-292Z.bak.md` |
| `features/runtime-abstraction.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/runtime-abstraction.md.2026-06-22T11-37-06-292Z.bak.md` |
| `features/system-config.md` | vi | vi | conflict | preserved → `.i18n/preserved/features/system-config.md.2026-06-22T11-37-06-292Z.bak.md` |
| `mcp/index.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `mcp/mcp-application-analysis.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/consumer-sdk.md.2026-06-22T11-37-06-292Z.bak.md` |
| `roadmap/tasks.md` | vi | vi | conflict | preserved → `.i18n/preserved/roadmap/tasks.md.2026-06-22T11-37-06-293Z.bak.md` |
| `vision-and-positioning.md` | vi | vi | conflict | preserved → `.i18n/preserved/vision-and-positioning.md.2026-06-22T11-37-06-293Z.bak.md` |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-native-vision.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/email-service.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/firebase-sync.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/user-management.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `mcp/index.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `mcp/mcp-application-analysis.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/dependency-overrides.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

## 2026-06-21T07:01:34.702Z — mode `plan` (effective `plan`)

Engine: `deepl` · API key: absent · files scanned: 101

Summary — up-to-date: 0, translated: 0, preserved: 0, conflicts: 0, planned: 101

### Language mismatches / preservation

| File | en lang | vi lang | Action | Note |
|------|---------|---------|--------|------|
| `README.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `ai-native-vision.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `architecture/overview.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/ai-copilot.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/email-service.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `features/extensions-system.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/firebase-sync.md` | vi | — | preserve-and-translate | en-file-is-vietnamese; no vi counterpart |
| `features/flows-automation.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/marketplace.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/observability.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/permissions-rbac.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/runtime-abstraction.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `features/system-config.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `roadmap/consumer-sdk.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `roadmap/tasks.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |
| `vision-and-positioning.md` | vi | vi | conflict | en file holds Vietnamese that differs from existing docs/vi |

### Pending / performed translations

| File | Direction | Reason |
|------|-----------|--------|
| `agent-setup/claude-code.md` | en → vi | missing vi translation |
| `agent-setup/codex.md` | en → vi | missing vi translation |
| `agent-setup/cursor.md` | en → vi | missing vi translation |
| `agent-setup/github-copilot.md` | en → vi | missing vi translation |
| `agent-setup/index.md` | en → vi | missing vi translation |
| `agent-setup/prompt.md` | en → vi | missing vi translation |
| `agent-setup/windsurf.md` | en → vi | missing vi translation |
| `ai-native-vision.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `ai-skills.md` | en → vi | source changed since last sync |
| `aio/AIO-AUDIT-REPORT.md` | en → vi | missing vi translation |
| `aio/README.md` | en → vi | missing vi translation |
| `api/graphql-api-spec.md` | en → vi | missing vi translation |
| `api/hono-api-spec.md` | en → vi | source changed since last sync |
| `architecture/decisions/adr-001-nanoid-over-uuid.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-002-runtime-abstraction.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-005-hono-over-express.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-006-drizzle-over-prisma.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-007-logto-for-auth.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-008-policy-dsl-json.md` | en → vi | missing vi translation |
| `architecture/decisions/adr-009-graphql-yoga.md` | en → vi | missing vi translation |
| `architecture/decisions/index.md` | en → vi | missing vi translation |
| `architecture/page-hydration.md` | en → vi | source changed since last sync |
| `architecture/physical-collections.md` | en → vi | missing vi translation |
| `architecture/realtime-websocket-implementation.md` | en → vi | source changed since last sync |
| `cdc/README.md` | en → vi | missing vi translation |
| `cdc/architecture.md` | en → vi | missing vi translation |
| `cdc/deployment-cloudflare-workers.md` | en → vi | missing vi translation |
| `cdc/deployment-docker-compose.md` | en → vi | missing vi translation |
| `cdc/environment-variables.md` | en → vi | missing vi translation |
| `cdc/setup-airbyte.md` | en → vi | missing vi translation |
| `cdc/setup-debezium-kafka.md` | en → vi | missing vi translation |
| `cdc/setup-materialized-engine.md` | en → vi | missing vi translation |
| `cdc/troubleshooting.md` | en → vi | missing vi translation |
| `contributing/code-style.md` | en → vi | missing vi translation |
| `contributing/docs-i18n.md` | en → vi | missing vi translation |
| `contributing/extension-dev.md` | en → vi | missing vi translation |
| `contributing/index.md` | en → vi | missing vi translation |
| `contributing/testing.md` | en → vi | missing vi translation |
| `data-model.md` | en → vi | source changed since last sync |
| `deployment/cloudflare-pages-ci.md` | en → vi | missing vi translation |
| `deployment/cloudflare.md` | en → vi | source changed since last sync |
| `deployment/docker.md` | en → vi | source changed since last sync |
| `deployment/environment-variables.md` | en → vi | source changed since last sync |
| `deployment/local-development.md` | en → vi | source changed since last sync |
| `deployment/overview.md` | en → vi | source changed since last sync |
| `deployment/private-admin-path.md` | en → vi | missing vi translation |
| `deployment/shared-domain-environments.md` | en → vi | missing vi translation |
| `devpost-xprize-submission.md` | en → vi | missing vi translation |
| `features/access-manifest-v1.md` | en → vi | source changed since last sync |
| `features/agent-harness-layer.md` | en → vi | source changed since last sync |
| `features/ai-first-specification.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/bookmarks-presets.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/cloudflare-auth.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/collections-builder.md` | en → vi | source changed since last sync |
| `features/directus-data-model-parity-tasks.md` | en → vi | missing vi translation |
| `features/display-templates.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/email-service.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `features/field-types-and-config.md` | en → vi | source changed since last sync |
| `features/firebase-sync.md` | vi → en | en-file-is-vietnamese; no vi counterpart |
| `features/marketplace-ui.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/materialized-collections.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/permission-builder-directus-investigation.md` | vi → en | missing en translation |
| `features/permission-service-compose-audit.md` | en → vi | source changed since last sync |
| `features/raw-data-editing.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/role-policy-flag-migration.md` | en → vi | source changed since last sync |
| `features/scim-provisioning.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/search.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/system-collections-access.md` | en → vi | source changed since last sync |
| `features/translation-memory.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/translations-i18n.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/typegen.md` | en → vi | source changed since last sync |
| `features/user-management.md` | vi → en | en duplicates vi content; replace en with English translation |
| `features/websockets-realtime.md` | en → vi | source changed since last sync |
| `getting-started.md` | en → vi | missing vi translation |
| `operations/upgrades.md` | en → vi | source changed since last sync |
| `release/npm-publishing.md` | vi → en | missing en translation |
| `roadmap/agent-harness-implementation.md` | vi → en | missing en translation |
| `roadmap/phase-d1-users.md` | en → vi | source changed since last sync |
| `roadmap/post-ga-walkthrough.md` | vi → en | en duplicates vi content; replace en with English translation |
| `roadmap/studio-content-slices.md` | vi → en | en duplicates vi content; replace en with English translation |
| `sdk/index.md` | en → vi | missing vi translation |
| `sdk/javascript.md` | en → vi | missing vi translation |
| `sdk/typegen.md` | en → vi | missing vi translation |
| `security/idor-testing.md` | en → vi | missing vi translation |
| `security/runtime-security-guards-plan.md` | vi → en | missing en translation |
| `ui/studio-ui-spec.md` | vi → en | en duplicates vi content; replace en with English translation |

---

