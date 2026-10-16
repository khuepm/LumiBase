---
version: 5
lastUpdated: 2026-10-16T15:41:59.749Z
sourceLang: vi
translatedFrom: vi
sourceHash: 29ddc3e668a10c9d
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-16T15:41:59.749Z
codeVerifiedHash: 29ddc3e668a10c9d
codeVerifiedClaims: 8
---

<!-- check-parity: allow code-fences -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-15T22:27:56.523Z. See commit history for rationale. -->

# Cloudflare Access & Custom JWT Authentication

This document explains in detail how to configure — and how the system behaves for — authentication and authorization combining **Cloudflare Access** (for Admin/Studio) with **Custom JWT** (for frontend end-users).

---

## 1. Architecture overview

LumiBase uses a hybrid authentication model:
1. **Studio admins (the management surface)**: protected by Cloudflare Zero Trust (Access). On successful sign-in, Cloudflare Access automatically attaches a JWT assertion in the `Cf-Access-Jwt-Assertion` header.
2. **Frontend end-users**: register and sign in directly through the Hono CMS API's custom auth endpoints (`/auth/register`, `/auth/login`). These return a Custom JWT signed with the Web Crypto API (HS256).
3. **Bypassing Cloudflare Access for API calls**: frontend clients calling the API need to bypass Cloudflare Access using a **Cloudflare Service Token** (sent in the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers).

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Studio Admin
    actor User as Frontend User
    participant CF as Cloudflare Access (WAF)
    participant BE as CMS Worker (Hono)
    participant DB as PostgreSQL (Drizzle)

    Note over Admin, CF: ── Admin (Studio) authentication flow ──
    Admin->>CF: Open Studio / call an Admin API
    CF->>CF: Require SSO/MFA sign-in
    CF->>BE: Forward request + Cf-Access-Jwt-Assertion
    BE->>BE: Verify the CF JWT against the JWKS certificates
    BE->>DB: Look the user up by email and check permissions
    BE-->>Admin: Allow Studio access / execute the API call

    Note over User, CF: ── End-user (frontend) authentication flow ──
    User->>CF: Register / sign in / fetch content (with Client-Id/Secret)
    CF->>CF: Bypass Cloudflare Access via the Service Token
    CF->>BE: Forward the request to the CMS API
    alt Register / sign in (public)
        BE->>DB: Verify the password (PBKDF2) / mint a Custom JWT
        BE-->>User: Return the Custom JWT token
    else Permission-gated API call (private)
        User->>BE: Send Authorization: Bearer <Custom-JWT>
        BE->>BE: Verify the Custom JWT against JWT_SECRET
        BE->>DB: RLS query scoped by user_id & site_id
        BE-->>User: Return the data
    end
```

---

## 2. Authentication

### A. Configuring Cloudflare Access (for Studio & the Admin API)

To configure Cloudflare Access in the Cloudflare dashboard:

1. **Create an application**:
   - Go to **Zero Trust** → **Access** → **Applications**.
   - Click **Add an application** → choose **Self-hosted**.
   - Configure the domains:
     - Application URL: `studio.yourdomain.com` (your Studio hostname).
     - Application URL: `api.yourdomain.com/api/v1/admin/*` (the dangerous admin endpoints).
2. **Configure identity providers**:
   - Add providers such as Google Workspace, GitHub, Microsoft Azure AD, or Email OTP.
3. **Configure a policy**:
   - Choose who may access it (for example, only emails on your company domain `@yourcompany.com`).
4. **Collect the configuration values for the CMS Worker**:
   - **Audience (AUD)**: taken from **Application Audience (AUD)** in the application's settings in Cloudflare.
   - **Certificates URL**: Cloudflare's public JWKS address, used to verify the token signature:
     `https://<your-team-domain>.cloudflareaccess.com/cdn-cgi/access/certs`
   - Put these into `.dev.vars` (for local runs) or into Cloudflare environment variables:
     - `CF_ACCESS_CERTS_URL`
     - `CF_ACCESS_AUDIENCE`

### B. Configuring a bypass Service Token (for frontend clients)

So your frontend applications can call the CMS API (fetch articles, register a user, …) without Cloudflare Access intercepting them with a login page:

1. **Create a Service Token**:
   - In Cloudflare Zero Trust → **Access** → **Service Tokens** → choose **Create Service Token**.
   - Name it (e.g. `lumibase-frontend-api`) and copy the `Client ID` and `Client Secret`.
2. **Add a policy for the public endpoints**:
   - Open the application protecting your API.
   - Create a new policy with the action **Bypass**.
   - Under **Rules** → choose **Include** → choose **Service Token** → select the `lumibase-frontend-api` token you just created.
3. **Call the API from the frontend**:
   - Every request your frontend sends to the CMS API must carry these two headers:
     ```http
     CF-Access-Client-Id: <client-id>
     CF-Access-Client-Secret: <client-secret>
     ```

### C. Local development (dev mock)
When running locally (with `LUMIBASE_DEV_AUTH="true"` in `.dev.vars`), you can skip Cloudflare Access entirely by sending a mock token:
- Send the header `Authorization: Bearer dev:<email>:<role>` (e.g. `Authorization: Bearer dev:admin@lumibase.dev:admin`).
- The CMS Worker resolves it to an admin user on the site being operated on.

---

## 3. Authorization

Once a request passes through the `withAuth()` middleware, the system sets a uniform authentication object on the context at `c.get('auth')` (the `AuthPrincipal` interface):

```typescript
export interface AuthPrincipal {
  externalId?: string; // For admins (holds sub/email from Cloudflare Access)
  userId?: string;     // For frontend users (holds the underlying PostgreSQL id)
  email?: string;      // Identifying email
  roles?: string[];    // Role list (e.g. ['admin'] or ['member'])
  isFrontendUser?: boolean; // true when signed in via Custom JWT
}
```

### A. Baseline authorization (role-based access control)
How a user's permissions are checked:
1. **Admin (isFrontendUser = false)**:
   - The system matches the `externalId` (or email) from the Cloudflare Access JWT against the `users` table in Postgres.
   - If the user does not exist in the DB yet, it is registered automatically (JIT provisioning) with status `active`.
   - Roles/policies are configured directly from the Studio admin pages.
2. **End-users (isFrontendUser = true)**:
   - The register and sign-in APIs are exempt from the auth check via path bypasses:
     `/api/v1/auth/register` and `/api/v1/auth/login`.
   - All other APIs verify the Custom JWT signature (`JWT_SECRET`).
   - By default, after a successful sign-in an end-user is assigned the `member` role bound to the request's `site_id`.

### B. Multi-tenancy security (row-level security)
LumiBase designs a database-layer multi-tenancy backstop, using Hono's `withRls()` middleware together with PostgreSQL row-level security (RLS). The primary gate today is the application-level `site_id` filter; the RLS backstop is not yet effective on the request path (B130):

1. **Resolve the site**: the `withTenant()` middleware reads the `X-Lumi-Site` header to get the current `siteId`.
2. **Set the DB context**: `withRls()` runs the statement below as a standalone autocommit statement. Because `is_local = true`, the setting ends as soon as that statement finishes, so it does not apply to the request's later statements (B130):
   ```sql
   SELECT set_config('app.site_id', '<siteId>', true);
   ```
3. **RLS policy**: Postgres filters each query through the policy pair that `packages/database/migrations/rls-policies.sql` creates on each table, based on the `app.site_id` of the transaction that runs it. Today only code paths that use `runSiteTransaction` set `app.site_id` on the connection that runs their queries:
   ```sql
   CREATE POLICY site_isolation ON <table_name>
     AS RESTRICTIVE FOR ALL TO PUBLIC
     USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());
   CREATE POLICY site_isolation_permit ON <table_name>
     AS PERMISSIVE FOR ALL TO PUBLIC
     USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());
   ```
   `app_site_id()` returns `NULLIF(current_setting('app.site_id', true), '')`, so with no scope set no row is visible and every write is refused.
   *Once B130 lands, this will mean a user or admin of one site cannot read or write another site's data at all — even if some code is buggy and omits its WHERE clause. Until then, do not connect the app with a NOBYPASSRLS role after applying `rls-policies.sql`: request-path reads and background jobs would see no rows.*
