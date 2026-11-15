/**
 * principal-raw.ts — what an external-issuer JWT may put on `AuthPrincipal.raw`.
 *
 * `raw` is shared with LumiBase's own credentials, and several guards read
 * markers from it that only LumiBase itself mints:
 *
 *   - `dev`          dev-auth principal → admin bypass in site-membership,
 *                    studio-access, control-plane guard, site-admin, CDC, and
 *                    the `dev` capability ref (`principalRefFromAuth`)
 *   - `isBootstrap`  bootstrap-admin provenance (`site-admin-access`)
 *   - `tfaVerified`  LumiBase's own 2FA step-up (`isSessionTfaVerified`)
 *   - `anonymous`, `apiKey`, `mcpOAuth`  principal-kind markers
 *
 * A trusted external issuer is trusted for identity, not for those. Copying its
 * payload verbatim let a claim such as `"dev": true` reach every one of those
 * guards — exploitable only together with a mapped role id spelled `admin`, but
 * the guards must not depend on that. The issuer's own claims (including OIDC
 * MFA signals `amr` / `acr`, and `mfa` / `mfaVerified`, which an IdP may
 * legitimately assert) are kept, so claim-driven features keep working.
 */

export const RESERVED_PRINCIPAL_CLAIMS: readonly string[] = [
  'dev',
  'isBootstrap',
  'tfaVerified',
  'anonymous',
  'apiKey',
  'mcpOAuth',
];

/** The verified payload minus the LumiBase-reserved markers, as a fresh object. */
export function externalPrincipalRaw(payload: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RESERVED_PRINCIPAL_CLAIMS.includes(key)) out[key] = value;
  }
  return out;
}
