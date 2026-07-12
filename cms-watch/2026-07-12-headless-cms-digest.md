# Headless CMS Daily Digest — 2026-07-12

> Automated watch over 10 popular headless CMS projects (blogs + GitHub Issues).
> **Scope of this run:** the most recently *opened* public issues for each repo (unauthenticated GitHub listing, ~12 newest per repo) plus notable blog/release posts. This is the first recorded run, so there is no prior baseline to diff against — everything below is the current snapshot.
> **Note on freshness:** GitHub's public issue list is sorted by creation date, not last-activity, so items range over recent weeks rather than strictly the last 24h. Dates are shown per item.

---

## Summary of what's notable this run

- **Security items worth flagging:** a path-traversal vulnerability in Decap's local proxy server (#7875), a Strapi rate-limiting/race-condition report on admin registration (#26494, marked critical), and a cross-origin `postMessage` code-execution report in Builder.io (#4501). Strapi also published a multi-CVE disclosure post.
- **AI / MCP is the dominant theme across the ecosystem:** Strapi's MCP server reached GA, Directus shipped native MCP support and an AI assistant/chat, and both Payload and Directus have open MCP-related bugs.
- **Framework churn:** several repos tracking Next.js 16.x upgrades (Payload, Keystone) and Node 22/24 install breakage (TinaCMS, Builder.io).

---

## Strapi
**Blog:** https://strapi.io/blog · **Issues:** https://github.com/strapi/strapi/issues (396 open)

### Blog / release highlights
- **The Strapi MCP server is now GA** (Jun 29, 2026) — stable surface to wire AI agents to Strapi content. https://strapi.io/blog/the-strapi-mcp-server-is-now-ga
- **Release roundup: everything that changed between March and June 2026** (Jun 18, 2026). https://strapi.io/blog/strapi-release-roundup-everything-that-changed-between-march-and-june-2026
- **Extending the MCP server with custom tools via a plugin** (Jun 13, 2026).
- **Security disclosure: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886** (May 13, 2026). https://strapi.io/blog/security-disclosure-of-vulnerabilities-cve-2025-64526-cve-2026-22599-cve-2026-22706-cve-2026-22707-and-cve-2026-27886

### Notable open issues
- **[Security] No rate limiting on register-admin + race condition** — severity critical, Priority Urgent (#26494, May 30). https://github.com/strapi/strapi/issues/26494
- **[CI] Nightly release workflow publishes to npm without running any tests** — severity high (#26492, May 30). https://github.com/strapi/strapi/issues/26492
- **Content Manager crash: "Cannot read properties of undefined (reading 'attributes')" navigating single types** — critical (#26434, May 26). https://github.com/strapi/strapi/issues/26434
- **Replace media updates metadata but asset content remains original file** — confirmed, high (#26387, May 19). https://github.com/strapi/strapi/issues/26387
- **`firstPublishedAt`: entry falsely marked modified after first publish** (#26524, Jun 2). https://github.com/strapi/strapi/issues/26524
- **Wildcard characters in filters not escaped → incorrect literal matching** (#26468, May 28). https://github.com/strapi/strapi/issues/26468

## Directus
**Blog:** https://directus.io/blog · **Issues:** https://github.com/directus/directus/issues (326 open)

### Blog / release highlights
- **Evolving our license for long-term sustainability** (Apr 22, 2026) — v12 license change. https://directus.io/blog/directus-v12-license-change
- **v11.17: Background Imports, Netlify Deployments, Translations Generator** (Apr 10, 2026). https://directus.io/blog/directus-v11-17-release
- **v11.16: Global Draft Versions, Multimodal AI, Smarter Deployments** (Mar 10, 2026). https://directus.io/blog/directus-11-16-release
- **v11.15: Native Collaborative Editing, AI Assistant GA, One-Click Deployments** (Feb 12, 2026). https://directus.io/blog/directus-11-15-release
- **v11.13: Native MCP Support + Content Comparison** (Nov 7, 2025). https://directus.io/blog/directus-v11-13-release

### Notable open issues
- **[MCP] files tool update action fails — data schema typed as array but API expects object** — High impact (#27039, Apr 3). https://github.com/directus/directus/issues/27039
- **Save-as-copy throws error** — regression, High impact (#27091, Apr 10). https://github.com/directus/directus/issues/27091
- **WYSIWYG not rendering when returning from edit as non-admin (v11.16.1)** — High impact (#27042, Apr 3). https://github.com/directus/directus/issues/27042
- **GET /permissions/me returns 500 when non-admin policy has `directus_flows:trigger`** (#27124, Apr 15). https://github.com/directus/directus/issues/27124
- **Aliased GraphQL relational objects within a fragment return null** — regression, Enterprise (#27003, Mar 30). https://github.com/directus/directus/issues/27003
- **Apple OAuth first/last name not populated on registration** (#27111, Apr 14). https://github.com/directus/directus/issues/27111

## Payload CMS
**Blog:** https://payloadcms.com/blog · **Issues:** https://github.com/payloadcms/payload/issues (288 open)

### Notable open issues
- **`suppressHydrationWarning` broken after Next.js upgrade to 16.2.*** — area: core (#16288, Apr 15). https://github.com/payloadcms/payload/issues/16288
- **plugin-multi-tenant causes 404 with Next.js 16.2.3 + Turbopack** (#16286, Apr 15). https://github.com/payloadcms/payload/issues/16286
- **Date field `timezone: true` writes empty string to `_tz` enum column in Postgres** → invalid enum input (#16283, Apr 15). https://github.com/payloadcms/payload/issues/16283
- **Bulk upload into a Folder-enabled upload collection doesn't set the folder** (#16287, Apr 15). https://github.com/payloadcms/payload/issues/16287
- **vercelPostgresAdapter fails on large queries (68KB+ SQL, 30+ lateral joins)** (#16256, Apr 12). https://github.com/payloadcms/payload/issues/16256
- **[MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields** (#16214, Apr 8). https://github.com/payloadcms/payload/issues/16214
- **Lexical: `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported** (#16262, Apr 13). https://github.com/payloadcms/payload/issues/16262

## Sanity
**Blog:** https://www.sanity.io/blog · **Issues:** https://github.com/sanity-io/sanity/issues (75 open)

### Notable open issues
- **[BUG] Image upload silently stalls when file has no extension — no error shown** (#12870, May 24). https://github.com/sanity-io/sanity/issues/12870
- **Feature: include document language / field values in edit intent params for `canHandleIntent` routing** (#12834, May 15). https://github.com/sanity-io/sanity/issues/12834
- **Feature: preserve original image metadata / add IPTC metadata on upload** (#12812, May 10). https://github.com/sanity-io/sanity/issues/12812
- **Feature: support multiple `typegen` configurations** (#12787, May 5). https://github.com/sanity-io/sanity/issues/12787
- **Presentation tool writes `previewUrlSecret` to wrong dataset in multi-workspace hosted Studio** (#12794, Apr 16). https://github.com/sanity-io/sanity/issues/12794
- **Safari: Presentation Tool "Unable to connect" — cross-origin iframe sandboxing errors** (#12806, Apr 5). https://github.com/sanity-io/sanity/issues/12806

## Ghost
**Blog:** https://ghost.org/resources/ · **Issues:** https://github.com/TryGhost/Ghost/issues (63 open)

### Pinned / roadmap
- **🔥 Breaking Changes for 6.0** (#23924) and **🌐 i18n mega-issue** (#23361) remain the pinned tracking issues.

### Notable open issues
- **Admin API always saves revisions even when `save_revision=false`** (#26677, Mar 3). https://github.com/TryGhost/Ghost/issues/26677
- **Security: add optional malware scanning for uploaded files** (#27445, Apr 17). https://github.com/TryGhost/Ghost/issues/27445
- **Signup Card email placeholder hardcoded ("Your email"), no i18n / per-card override** (#27551, Apr 25). https://github.com/TryGhost/Ghost/issues/27551
- **[Feature] Set excerpt length to 2000 characters** (#27478, Apr 21). https://github.com/TryGhost/Ghost/issues/27478
- **Portal `fetchQueryStrData()` crashes widget on malformed preview URLs (unhandled JSON.parse)** (#26399, Feb 14). https://github.com/TryGhost/Ghost/issues/26399
- **Document HelmForge chart as a third-party Kubernetes install option** (#27717, May 6). https://github.com/TryGhost/Ghost/issues/27717

## KeystoneJS
**Blog:** https://keystonejs.com/blog · **Issues:** https://github.com/keystonejs/keystone/issues (100 open)

### Notable open issues
- **Bump Next to >15.5.13** — dependencies (#9798, Apr 3). https://github.com/keystonejs/keystone/issues/9798
- **Should Keystone enforce GraphQL query depth limits by default?** — feature/security (#9789, Mar 18). https://github.com/keystonejs/keystone/issues/9789
- **`statelessSessions` attempts unsupported `Authorization: Basic` header rather than cookie** (#9785, Mar 6). https://github.com/keystonejs/keystone/issues/9785
- **Field editable when `graphql.omit.update` is set** — bug, help wanted (#9665, Jul 2025). https://github.com/keystonejs/keystone/issues/9665
- **`npm run dev` fails with EPERM on Windows** (#9779, Feb 20). https://github.com/keystonejs/keystone/issues/9779
- **Node 20 (LTS) support** remains an open tracking issue (#8987).

## TinaCMS
**Blog:** https://tina.io/blog · **Issues:** https://github.com/tinacms/tinacms/issues (378 open)

### Notable open issues (most active repo this window — activity into July)
- **✨ Rich-text: render semantic `<thead>`/`<th>` for markdown tables in TinaMarkdown** — enhancement (#7169, Jul 7). https://github.com/tinacms/tinacms/issues/7169
- **Reference fields fully hydrate on every keystroke during visual editing → silently exceeds 1MB preview-overlay cap with no error** (#7134, Jul 1). https://github.com/tinacms/tinacms/issues/7134
- **Folder-based collection with `create:false + delete:false` is unnavigable** (#7148, Jul 4). https://github.com/tinacms/tinacms/issues/7148
- **✨ Plugin System — Auth Plugin: better-auth** (v4) (#7092, Jun 23). https://github.com/tinacms/tinacms/issues/7092
- **Split `tinacms build` (pure codegen) from a deploy-time publish gate** — DX enhancement (#7068, Jun 18). https://github.com/tinacms/tinacms/issues/7068
- **Support Markdown plugins in rich-text** (#7075, Jun 22). https://github.com/tinacms/tinacms/issues/7075
- **Editor: pressing Enter inserts line break at wrong position, corrupts bullet lists** (#7096, Jun 25). https://github.com/tinacms/tinacms/issues/7096

## Decap CMS (formerly Netlify CMS)
**Blog:** https://decapcms.org/blog/ · **Issues:** https://github.com/decaporg/decap-cms/issues (559 open)

### Notable open issues
- **🔒 Path traversal in decap-server proxy allows read/write/delete of files outside the configured repo root** — bug (#7875, Jul 5). https://github.com/decaporg/decap-cms/issues/7875
- **Images not rendered in preview starting from v3.13.0** — regression (#7873, Jun 29). https://github.com/decaporg/decap-cms/issues/7873
- **Impossible to login with Forgejo — missing secret** — bug (#7867, Jun 25). https://github.com/decaporg/decap-cms/issues/7867
- **Support open authoring for GitLab** — feature (#7823, May 21). https://github.com/decaporg/decap-cms/issues/7823
- **Soft line breaks in new richtext widget** — bug (#7816, May 19). https://github.com/decaporg/decap-cms/issues/7816
- Multiple recurring runtime crashes in preview/richtext: `Cannot read properties of undefined (reading 'path')` (#7871), `removeChild` NotFoundError (#7870), `Cannot destructure 'url' of 'e.element.data'` (#7869/#7868).

## Builder.io
**Blog:** https://www.builder.io/blog · **Issues:** https://github.com/BuilderIO/builder/issues (62 open)

### Notable open issues
- **🔒 Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** (#4501, Apr 4). https://github.com/BuilderIO/builder/issues/4501
- **`@builder.io/react` fails to install on Node.js 24+ (C++20 compilation requirements)** (#4137, Aug 2025). https://github.com/BuilderIO/builder/issues/4137
- **Add validation to prevent duplicate component names during registration** (#4220, Jan 8). https://github.com/BuilderIO/builder/issues/4220
- **Using `eval` for detecting server code throws CSP error** (#4212, Dec 2025). https://github.com/BuilderIO/builder/issues/4212
- **Storybook 10 support** (#4164, Oct 2025). https://github.com/BuilderIO/builder/issues/4164
- Several open Qwik reactivity / state-merging bugs (#4191, #4165, #4136).

## Medusa (e-commerce)
**Blog:** https://medusajs.com/blog · **Issues:** https://github.com/medusajs/medusa/issues (111 open)

### Notable open issues
- **`/store/products` returns 500 for any category_id / tag_id filter when `index_engine` feature flag enabled** — v2.0 (#15399, May 14). https://github.com/medusajs/medusa/issues/15399
- **Race condition in cart promotions can create duplicate line item adjustments** — v2.0 (#15360, May 11). https://github.com/medusajs/medusa/issues/15360
- **Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`)** (#15306, May 6). https://github.com/medusajs/medusa/issues/15306
- **`@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE** (#15398, May 13). https://github.com/medusajs/medusa/issues/15398
- **`db:sync-links` generates invalid PostgreSQL schema-qualified `RENAME TO`** (#15321, May 7). https://github.com/medusajs/medusa/issues/15321
- **build silently excludes any file path containing the `test` substring** — good first issue (#15341, May 8). https://github.com/medusajs/medusa/issues/15341

---

## Cross-project themes for LumiBase to watch
- **MCP / agent surfaces are becoming table stakes.** Strapi (GA), Directus (native), Payload (plugin) all now expose MCP. Relevant to LumiBase's AI-native / governed-agent positioning.
- **Collaborative & draft-versioning features** shipping in Directus (global draft versions, native collaborative editing) — a competitive reference for content workflow.
- **Recurring failure class: rich-text / preview overlays** (TinaCMS payload cap, Decap richtext crashes, Directus WYSIWYG) — worth stress-testing LumiBase's editor equivalents.
- **Framework upgrade pressure:** Next.js 16.x and Node 22/24 breakage recurring across the JS-based CMSes.

---

*Sources are linked inline. Generated automatically; issue lists reflect the newest-created public issues visible without authentication and are not an exhaustive changelog.*
