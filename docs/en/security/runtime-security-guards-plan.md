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
   - Forbid the public role from creating upload metadata.
   - Cap upload size via `FILE_UPLOAD_MAX_BYTES`, default 10 MiB.
   - Allow MIME types via `FILE_UPLOAD_ALLOWED_MIME_TYPES`, defaulting to common
     images, PDF, CSV, and text.
   - Verify the signed upload PUT before writing to storage.

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
- The public role cannot create file upload metadata.
- Uploads that exceed the size cap or use a MIME outside the allowlist are
  rejected before writing to storage.
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
