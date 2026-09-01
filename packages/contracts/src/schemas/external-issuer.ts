import { z } from 'zod';

/**
 * External JWT issuer configuration (spec: .kiro/specs/external-jwt-auth).
 *
 * Validates the public config for a trusted external IdP. Security-critical
 * choices encoded here:
 *  - `algorithms` is an ASYMMETRIC-only allowlist — `HS*` and `none` are not in
 *    the enum, preventing alg-confusion / symmetric-key attacks (T4).
 *  - `claimMapping` is `.strict()` so a typo'd claim path is rejected, not
 *    silently ignored.
 *  - `roleMapping` entries must carry a `roleId` or `systemKey` — there is no
 *    way to express "grant admin to everyone"; mapping is explicit (default-deny).
 */

/** Asymmetric algorithms only — NEVER HS256/HS384/HS512 or `none`. */
export const EXTERNAL_JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'] as const;
export const ExternalJwtAlgorithmSchema = z.enum(EXTERNAL_JWT_ALGORITHMS);

const ClaimMappingSchema = z
  .object({
    /** Claim path holding the user's email. */
    email: z.string().min(1),
    /** Claim path holding the role value(s) (string, array, or delimited). */
    roles: z.string().min(1),
    /** Optional claim holding the siteId; when set it must equal the request site. */
    siteId: z.string().min(1).optional(),
    /** Claim used as the stable external identity; defaults to `sub`. */
    externalId: z.string().min(1).default('sub'),
  })
  .strict();

const RoleMappingEntrySchema = z
  .object({
    roleId: z.string().min(1).optional(),
    systemKey: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.roleId) || Boolean(v.systemKey), {
    message: 'Each role mapping entry needs a roleId or a systemKey.',
  });

/** A URL that must be https (http://localhost allowed only in development). */
const trustedUrl = (allowLocalHttp: boolean) =>
  z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const url = new URL(u);
          if (url.protocol === 'https:') return true;
          return allowLocalHttp && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
        } catch {
          return false;
        }
      },
      { message: 'Issuer URLs must use https:// (http://localhost only in development).' },
    );

/**
 * Full external-issuer config. `allowLocalHttp` relaxes the https requirement
 * for local development; pass `true` only when `LUMIBASE_ENV=development`.
 */
const hasJwksSource = (v: { jwksUri?: string; discoveryUrl?: string }) =>
  Boolean(v.jwksUri) || Boolean(v.discoveryUrl);

/** Base object (no cross-field refine) so `.partial()` stays clean for PATCH. */
function makeBaseObject(allowLocalHttp: boolean) {
  const url = trustedUrl(allowLocalHttp);
  return z.object({
    issuer: url,
    jwksUri: url.optional(),
    discoveryUrl: url.optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    algorithms: z.array(ExternalJwtAlgorithmSchema).min(1),
    claimMapping: ClaimMappingSchema,
    roleMapping: z.record(z.string(), RoleMappingEntrySchema).default({}),
    defaultRoleId: z.string().min(1).nullable().optional(),
    jitProvisioning: z.boolean().default(false),
    clockSkewSeconds: z.number().int().min(0).max(300).default(60),
    enabled: z.boolean().default(true),
  });
}

/**
 * Full external-issuer config (create). `allowLocalHttp` relaxes the https
 * requirement for local development; pass `true` only when
 * `LUMIBASE_ENV=development`.
 */
export function makeExternalIssuerConfigSchema(allowLocalHttp = false) {
  return makeBaseObject(allowLocalHttp).refine(hasJwksSource, {
    message: 'Provide either jwksUri or discoveryUrl.',
    path: ['jwksUri'],
  });
}

/** PATCH payload (update) — every field optional, https posture configurable. */
export function makeExternalIssuerUpdateSchema(allowLocalHttp = false) {
  return makeBaseObject(allowLocalHttp).partial();
}

/** Default schemas (production posture: https required). */
export const ExternalIssuerConfigSchema = makeExternalIssuerConfigSchema(false);
export const ExternalIssuerUpdateSchema = makeExternalIssuerUpdateSchema(false);

export type ExternalIssuerConfig = z.infer<typeof ExternalIssuerConfigSchema>;
export type ExternalIssuerClaimMapping = z.infer<typeof ClaimMappingSchema>;
export type ExternalIssuerRoleMapping = Record<string, z.infer<typeof RoleMappingEntrySchema>>;
