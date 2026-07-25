---
version: 1
lastUpdated: 2026-07-05T10:56:37.201Z
sourceLang: en
contentHash: 63a2d80683a535b3
---

# ADR-007: Logto for Authentication

**Date:** 2024-02-01
**Status:** Accepted

## Context

LumiBase needs an authentication solution supporting:

1. **Multi-tenancy** — different sites have different users; an `admin@siteA.com` must not be able to access Site B
2. **OIDC/OAuth2** — standard protocols for SSO integration with enterprise identity providers (Google Workspace, Microsoft Entra, Okta)
3. **Invitation flow** — admins invite users by email; users set their password via a signed link
4. **Self-hosted option** — for Docker deployments, auth cannot depend on a third-party SaaS that may be unavailable
5. **Lightweight** — should not require a heavy auth server in Cloudflare Workers mode

Options considered:
- **Supabase Auth** — PostgreSQL-coupled, not easily multi-tenant per-site
- **Auth.js (NextAuth)** — React/Next.js focused, not suitable for a standalone Hono API
- **Keycloak** — very heavy, Java-based, not Docker-friendly for small self-hosted setups
- **Logto** — OIDC-native, multi-tenant, open-source, Docker-deployable, minimal footprint
- **Custom JWT** — maximum control but significant implementation burden (MFA, PKCE, token rotation, etc.)

## Decision

Use **Logto** as the primary authentication provider.

Integration pattern:
- Logto issues JWTs with standard OIDC claims
- `apps/cms` validates JWTs at the edge using JWKS (`/.well-known/jwks.json` from Logto), cached via `CacheProvider`
- User metadata (site assignments, roles, capabilities) is stored in LumiBase's own `users` table, linked by Logto subject (`sub`) claim
- The `withAuth()` middleware validates the JWT and loads the LumiBase user row into context

For Docker self-hosted: Logto runs as a Docker container alongside LumiBase CMS.
For Cloudflare Workers: Logto Cloud (or a self-hosted Logto instance) is used.

SCIM 2.0 provisioning (for enterprise SSO) uses a separate `SCIM_TOKEN` — not the Logto JWT pipeline.

## Consequences

**Positive:**
- Standard OIDC JWT validation — no Logto SDK required in the hot path; just JWKS + JWT verification
- Multi-tenant organization support via Logto Organizations feature
- Open source under Apache 2.0 — self-hostable without vendor lock-in
- Handles secure token rotation, refresh tokens, and PKCE out of the box

**Negative:**
- An additional service to deploy and maintain (Logto container in Docker mode)
- Logto's multi-tenant model may not perfectly map to LumiBase's site-level isolation — requires careful configuration of Organizations
- Migration from another auth provider requires re-issuing all tokens

**Neutral:**
- `LOGTO_ENDPOINT` and `LOGTO_APP_ID` are required environment variables for both deployment modes
