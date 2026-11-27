---
version: 5
lastUpdated: 2026-11-27T13:43:11.800Z
sourceLang: en
contentHash: 8713b022d078113c
codeVerified: 2026-11-27T13:43:11.800Z
codeVerifiedHash: 8713b022d078113c
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
   CMS exit. A pinned bundle (one with a recorded `bundleSha256`) is
   content-addressed, so its verified bytes are kept in memory under that
   digest (at most 64 bundles, 64 MB) and later loads reuse them instead of
   downloading again. The signature is still checked on every load, so a
   revoked key takes effect at once. The same applies to Node in process.
2. **`EXTENSION_RUNTIME` selects it**: `process` or `in-process`; unset, it is
   `process` in production (`LUMIBASE_ENV` or `NODE_ENV` = `production`) and
   `in-process` elsewhere, so development and tests keep one process.
3. **Cloudflare Workers stay in process** (option A with the provenance gates).
   An isolate per request is already the platform's isolation and Workers
   cannot fork; option B (Workers for Platforms) remains the path if a
   deployment needs per-extension isolation there.
4. Do not adopt C or D: C cannot run on Workers, and D shares the process, so
   it limits nothing that matters here.
5. **Run only the bytes that were verified (#1008), per runtime:**

   | Runtime | Decision |
   | --- | --- |
   | Node, process host | Mitigated (#990): one download; signature and SHA-256 checked on that buffer; the child receives those bytes. |
   | Node, `EXTENSION_RUNTIME=in-process` | Mitigated: the same one-download check, then `import()` of a `data:` URL of the verified bytes (`ExtensionSandbox.loadVerifiedInProcess`), never of the bundle URL. |
   | Studio (browser) | Mitigated: `importVerifiedBundle` downloads once, checks the SHA-256, and imports a `blob:` URL of those bytes. The CSP `script-src` therefore allows `blob:` (CMS and Studio Pages). A Studio bundle must be a single file, since a `blob:` module cannot resolve relative imports. |
   | Cloudflare Workers | **Risk accepted.** Workers cannot import a `data:`/`blob:` module, so the bundle is verified and imported as two fetches. Operator requirement: `EXTENSION_BUNDLE_ORIGINS` lists only origins you control, serving immutable, content-addressed URLs (the SHA-256 in the path, never overwritten). `lumibase doctor --security` warns when extensions are enabled on Workers. Option B (Workers for Platforms) removes the requirement. |

6. **Network egress of extension code (#1009), per runtime: risk accepted at
   the process level; restricted at the network level.** Node's permission
   model has no network control, and an in-child `fetch` shim would not be a
   boundary.

   | Runtime | Decision |
   | --- | --- |
   | Kubernetes (Helm chart) | `networkPolicy.egress.restrict=true` gives the CMS and worker pods an egress policy. It allows DNS, the release's own bundled services, `networkPolicy.egress.allowTo` peers and public addresses, and blocks `169.254.0.0/16` (cloud metadata), private, CGNAT and loopback ranges. It is off by default (it limits the whole CMS, and needs a CNI that enforces egress) and recommended in production. The chart then sets `LUMIBASE_EGRESS_RESTRICTED=true`. |
   | Node / Docker without the chart | Operator requirement: block metadata and private ranges for the CMS container (firewall, Docker network rules or an egress proxy), then set `LUMIBASE_EGRESS_RESTRICTED=true`. |
   | Cloudflare Workers | Risk accepted: outbound `fetch` from the isolate is not restricted. Workers have no private network or metadata endpoint to reach; the residual risk is exfiltration of data the extension receives through `ctx`. |

   In production with extensions configured, the CMS logs a warning at
   startup and `lumibase doctor --security` reports
   `extension-egress-unrestricted` until `LUMIBASE_EGRESS_RESTRICTED=true` is
   set.

## Consequences

- On Node in production, an extension can no longer read the CMS's secrets,
  write files, spawn processes or patch the host's capability checks; what it
  can do is what its declared capabilities let `ctx` do.
- The permission model does not cover the network: code in the child can open
  its own connections, without any of the CMS's credentials. Egress is
  restricted at the network level instead (decision 6).
- Out of process, `ctx.env.EXTENSION_X` is a promise (`await` it), `ctx.fetch`
  returns a copy of the response (at most 5 MB), the CDC `ctx.logger` is the
  child's console, and the extension factory runs once per child rather than
  once per request. Arguments and results must be structured-cloneable.
- A remote `https` bundle now loads on Node: the host downloads it, which a
  Node `import()` could not.
- On Node (either runtime) and in the Studio, nothing runs that was not
  verified: there is one download, and the signature and SHA-256 are checked
  on the buffer that is executed. A server that answers a later download
  differently is refused at that load. Only Cloudflare Workers still verify one
  response and import the URL separately (decision 5, accepted risk).
- `script-src` allows `blob:`. A page can only create a `blob:` script by
  already running script, so it adds no injection path; `'unsafe-inline'` and
  `'unsafe-eval'` stay off.
