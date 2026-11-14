---
version: 1
lastUpdated: 2026-11-14T12:26:57.226Z
sourceLang: en
contentHash: b9b358bafbe19e63
codeVerified: 2026-11-14T12:26:57.226Z
codeVerifiedHash: b9b358bafbe19e63
codeVerifiedClaims: 30
---

# Platform extension points

An operator who runs LumiBase for many organizations sometimes needs policy the
CMS should not hard-code — for example, a ceiling on how much one organization
may consume. The platform extension points ("seams") let a deployment supply that
policy from its own entry file, without patching route handlers.

Three properties hold for every seam:

- **Nothing registered means nothing changes.** Each seam has a built-in default
  that does nothing. The stock entry points register nothing, so a standard
  build behaves exactly as it did before the seams existed.
- **The CMS is never gated.** No built-in feature depends on a seam returning a
  particular answer. With the defaults, every limit is unlimited.
- **A failing implementation never fails a request.** If an implementation
  throws, the CMS logs the failure and continues as if the default had answered.

This page covers the registry, the composable entry points, the cached
site-to-organization lookup, and the entitlement resolver.

## Where things live

| Piece | Location |
|---|---|
| Contracts (interfaces and types) | `packages/contracts/src/platform/index.ts`, imported as `@lumibase/contracts/platform` |
| Registry | `apps/cms/src/platform/registry.ts` |
| Built-in defaults | `apps/cms/src/platform/defaults.ts` |
| Request-scoped helpers | `apps/cms/src/platform/request.ts` |
| Entitlement middleware | `apps/cms/src/middleware/entitlement.ts` |
| Site-to-organization lookup | `apps/cms/src/services/domains/site-organization-cache.ts` |

The contracts package has no runtime dependencies, so the runtime handle in
`SeamContext` is a type parameter. The CMS pins it to `RuntimeContext`.

## Registering an implementation

`registerPlatformSeams()` accepts a partial set of seams. Whatever you leave out
keeps its default.

```ts
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });
```

Rules:

- Call it **once**, at module scope of your entry file. A second call throws.
- Call it **before the first request**. Once the CMS has read the seams, a late
  registration throws instead of applying to some requests and not others.
- Never call it from a request handler, a route, or a service.

`platform()` returns the complete set — registered implementations over
defaults. `isPlatformSeamRegistered(name)` reports whether a seam was supplied.

## Composable entry points

`@lumibase/cms` exports its entry points so a deployment can wrap them:

| Export | Contents |
|---|---|
| `@lumibase/cms/app` | The Hono app |
| `@lumibase/cms/cloudflare` | The Workers handler (`fetch`, `scheduled`, `queue`) and the `SiteRoom` and `PageviewCounter` Durable Object classes |
| `@lumibase/cms/node` | `startNodeServer()` — importing it starts nothing |
| `@lumibase/cms/platform` | The registry and the request helpers |

### Cloudflare Workers

Point `main` in your `wrangler.toml` at a file like this. Keep the `[alias]`
block from `apps/cms/wrangler.toml`; it keeps the Docker adapters out of the
Worker bundle.

```ts
import handler, { PageviewCounter, SiteRoom } from '@lumibase/cms/cloudflare';
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });

export default handler;
export { PageviewCounter, SiteRoom };
```

Module scope runs once per isolate, before the first request.

### Node.js and Docker

```ts
import { startNodeServer } from '@lumibase/cms/node';
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });

await startNodeServer();
```

`startNodeServer()` does everything `apps/cms/src/serve.ts` does when run
directly: HTTP server, cron, and queue workers. Running `serve.ts` itself is
unchanged and still starts on load.

### One direction only

Code outside this repository may import it. Nothing under `apps/` or `packages/`
may import a `@lumibase/*` package that is not a member of this workspace.
`pnpm imports:check` enforces this in CI.

## Site-to-organization lookup

Every site belongs to exactly one organization. `siteOrganizationId(db, cache, siteId)`
returns the owning organization id through the runtime cache, so the request
path can name the organization without a query per request.

| Outcome | Cached for | Result |
|---|---|---|
| Site found | 10 minutes | The organization id |
| Site not found | 30 seconds | `null` |
| Database error | Not cached | `null` |

The function never throws.

**Isolation.** The cache key is `site-org:` followed by the site id. An entry is
only ever written from the row whose primary key is that same id, so a lookup
for one site can neither read nor overwrite another site's entry.

**Invalidation.** `invalidateSiteOrganization(cache, siteId)` runs after the
write commits, in each place that changes the owner:

- site transfer and site deletion in `apps/cms/src/routes/orgs.ts`;
- the same two operations when run through an approval, in `apps/cms/src/services/organization-harness.ts`;
- site creation, in `apps/cms/src/services/site-provisioning.ts`, to clear an earlier "not found" entry.

**Staleness bound.** A reader that selected the old row just before a transfer
committed can write it back afterwards. That entry lives at most 10 minutes.
Use this lookup for attribution. Code that authorizes a caller must keep reading
the database, as `organizationRoleForSite` does.

Inside a request, call `tenantRefFor(c)` instead. It resolves lazily on first
use and memoises the result on the Hono context for the rest of the request.
On organization routes, which carry no site, it reports the organization the
access guard verified, or the organization of an organization API key — never
the raw path parameter.

## Entitlement resolver

An `EntitlementResolver` answers two questions:

```ts
interface EntitlementResolver<TRuntime = unknown> {
  resolve(ctx: SeamContext<TRuntime>, organizationId: string | null): Promise<EntitlementSnapshot>;
  authorize(ctx: SeamContext<TRuntime>, req: AuthorizeRequest): Promise<AuthorizeDecision>;
}
```

- `resolve` returns the limits in force for an organization, as a table of
  open, namespaced keys (`sites`, `seats`, `storage.bytes`, and so on). Each
  value is a number or `'unlimited'`.
- `authorize` decides whether one concrete action may proceed.

The CMS does not define what the keys mean or where the numbers come from. It
only asks, and acts on the answer.

### Default

The built-in resolver returns a snapshot in which every key reads `'unlimited'`,
and authorizes every request. It performs no I/O.

Read a limit with `limitFor(snapshot, dimension)`. A key the snapshot does not
list is unlimited.

### Where the CMS calls it

`withEntitlement()` is mounted in `apps/cms/src/index.ts` in two places:

| Mount | Dimension | Surface | Runs after |
|---|---|---|---|
| Authenticated `/api/v1/*` | `api.requests` | `rest`, `graphql`, or `mcp`, by path | The full guard chain |
| Public `/api/v1/deliver/*` | `delivery.requests` | `delivery` | The delivery rate limiter |

With no resolver registered the middleware passes straight through: no tenant
lookup, no cache read. With one registered, it calls `authorize` once per
request.

Handlers and services read the snapshot with `entitlementsFor(c)`. It is
resolved once per request and kept on the context. To ask about a specific
action, call `authorizeEntitlement(c, { dimension, amount, surface })`.

No built-in route consults the snapshot yet. The helpers exist so later work can
do so without changing the contract.

### Refusal format

When `authorize` returns `allowed: false`, the middleware answers HTTP 429:

```json
{
  "errors": [
    {
      "code": "LIMIT_EXCEEDED",
      "dimension": "api.requests",
      "limit": 1000,
      "retryable": true
    }
  ]
}
```

`helpUrl` is included only when the implementation supplies one. REST, GraphQL,
and MCP sit behind the same mount, so the response is identical on all three.

### Failure handling

| What the implementation does | What the CMS does |
|---|---|
| `authorize` throws or rejects | Logs it and allows the request |
| `authorize` returns something that is not a decision | Logs it and allows the request |
| `resolve` throws or returns a malformed snapshot | Logs it and uses the unlimited snapshot |

The log line starts with `[lumibase-cms] platform seam failed` and carries the
seam name, the operation, and the request id.

An implementation that wants to refuse while its own backing store is
unavailable must return `allowed: false` itself. The CMS adds no failure policy
of its own.

### Writing a resolver

```ts
import type { EntitlementResolver } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

export const myResolver: EntitlementResolver<RuntimeContext> = {
  async resolve(ctx, organizationId) {
    const limits = await loadLimits(ctx.runtime.cache, organizationId);
    return { organizationId, limits, resolvedAt: Date.now() };
  },
  async authorize(ctx, req) {
    if (req.dimension !== 'api.requests') return { allowed: true };
    const used = await countRequests(ctx.runtime, req.tenant.organizationId);
    return used < 1000
      ? { allowed: true }
      : { allowed: false, code: 'LIMIT_EXCEEDED', dimension: req.dimension, limit: 1000, retryable: true };
  },
};
```

Guidelines:

- Reach infrastructure through `ctx.runtime` (cache, queue, rate limiter). Do not
  import Cloudflare bindings or Node-only modules, so the same code runs on both
  runtimes.
- `authorize` runs on every request once registered. Keep it to a cache read.
- `req.tenant.organizationId` can be `null`: the site may be unknown, or the
  lookup may have failed. Decide what your implementation does in that case.
- `ctx.requestId` is `null` outside a request (cron, queue consumers).

## Multi-tenancy

- **Isolated per tenant:** the site-to-organization cache entry (keyed by site
  id), the memoised tenant and snapshot (kept on the per-request context).
- **Shared across the deployment:** the registry. One registration applies to
  every site in the process or isolate.

How this is verified: `apps/cms/src/services/domains/__tests__/site-organization-cache.test.ts`
and `apps/cms/src/middleware/__tests__/entitlement.test.ts` run two sites side by
side and assert that neither sees the other's owner or decision.
`apps/cms/src/routes/__tests__/site-organization-cache.db.integration.test.ts`
checks invalidation against PostgreSQL.
