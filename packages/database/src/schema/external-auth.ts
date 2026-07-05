import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * External JWT authentication (spec: .kiro/specs/external-jwt-auth).
 *
 * A trusted external issuer (Okta, Entra, Auth0, Logto, Keycloak, …) per site.
 * Signatures are verified against the issuer's PUBLIC JWKS, so this table holds
 * NO secrets — only public configuration: the issuer URL, JWKS/discovery URL,
 * expected audience, an asymmetric-algorithm allowlist, and the claim→role
 * mapping. Multi-tenant by `site_id`; a given `iss` registered for site A is a
 * distinct, isolated trust from the same `iss` registered for site B.
 */
const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

export const authExternalIssuers = pgTable(
  'lumibase_auth_external_issuers',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Must match the JWT `iss` claim exactly. */
    issuer: text('issuer').notNull(),
    /** Direct JWKS endpoint; one of jwksUri / discoveryUrl is required. */
    jwksUri: text('jwks_uri'),
    /** OIDC `.well-known/openid-configuration` URL (jwks_uri derived from it). */
    discoveryUrl: text('discovery_url'),
    /** Expected `aud` — a string or array of strings. */
    audience: jsonb('audience').notNull(),
    /** Allowed signature algorithms — asymmetric only (no HS-family, no none). */
    algorithms: jsonb('algorithms').notNull(),
    /** `{ email, roles, siteId?, externalId? }` — claim path mapping. */
    claimMapping: jsonb('claim_mapping').notNull(),
    /** `{ "<external role value>": { roleId? | systemKey? } }`. Default-deny. */
    roleMapping: jsonb('role_mapping').default({}).notNull(),
    /** Fallback role when no claim role maps; null → reject with NO_ROLE_MAPPING. */
    defaultRoleId: text('default_role_id'),
    /** Create a user on first valid token if none matches the externalId. */
    jitProvisioning: boolean('jit_provisioning').default(false).notNull(),
    /** exp/nbf/iat tolerance; app caps at 300. */
    clockSkewSeconds: integer('clock_skew_seconds').default(60).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteIssuerUnique: uniqueIndex('auth_external_issuers_site_issuer_unique').on(t.siteId, t.issuer),
    siteEnabledIdx: index('auth_external_issuers_site_enabled_idx').on(t.siteId, t.enabled),
  }),
);
