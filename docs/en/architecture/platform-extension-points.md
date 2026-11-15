---
version: 3
lastUpdated: 2026-11-15T14:59:15.675Z
sourceLang: en
contentHash: b65445cc77793e33
codeVerified: 2026-11-15T14:59:15.675Z
codeVerifiedHash: b65445cc77793e33
codeVerifiedClaims: 42
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
site-to-organization lookup, the entitlement resolver, the usage emitter, and the
external-action tool source.

## Where things live

| Piece | Location |
|---|---|
| Contracts (interfaces and types) | `packages/contracts/src/platform/index.ts`, imported as `@lumibase/contracts/platform` |
| Registry | `apps/cms/src/platform/registry.ts` |
| Built-in defaults | `apps/cms/src/platform/defaults.ts` |
| Request-scoped helpers | `apps/cms/src/platform/request.ts` |
| Entitlement middleware | `apps/cms/src/middleware/entitlement.ts` |
| Usage contracts | `packages/contracts/src/platform/usage.ts` |
| Usage scope and `recordUsage()` | `apps/cms/src/platform/usage.ts` |
| Usage middleware | `apps/cms/src/middleware/usage.ts` |
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

## Usage emitter

The usage emitter reports what a request or a background job consumed, already
attributed to a site and its organization. It is for operators who want
per-organization usage reporting without scraping logs or metrics that carry no
tenant.

It is separate from the opt-in anonymous telemetry described in
[Activation milestones and usage telemetry](../operations/usage-telemetry.md):
different payload, different switch, no shared storage.

```ts
interface UsageEvent {
  id: string;            // uuidv7, the idempotency key
  kind: string;          // see USAGE_KINDS
  tenant: TenantRef;     // site and organization at the moment of the event
  quantity: number;      // signed for deltas (storage.bytes, seat.change)
  unit: 'count' | 'bytes' | 'tokens' | 'ms';
  occurredAt: string;    // ISO 8601, UTC
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

interface UsageEmitter<TRuntime = unknown> {
  emit(event: UsageEvent): void;                  // synchronous, must not throw
  flush(ctx: SeamContext<TRuntime>): Promise<void>; // never awaited by the response
}
```

### Default

`emit` and `flush` do nothing. In practice they are never reached: every call
site checks registration first, so with nothing registered no event is built,
no tenant is looked up and nothing is written.

### What the CMS emits

| Kind | Where | Quantity |
|---|---|---|
| `api.request` | `withUsage()`, every request on the authenticated API | 1 |
| `delivery.request` | `withUsage()`, every request on `/api/v1/deliver/*` | 1 |
| `storage.bytes` | `POST /api/v1/files` (+`filesize`), `DELETE /api/v1/files/:id` (−`filesize`), media upload (+bytes written) | signed bytes |
| `seat.change` | organization created (+1 owner), member invited (+1, new members only), member removed (−1) | ±1 |
| `agent.run` | `AgentRunService.closeRun` / `failRun` | 1 |
| `ai.tokens` | every model call made through `createLLMProvider()` that reports usage, one event per direction | tokens |
| `email.sent` | `EmailService.send` when the transport accepts the message | recipients |

`attributes` holds classification values only: surface, method, status class,
principal kind (`user`, `api_key`, `anonymous`), duration, model id, transport.
Never a path, a body, an address or a user id.

Requests that name neither a site nor an organization (health checks, sign-in
pages) produce no event, and CORS preflights are not counted.

### Off the request path

`withUsage()` is mounted globally right after `withRuntime()`. When an emitter is
registered it opens a *usage scope* around the request. Call sites record into
that scope with `recordUsage()`, which only appends to a list; the scope travels
with the async context (`AsyncLocalStorage`, available on Workers through
`nodejs_compat`), so a service such as the email transport records into the
request it serves without being handed anything.

When the response is decided, the scope's drain — tenant attribution through the
cached site-to-organization lookup, `emit` for each event, then one `flush` — is
handed to `executionCtx.waitUntil` on Workers and left to run on its own on Node.
The response never waits for it.

Background jobs open their own scope with `runWithUsageScope()`. The agent-run
queue consumer does this on both runtimes, so a queued run reports its model
tokens and its terminal state; the drain is awaited at the end of the job.

Measured with `pnpm -F @lumibase/cms bench:usage-seam` (in-process, 20,000
requests per variant, interleaved): with nothing registered the median request
time is within noise of the app without the middleware; with a buffering
emitter registered the median rises by about 17 µs per request.

### Failure handling

An `emit` that throws loses that event and is logged; a `flush` that rejects is
logged. Neither affects the response. Losing an event is preferred to failing a
request.

### Writing an emitter

```ts
import type { UsageEmitter, UsageEvent } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

export function createQueueEmitter(): UsageEmitter<RuntimeContext> {
  let buffer: UsageEvent[] = [];
  return {
    emit(event) {
      buffer.push(event);
    },
    async flush(ctx) {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      await ctx.runtime.queue.enqueue('usage-events', 'batch', { events: batch });
    },
  };
}
```

Guidelines:

- Buffer in `emit`; do I/O in `flush`. One emitter object serves every request
  of the isolate or process, so a module-level buffer is shared — swap it out
  before awaiting, as above.
- Deduplicate on `event.id`. Queues deliver at least once, and the same event may
  reach you twice.
- `tenant.organizationId` is the owner at the moment of the event. A site moved
  to another organization later leaves its earlier usage with the old one.
- A Cloudflare queue needs its own producer binding. Declare it in your
  deployment's `wrangler.toml`, not in the stock one.

## External-action tools

The `externalActions` seam lets a deployment entry hand over agent tools that
call systems outside the CMS, from a package this repository does not import.

```ts
registerPlatformSeams({ externalActions: { tools: () => myTools() } });
```

It differs from the other seams in two ways, both deliberate:

- **It is read at registration, not per request.** `tools()` runs once inside
  `registerPlatformSeams()`, and every definition is validated and registered
  into the process-wide tool registry there.
- **A failure is not absorbed.** A malformed or duplicate definition makes
  `registerPlatformSeams()` throw and registers none of the tools. Running with a
  tool silently missing, or with half a tool set, would change what agents may do
  without anyone noticing.

Default: no tools. The declaration format, the decision rule and the optional
pre-execution policy are described in
[External-action tools](../features/external-action-tools.md).

## Multi-tenancy

- **Isolated per tenant:** the site-to-organization cache entry (keyed by site
  id), the memoised tenant and snapshot (kept on the per-request context), the
  usage scope (one per request or job, attributed per site).
- **Shared across the deployment:** the registry. One registration applies to
  every site in the process or isolate. The same emitter object receives every
  site's events; each event carries its own tenant.

How this is verified: `apps/cms/src/services/domains/__tests__/site-organization-cache.test.ts`
and `apps/cms/src/middleware/__tests__/entitlement.test.ts` run two sites side by
side and assert that neither sees the other's owner or decision.
`apps/cms/src/routes/__tests__/site-organization-cache.db.integration.test.ts`
checks invalidation against PostgreSQL. `apps/cms/src/platform/__tests__/usage.test.ts`
covers attribution of request and service events to their site.
