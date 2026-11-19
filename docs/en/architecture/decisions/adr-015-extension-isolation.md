---
version: 1
lastUpdated: 2026-11-19T20:13:27.270Z
sourceLang: en
contentHash: 67a1126eba46851a
codeVerified: 2026-11-19T20:13:27.270Z
codeVerifiedHash: 67a1126eba46851a
codeVerifiedClaims: 8
---

# ADR-015: Extension code isolation

**Date:** 2026-11-19  
**Status:** Proposed

## Context

Server extensions of type `hook` and `endpoint` are loaded by
`ExtensionSandbox` (`apps/cms/src/extensions/sandbox.ts`) with a dynamic
`import()` **in the CMS process**. The "sandbox" is a capability gate on the
`ctx` object passed to the extension's factory — `items`, `db`, `fetch`, `kv`,
`env` (only `EXTENSION_*` keys) — not an isolation boundary: bundle code can
still reach `globalThis.fetch`, timers, `process.env` on Node, and anything else
the host isolate can reach.

What keeps this acceptable today is that an extension only loads when:

1. its bundle origin is in `EXTENSION_BUNDLE_ORIGINS` (empty = nothing loads);
2. its signature verifies (`LUMIBASE_EXT_SIGNATURE_POLICY`, default `require`),
   checked at install, at every load, and — since #990 — whenever an update
   changes the bundle URL or version;
3. an admin installed and enabled it (`/api/v1/extensions` is admin-only, and
   agents cannot install or update one without a human — #991).

FBI FLASH CC-111626-MW lists plugin persistence as the common thread of
WordPress compromises: fake plugins, hidden must-use plugins, concealed REST
endpoints. LumiBase extensions are the equivalent surface, so the trust in
items 1–3 should eventually be backed by a runtime boundary, not only by
provenance.

#990 already closed the leaks that did not need one: endpoint handlers no
longer receive the CMS env bindings, the execution context or the caller's
`Authorization` / `Cookie` headers (`extensionRequest` in
`apps/cms/src/routes/extensions.ts`), and Studio refuses a UI bundle whose bytes
do not match the recorded SHA-256 (`importVerifiedBundle` in
`apps/studio/src/lib/extension-loader.tsx`).

## Options

| Option | Cloudflare Workers | Node / Docker | Cost |
| --- | --- | --- | --- |
| A. Keep in-process + provenance gates (today) | ✓ | ✓ | none; trust rests on signature and admin |
| B. Workers for Platforms (dispatch namespace, one user Worker per extension) | ✓ real isolate, outbound control via an outbound Worker | — | paid plan; deploy pipeline per extension |
| C. `isolated-vm` / V8 isolate per extension | — (no native modules) | ✓ | native dependency; per-call marshalling of `ctx` |
| D. `worker_threads` + message-port RPC for `ctx` | — | ✓ partial (shares the process, not the heap) | moderate; no memory/CPU hard limits |
| E. Out-of-process extension host (HTTP/RPC, own container) | via service binding | ✓ | an extra service to run; strongest on Node |

## Decision (proposed)

1. **Keep option A as the default**, with the #990 hardening, and document
   plainly that extensions run with the CMS's own authority. Installing one is
   a code deployment.
2. **Target option B on Cloudflare and option E on Docker** for `hook` and
   `endpoint` extensions, behind one interface: the host calls an
   `ExtensionRuntime` (`invokeHook`, `handleRequest`) with a serialised `ctx`
   request, and the isolated side calls back over RPC for `items` / `db` /
   `kv` operations, each checked against the extension's granted capabilities
   on the host side.
3. Do not adopt C or D: C cannot run on Workers, and D shares the process, so
   it limits nothing that matters here.

The follow-up implementation is tracked under epic #985; this ADR stays
**Proposed** until the `ExtensionRuntime` interface lands.

## Consequences

- Until then, the boundary is provenance (origin allowlist + signature +
  admin), and the audit trail (`admin_change` for install / update / enable,
  #988) is how an unexpected extension is noticed.
- An extension that needs host secrets must use `EXTENSION_*` keys through
  `ctx.env` (capability `env:read`); it can no longer read them from the
  handler's bindings.
- Studio's integrity check catches a bundle replaced at its URL, but not a
  server that answers the verification fetch and the module import
  differently; closing that needs a `blob:` import and therefore `blob:` in the
  Studio CSP `script-src`, which is deferred to the same follow-up.
