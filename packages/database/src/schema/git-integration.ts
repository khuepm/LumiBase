/**
 * Git Integration schema (GitHub / GitLab).
 *
 * Per-tenant connections to source repositories plus cached pull-request /
 * CI state, a raw webhook-event log (replay-able), ephemeral preview
 * environments, and commit↔content provenance.
 *
 * Conventions (CLAUDE.md non-negotiables):
 *   - `id` via nanoid(); never serial.
 *   - Every table carries `site_id` and every query filters by it.
 *   - Tokens / webhook secrets are stored ENCRYPTED (see
 *     apps/cms/src/modules/git-integration/crypto.ts) — never plaintext.
 *
 * See `.kiro/specs/git-integration/design.md` §3 for the data model.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/** A connection between one site and one repository on a Git provider. */
export const gitIntegrations = pgTable(
  'git_integrations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** 'github' | 'gitlab'. */
    provider: text('provider').notNull(),
    /** e.g. 'org/repo'. */
    repoFullName: text('repo_full_name').notNull(),
    displayName: text('display_name').notNull(),
    /** 'app' (installation token) | 'pat' (PAT / OAuth token). */
    authMethod: text('auth_method').notNull(),
    /** Provider App installation id (app auth only). */
    installationId: text('installation_id'),
    /** Encrypted PAT / OAuth token (CryptoService ciphertext). Nullable for app auth. */
    encryptedToken: text('encrypted_token'),
    /** Encrypted webhook secret used to verify inbound webhook signatures. */
    webhookSecretEnc: text('webhook_secret_enc'),
    /** 'connected' | 'error' | 'disconnected'. */
    status: text('status').default('disconnected').notNull(),
    statusReason: text('status_reason'),
    /** Scopes granted to the token (display / least-privilege auditing). */
    scopes: jsonb('scopes').default([]).notNull(),
    /** Validation / gitops / preview policy for this integration. */
    syncConfig: jsonb('sync_config').default({}).notNull(),
    lastSyncAt: timestamp('last_sync_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteRepoUnique: uniqueIndex('git_integrations_site_repo_unique').on(
      t.siteId,
      t.provider,
      t.repoFullName,
    ),
    siteStatusIdx: index('git_integrations_site_status_idx').on(
      t.siteId,
      t.status,
    ),
  }),
);

/** Cached pull/merge request state per integration. */
export const gitPullRequests = pgTable(
  'git_pull_requests',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => gitIntegrations.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** 'open' | 'closed' | 'merged'. */
    state: text('state').notNull(),
    /** 'unknown' | 'pending' | 'success' | 'failure'. */
    ciStatus: text('ci_status').default('unknown').notNull(),
    mergeable: boolean('mergeable'),
    headSha: text('head_sha').notNull(),
    author: text('author'),
    previewUrl: text('preview_url'),
    /** Last raw provider payload for this PR (debug / forward-compat). */
    raw: jsonb('raw').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    integrationNumberUnique: uniqueIndex('git_prs_integration_number_unique').on(
      t.integrationId,
      t.number,
    ),
    siteStateIdx: index('git_prs_site_state_idx').on(t.siteId, t.state),
  }),
);

/** CI run + jobs (+ stored-log reference) per integration. */
export const gitCiRuns = pgTable(
  'git_ci_runs',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => gitIntegrations.id, { onDelete: 'cascade' }),
    prId: text('pr_id').references(() => gitPullRequests.id, {
      onDelete: 'cascade',
    }),
    /** Provider's run/pipeline id. */
    providerRunId: text('provider_run_id').notNull(),
    /** 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled'. */
    status: text('status').notNull(),
    /** [{ name, status, startedAt, completedAt, durationMs }]. */
    jobs: jsonb('jobs').default([]).notNull(),
    durationMs: integer('duration_ms'),
    /** runtime.storage blob key for the stored log (null until fetched). */
    logRef: text('log_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    integrationRunUnique: uniqueIndex('git_ci_runs_integration_run_unique').on(
      t.integrationId,
      t.providerRunId,
    ),
    sitePrIdx: index('git_ci_runs_site_pr_idx').on(t.siteId, t.prId),
  }),
);

/** Raw inbound webhook events — replay-able, idempotent by delivery id. */
export const gitWebhookEvents = pgTable(
  'git_webhook_events',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id').references(() => gitIntegrations.id, {
      onDelete: 'cascade',
    }),
    provider: text('provider').notNull(),
    /** Idempotency key from the provider (GitHub X-GitHub-Delivery, etc.). */
    deliveryId: text('delivery_id'),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    processed: boolean('processed').default(false).notNull(),
    processedAt: timestamp('processed_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => ({
    deliveryUnique: uniqueIndex('git_webhook_delivery_unique').on(
      t.provider,
      t.deliveryId,
    ),
    siteProcessedIdx: index('git_webhook_site_processed_idx').on(
      t.siteId,
      t.processed,
    ),
  }),
);

/** Ephemeral preview environment for a pull request. */
export const gitPreviewEnvs = pgTable(
  'git_preview_envs',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => gitIntegrations.id, { onDelete: 'cascade' }),
    prId: text('pr_id')
      .notNull()
      .references(() => gitPullRequests.id, { onDelete: 'cascade' }),
    /** Derived ephemeral site id (branch-scoped). */
    ephemeralSiteId: text('ephemeral_site_id').notNull(),
    /** 'pending' | 'ready' | 'updating' | 'destroyed' | 'error'. */
    status: text('status').default('pending').notNull(),
    url: text('url'),
    expiresAt: timestamp('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    prUnique: uniqueIndex('git_preview_pr_unique').on(t.prId),
  }),
);

/** Links a commit / PR to the content or schema change it produced. */
export const gitProvenance = pgTable(
  'git_provenance',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id').references(() => gitIntegrations.id, {
      onDelete: 'cascade',
    }),
    commitSha: text('commit_sha').notNull(),
    prNumber: integer('pr_number'),
    collection: text('collection'),
    itemId: text('item_id'),
    /** 'content' | 'schema' | 'intent'. */
    changeType: text('change_type').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteItemIdx: index('git_provenance_site_item_idx').on(
      t.siteId,
      t.collection,
      t.itemId,
    ),
  }),
);
