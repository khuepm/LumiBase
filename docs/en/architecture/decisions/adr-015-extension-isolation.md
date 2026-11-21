---
version: 3
lastUpdated: 2026-11-21T03:36:06.095Z
sourceLang: en
contentHash: 64456fef2a7ac15c
codeVerified: 2026-11-21T03:36:06.095Z
codeVerifiedHash: 64456fef2a7ac15c
codeVerifiedClaims: 16
---

# ADR-015: Extension code isolation

**Date:** 2026-11-19  
**Status:** Accepted (Node / Docker); Workers stay in process

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

## Decision

1. **On Node / Docker, run `hook` and `endpoint` extensions out of process
   (a lighter option E): one child process per site, extension and bundle**,
   forked by the CMS (`apps/cms/src/extensions/host/process-host.ts`, child
   `host/child.ts`, built to `dist/extension-host.cjs`). The child starts with:
   - an empty environment, so no `DATABASE_URL`, `JWT_SECRET` or provider key;
   - Node's permission model (`--permission`): no file writes, no child
     processes, no worker threads, no native addons, and file reads only in
     the host script's directory;
   - a 128 MB heap cap;
   - no database connection and no CMS module state.

   The extension's `ctx` is a proxy: every `items` / `db` / `fetch` / `kv` /
   `env` call goes over IPC to the host and is answered by the same
   capability-checked ctx as before, bound to the request that made the call.
   Hooks, MCP tools, CDC subscribers and endpoint requests are forwarded the
   same way. The host downloads the bundle once (origin allowlist, SSRF
   guard, at most 5 MB), checks the signature and the recorded `bundleSha256`
   on that exact buffer, and hands the child those bytes. Children are keyed
   by the verified digest, so a reused child always runs checked bytes, and a
   child holding other bytes of the same extension is ended. A child is killed on a
   load failure, a call that runs past 10 s, an update of the extension, or
   CMS exit.
2. **`EXTENSION_RUNTIME` selects it**: `process` or `in-process`; unset, it is
   `process` in production (`LUMIBASE_ENV` or `NODE_ENV` = `production`) and
   `in-process` elsewhere, so development and tests keep one process.
3. **Cloudflare Workers stay in process** (option A with the provenance gates).
   An isolate per request is already the platform's isolation and Workers
   cannot fork; option B (Workers for Platforms) remains the path if a
   deployment needs per-extension isolation there.
4. Do not adopt C or D: C cannot run on Workers, and D shares the process, so
   it limits nothing that matters here.

## Consequences

- On Node in production, an extension can no longer read the CMS's secrets,
  write files, spawn processes or patch the host's capability checks; what it
  can do is what its declared capabilities let `ctx` do.
- The permission model does not cover the network: code in the child can open
  its own connections, without any of the CMS's credentials. Restrict egress
  at the container level if that matters.
- Out of process, `ctx.env.EXTENSION_X` is a promise (`await` it), `ctx.fetch`
  returns a copy of the response (at most 5 MB), the CDC `ctx.logger` is the
  child's console, and the extension factory runs once per child rather than
  once per request. Arguments and results must be structured-cloneable.
- A remote `https` bundle now loads on Node: the host downloads it, which a
  Node `import()` could not.
- Out of process, nothing runs that was not verified: there is one download,
  and the signature and SHA-256 are checked on the buffer the child receives.
  A server that answers a later download differently is refused at that load.
  The in-process path (Workers, `EXTENSION_RUNTIME=in-process`) still verifies
  one response and imports the URL separately.
- Studio's integrity check catches a bundle replaced at its URL, but not a
  server that answers the verification fetch and the module import
  differently; closing that needs a `blob:` import and therefore `blob:` in the
  Studio CSP `script-src`, which is deferred.
