---
version: 1
lastUpdated: 2026-07-05T10:56:37.131Z
sourceLang: en
contentHash: 872eb1bddf553837
---

# ADR-005: Hono.js over Express / Elysia

**Date:** 2024-01-20
**Status:** Accepted

## Context

LumiBase needs a web framework for the CMS API (`apps/cms`) that:

1. **Runs on Cloudflare Workers** — the primary deployment target. Workers uses the Web Standard `Request`/`Response` API, not Node.js `http.IncomingMessage`/`ServerResponse`. Express, Fastify, and NestJS depend on Node.js APIs and cannot run on Workers without shimming.

2. **Also runs on Node.js / Docker** — for self-hosted deployments. The same codebase must serve both targets.

3. **Has good TypeScript support** — field-level permissions, Drizzle integration, and complex middleware types require strong typing.

4. **Is lightweight** — Workers have a 1MB compressed bundle limit. Full frameworks with many built-in features add significant bundle size.

Frameworks evaluated:
- **Express** — not compatible with Workers (Node.js-specific)
- **Fastify** — not Workers-compatible without heavy shims
- **NestJS** — too large, not Workers-compatible
- **Elysia** — Bun-first, Workers compatibility is limited and experimental
- **Hono** — designed for web standards, runs on Workers + Bun + Deno + Node.js + Cloudflare Pages

## Decision

Use **Hono.js** as the web framework.

Two entrypoints in `apps/cms/src/`:
- `index.ts` → `export default app` (Cloudflare Workers / Wrangler)
- `serve.ts` → `serve(app, { port })` via `@hono/node-server` (Node.js / Docker)

All router and middleware code lives in shared files that import only from `hono` core.

## Consequences

**Positive:**
- Single codebase runs on both Workers and Node.js without changes
- Tiny bundle — Hono core is ~13KB minified+gzipped
- Excellent TypeScript generics for context types (`c.get('runtime')`, `c.get('user')`)
- Active maintenance, good community, growing ecosystem
- Compatible with Web Standard APIs (`Request`, `Response`, `Headers`, `URLSearchParams`)

**Negative:**
- Smaller ecosystem than Express — fewer ready-made middleware packages; some had to be written custom (e.g., multipart file upload for Workers)
- Hono's RPC client (`hc<>`) is useful but adds complexity if adopted
- Documentation is less extensive than Express for advanced patterns

**Neutral:**
- `@hono/zod-validator` used for request validation (aligns well with our zod schemas in `packages/shared`)
