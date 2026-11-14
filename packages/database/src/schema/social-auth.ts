import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

/**
 * External login identities linked to an account (#736, designed in #794).
 *
 * One row per `(issuer, subject)` pair — "Google account 1234", "Apple user
 * 000123.abc", "GitHub user 42" — pointing at the single global `users` row it
 * signs in. Like `users` (and `user_totp_credentials`) this is an
 * **identity-global** table: a person's Google account is the same account on
 * every site, so it carries no `site_id` and is not under RLS. What a login
 * may do on a given site is still decided by the `user_sites` membership.
 *
 * `emailAtLink` records the address the provider asserted when the link was
 * made — evidence for an audit trail, never a lookup key (the provider may
 * change it later; the stable key is `subject`).
 *
 * Migration 0031 backfills every existing `users.external_id` here under the
 * legacy issuer {@link LEGACY_EXTERNAL_ID_ISSUER}, so the table is a complete
 * list of an account's non-password login methods.
 */
export const userIdentities = pgTable(
  'lumibase_user_identities',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** OIDC `iss` (or the provider's canonical origin for plain OAuth, e.g. GitHub). */
    issuer: text('issuer').notNull(),
    /** Stable subject id at that issuer (`sub`, or GitHub's numeric user id). */
    subject: text('subject').notNull(),
    /** Email the provider asserted when the identity was linked; nullable. */
    emailAtLink: text('email_at_link'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    issuerSubjectUnique: uniqueIndex('user_identities_issuer_subject_unique').on(t.issuer, t.subject),
    userIdx: index('user_identities_user_idx').on(t.userId),
  }),
);

/** Issuer recorded for identities backfilled from `users.external_id`. */
export const LEGACY_EXTERNAL_ID_ISSUER = 'urn:lumibase:external-id';

/**
 * Per-site social login provider configuration (#736).
 *
 * Public values (client id, Apple team/key id, redirect allow-list) are plain
 * columns. The two secrets — an OAuth client secret (Google, GitHub) or an
 * Apple `.p8` signing key — are stored ONLY as KeyProvider AES-GCM envelopes
 * bound to `(site, provider)` by AAD, never plaintext, and never returned by
 * the API.
 */
export const socialAuthProviders = pgTable(
  'lumibase_social_auth_providers',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `google` | `apple` | `github`. */
    provider: text('provider').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    /** OAuth client id (Apple: the Services ID). */
    clientId: text('client_id').notNull(),
    /** Envelope of the OAuth client secret (Google, GitHub); null for Apple. */
    clientSecretCiphertext: text('client_secret_ciphertext'),
    /** Apple developer team id (signs the client-secret JWT). */
    appleTeamId: text('apple_team_id'),
    /** Apple key id (`kid` of the `.p8` key). */
    appleKeyId: text('apple_key_id'),
    /** Envelope of the Apple `.p8` private key (PKCS#8 PEM). */
    applePrivateKeyCiphertext: text('apple_private_key_ciphertext'),
    /**
     * Exact URIs the frontend may ask to be sent back to after login/link.
     * Anything else is refused before the provider is contacted (no open
     * redirect).
     */
    allowedRedirectUris: jsonb('allowed_redirect_uris').$type<string[]>().default([]).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteProviderUnique: uniqueIndex('social_auth_providers_site_provider_unique').on(t.siteId, t.provider),
  }),
);
