# Task/Plan: Runtime security guards for LumiBase

## Goal

Establish a clear runtime security foundation before the AI Harness is allowed
to create or apply changes to the system. Each guard has a single
responsibility, its own name, and its own mount point in the pipeline so the
team can understand, review, and later enforce Harness usage of it.

## Task scope

1. **Control-plane access guard**
   - Block non-admin principals at system administration surfaces such as roles,
     policies, permissions, users, teams, settings, API keys, admin, and CDC.
   - Protect system tables/collections such as `lumibase_users`,
     `lumibase_roles`, `lumibase_permissions` from privilege-escalation
     operations.

2. **Security headers middleware**
   - Attach a default CSP to every response.
   - Enable `nosniff`, `DENY` frame, `no-referrer`, `Permissions-Policy`, COOP,
     and CORP to reduce XSS/CSS injection, clickjacking, and data leakage across
     the browser surface.

3. **File upload policy**
   - Forbid the public role from creating upload metadata **or pushing raw media
     bytes**.
   - Cap upload size via `FILE_UPLOAD_MAX_BYTES`, default 10 MiB — enforced on
     the client-declared `Content-Length` AND on the true body byte count for
     raw-byte surfaces (a lying/absent `Content-Length` cannot slip past).
   - Allow MIME types via `FILE_UPLOAD_ALLOWED_MIME_TYPES`, defaulting to common
     images, PDF, CSV, and text.
   - Cross-check the declared filename extension against the MIME type.
   - Content-sniff raw-byte uploads (magic bytes) so a declared image that is
     really an executable/other type is rejected; reject any executable
     signature (PE/ELF/Mach-O) outright.
   - Reject SVGs that embed script or active content (`<script>`, inline `on*=`
     handlers, `javascript:`, `<foreignObject>`, `<iframe>`/`<embed>`, and
     `<!DOCTYPE>`/`<!ENTITY>` XXE) — the "image with a shell in it" case.
   - **Covered upload surfaces:** `POST /api/v1/files` (metadata),
     `PUT /api/v1/files/upload/:key` (signed bytes), and
     `POST /api/v1/media/:key` (RBAC-authorized media bytes). The surface set is
     centralized in `classifyUploadSurface()` and pinned by the
     `classifies every known upload surface` regression test so a new
     byte-accepting route cannot be added without wiring it into the guard.

   **Configurable per site:** the size cap and MIME allowlist resolve
   `per-site DB config → env override → default` via
   `services/upload-policy-service.ts` (cached, fail-safe — falls back to
   env/default if the DB/cache are unavailable so the guard never fails open).
   The catalogue of selectable types lives in `@lumibase/shared/schemas`
   (`upload-policy.ts`) so the server allowlist and the Studio file picker share
   one source. Admins edit it at **Studio → Settings → Uploads**, backed by
   `GET/PUT /api/v1/uploads/config` (`GET` for any member to drive the picker's
   `accept`; `PUT` is `requireSiteAdmin`, persisted to the `settings` row keyed
   `upload_policy`, restricted to catalogued MIME types).

   **Serving hardening (`routes/media.ts`):** downloads are returned with
   `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, so a
   stored HTML/SVG object cannot be rendered (and its script executed) under the
   app origin when opened top-level. This composes with the global CSP
   (`script-src 'self'`, no `unsafe-inline`) as defense-in-depth. The storage
   adapters map the logical `contentType` onto the native R2 `httpMetadata` /
   S3 `ContentType` field so the served `Content-Type` round-trips correctly
   (previously it was written only to custom metadata and came back undefined).

4. **Outbound URL guard**
   - Provide a utility that validates outbound URLs before any import/URL-fetch
     feature calls `fetch`.
   - Block non-HTTP(S) protocols, URLs with embedded credentials, localhost,
     RFC1918, link-local, loopback, and cloud metadata IPs.

## Implementation plan

- [x] Split the components into separate modules: `security-headers`,
  `control-plane-access-guard`, `file-upload-policy`, and `outbound-url-guard`.
- [x] Mount `security-headers` on the global middleware chain.
- [x] Mount `control-plane-access-guard` and `file-upload-policy` on the
  authenticated tenant-scoped API chain.
- [x] Add the upload-policy configuration environment variables to `Bindings`.
- [x] Add dedicated unit tests per guard so the test names reflect each
  responsibility.
- [x] Add specific audit events for guard denials:
  `control_plane_access_denied` and `file_upload_policy_denied`.
- [ ] In the next Harness phase: require every AI-invoked tool/fetch/import to go
  through `validateOutboundUrl` or `guardedFetch`.
- [ ] In the next hardening phase: map granular permissions if needed for
  non-admin operators.

## Completion criteria

- A non-admin principal receives `CONTROL_PLANE_FORBIDDEN` when calling system
  control-plane routes.
- The public role cannot create file upload metadata or upload raw media bytes.
- Uploads that exceed the size cap (by declared length or true body size), use a
  MIME outside the allowlist, mismatch their declared extension/content, or embed
  active SVG content are rejected before writing to storage — on every covered
  upload surface, including `POST /api/v1/media/:key`.
- Media downloads are served as attachments with `nosniff`, and the served
  `Content-Type` round-trips through both storage adapters.
- Every response carries a CSP and the baseline security headers.
- The outbound URL guard has tests for localhost, private IPs, link-local
  metadata IPs, and dangerous protocols.
- The control-plane guard and file upload policy write dedicated audit events
  when the request has a DB context.

## Guard: ItemService RBAC context (fail-open protection)

### Problem

`ItemService` enforces row/field RBAC only when it is constructed with a
`permissionCtx`. Without one, `this.permissions = null` and **every** permission
check short-circuits to "allowed" (fail-open). This is deliberate — system
workers legitimately run without a user principal — but it means a request-scoped
call site that **forgets** `permissionCtx` silently bypasses authorization,
indistinguishable from a deliberate system context.

This bug shipped once: the AI `updateItem` skill ran `ItemService.patch()` on a
service missing `permissionCtx` → LLM item mutations skipped RBAC (PR #151). A
follow-up review found the MCP endpoint (`routes/mcp.ts`) had the same bug, even
though its comment promised "an MCP client can never do more than the same token
could via the Agent API".

### Regression-prevention mechanism (implemented)

Every `ItemService` construction goes through two explicit helpers in
`apps/cms/src/services/item-service-factory.ts`:

- **`itemServiceForRequest(c)`** — used for EVERY service built while handling an
  HTTP request (routes, GraphQL resolvers, MCP). It always attaches
  `permissionCtx` from the Hono context; `permissionCtx` is applied last so
  `overrides` cannot accidentally drop enforcement.
- **`itemServiceForSystem(deps, reason)`** — used for system/background flows. It
  requires a `SystemContextReason` (`'scheduler'` | `'background-worker'` |
  `'compliance-erasure'`) so the author must **state why** the fail-open posture
  is safe.

The regression test `apps/cms/src/__tests__/item-service-rbac-context.test.ts`
scans the source and **fails CI** if a bare `new ItemService(...)` appears
outside the factory (except a reviewed allowlist). A future maintainer cannot
re-introduce a fail-open path without a reviewer noticing.

### Call-site classification table (audit)

| Call site | Mode | Reason |
|-----------|------|--------|
| `routes/items.ts` | request | REST CRUD — enforces RBAC per bearer token |
| `routes/ai.ts` (`/chat`, `/approvals/:id/decide`) | request | AI skills enforce the same RBAC as `/items` (PR #151) |
| `routes/mcp.ts` | request | **fixed** — previously missing `permissionCtx` (fail-open) |
| `routes/admin-sar.ts` | request | SAR export — admin-gated + enforces RBAC |
| `graphql/context.ts` | request | GraphQL inherits the REST surface's governance |
| `services/scheduler-worker.ts` | system `scheduler` | cron retention sweep, no user principal |
| `services/veto-commit-worker.ts` | system `background-worker` | commit after the veto window locked in the human decision |
| `services/agent-run-worker.ts` | system `background-worker` | governed agent run — HITL/autonomy gated in the harness, not per-user RBAC |
| `services/erasure-service.ts` | system `compliance-erasure` | erasure/SAR gated by admin + dual-control at the service layer |

### Checklist when adding a new ItemService

- [ ] Is the call site inside an HTTP request path (has `Context<AppEnv>`)? → use `itemServiceForRequest(c)`. NEVER hand-write `permissionCtx` inline.
- [ ] Is the call site a worker/cron/compliance flow running system-privileged? → use `itemServiceForSystem(deps, reason)` and pick the semantically correct `reason`.
- [ ] If a direct `new ItemService(...)` is genuinely required (rare) → add it to `ALLOWED_DIRECT_CONSTRUCTION` in the guard test with a justification, so a reviewer sees it.
- [ ] Updated the classification table above when adding a new request/system call site.

### Completion criteria (this guard)

- No production file (outside the factory + allowlist) calls `new ItemService(...)` directly — guaranteed by the source-scan test.
- The AI and MCP endpoints enforce row/field RBAC exactly like `/items` (LLM skills cannot exceed the token's privileges).
- Every system context declares an explicit, greppable `reason` present in the audit table.
