import {
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Deployment integrations (spec: `.kiro/specs/deployment-integrations`).
 *
 * Two site-isolated domain tables that let operators trigger / monitor /
 * debug deployments on external hosting providers (Vercel, Netlify) from
 * inside LumiBase. Provider API tokens are stored encrypted via the runtime
 * KeyProvider (AES-GCM) — the plaintext never lands in a column. All access
 * is `siteId`-scoped (RLS + application filter), same as every other domain
 * table.
 *
 * ID convention: `nanoid()` for both (domain tables), via the shared helper.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/**
 * `deployment_targets` — a connection to one project on one Provider.
 *
 * `tokenCiphertext` holds the Provider API token encrypted with the active
 * KeyProvider key; `tokenKeyId` records which key version wrapped it so the
 * token survives key rotation (decrypt with a retired key, re-encrypt with
 * the active one). Neither column is ever returned by the API.
 */
export const deploymentTargets = pgTable(
  'deployment_targets',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `vercel` | `netlify`. Resolved against the provider registry. */
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    /** Vercel project id / Netlify site id. */
    projectId: text('project_id').notNull(),
    /** AES-GCM ciphertext envelope of the Provider token (base64). */
    tokenCiphertext: text('token_ciphertext').notNull(),
    /** Key version that wrapped the token (KeyProvider keyId). */
    tokenKeyId: text('token_key_id').notNull(),
    /** Default branch to deploy when none is given. */
    defaultBranch: text('default_branch'),
    /** Production URL surfaced in the UI. */
    productionUrl: text('production_url'),
    /** `active` | `inactive`. */
    status: text('status').default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteIdx: index('deployment_targets_site_idx').on(t.siteId),
    siteProviderIdx: index('deployment_targets_site_provider_idx').on(t.siteId, t.provider),
  }),
);

/**
 * `deployments` — one build/deploy run on a Provider, with normalized status
 * and a masked log excerpt for in-Studio debugging.
 *
 * `providerDeploymentId` is the id assigned by the Provider; the status
 * poller and the inbound webhook both match on it for idempotent updates.
 * `status` is the LumiBase-normalized state (see provider adapters for the
 * per-provider mapping).
 */
export const deployments = pgTable(
  'deployments',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => deploymentTargets.id, { onDelete: 'cascade' }),
    /** Denormalized from the target for cheap filtering. */
    provider: text('provider').notNull(),
    /** Deployment id on the Provider side (null until assigned). */
    providerDeploymentId: text('provider_deployment_id'),
    /** `queued` | `building` | `ready` | `error` | `canceled`. */
    status: text('status').notNull(),
    branch: text('branch'),
    commitSha: text('commit_sha'),
    commitMessage: text('commit_message'),
    /** Preview / production URL once available. */
    url: text('url'),
    /** `userId` (manual), `runId` (agent) or null. */
    triggeredBy: text('triggered_by'),
    /** `manual` | `auto` | `agent`. */
    triggerSource: text('trigger_source').notNull(),
    errorMessage: text('error_message'),
    /** Tail of the build log, secrets masked, size-capped. */
    logExcerpt: text('log_excerpt'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Set when a terminal status is reached. */
    completedAt: timestamp('completed_at'),
  },
  (t) => ({
    siteTargetIdx: index('deployments_site_target_idx').on(t.siteId, t.targetId),
    siteStatusIdx: index('deployments_site_status_idx').on(t.siteId, t.status),
    providerDeployIdx: index('deployments_provider_deploy_idx').on(t.providerDeploymentId),
  }),
);
