import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Custom domains & free `*.lumibase.dev` subdomains (Enterprise feature).
 *
 * Each site can be reached through one or more hostnames:
 *   - `subdomain` — a free `<slug>.lumibase.dev` address, served immediately
 *     via the wildcard Worker route (no certificate provisioning needed).
 *   - `custom` — the operator's own domain (e.g. `cms.acme.com`), provisioned
 *     through Cloudflare for SaaS Custom Hostnames. The operator points a CNAME
 *     at the SaaS fallback origin and adds a TXT (DCV) record; Cloudflare issues
 *     and renews the TLS certificate automatically.
 *
 * The legacy `sites.domain` column is kept for backward-compat, but this table
 * is the source of truth for hostname → site resolution. The tenant middleware
 * resolves a request host via the KV map `site-host:<fqdn>` which is written
 * once a row reaches `status = 'active'`.
 *
 * All access is `siteId`-scoped (RLS + application filter), same as every other
 * domain table. ID convention: `nanoid()` (domain table).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const siteDomains = pgTable(
  'site_domains',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Fully-qualified hostname, lowercased (e.g. `cms.acme.com`). Globally unique. */
    hostname: text('hostname').notNull(),
    /** `subdomain` (free `*.lumibase.dev`) | `custom` (operator-owned). */
    kind: text('kind').notNull(),
    /** Exactly one primary hostname per site is used as the canonical URL. */
    isPrimary: boolean('is_primary').default(false).notNull(),
    /**
     * Provisioning lifecycle:
     *   `pending_dns` — created; waiting for the operator to add DNS records.
     *   `verifying`   — Cloudflare is validating DCV / issuing the certificate.
     *   `active`      — hostname + certificate live; routes traffic.
     *   `failed`      — provisioning error (see `statusReason`).
     * Free subdomains skip straight to `active`.
     */
    status: text('status').default('pending_dns').notNull(),
    /** Human-readable reason when `status = 'failed'` (or last CF error). */
    statusReason: text('status_reason'),
    /** Cloudflare for SaaS Custom Hostname id; null for free subdomains. */
    cfHostnameId: text('cf_hostname_id'),
    /** Mirror of Cloudflare `ssl.status` (`initializing` | `pending_validation` | `active` | …). */
    sslStatus: text('ssl_status'),
    /**
     * DNS records the operator must create, surfaced in the UI:
     * `{ records: [{ type: 'CNAME' | 'TXT', name, value, purpose }] }`.
     */
    verification: jsonb('verification').default({}).notNull(),
    /** When the hostname first reached `active`. */
    verifiedAt: timestamp('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    hostnameUnique: uniqueIndex('site_domains_hostname_unique').on(t.hostname),
    siteIdx: index('site_domains_site_idx').on(t.siteId),
  }),
);
