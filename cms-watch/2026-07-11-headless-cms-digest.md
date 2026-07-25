# Headless CMS Daily Digest — 2026-07-11

> Automated snapshot from the **GitHub Issues** trackers of 10 popular headless CMS projects. Focus: recently reported bugs, feature requests, security issues, and specs.
> **Note:** This is the **baseline run** (no prior snapshot to diff against), so everything below is reported as the current state of open issues. Future runs will highlight only what changed. Blog RSS/marketing pages are JavaScript-rendered and were not scraped this run; see "Blog sources" at the end for direct links.

## Summary — open-issue backlog

| CMS | Repo | ⭐ Stars | Open issues | Open PRs |
| --- | --- | --- | --- | --- |
| Strapi | strapi/strapi | 72.3k | 396 | 253 |
| Directus | directus/directus | 34.8k | 326 | 55 |
| Payload | payloadcms/payload | 41.8k | 288 | 402 |
| Sanity | sanity-io/sanity | 6.1k | 75 | 49 |
| Ghost | TryGhost/Ghost | 52.8k | 63 | 189 |
| KeystoneJS | keystonejs/keystone | 9.9k | 100 | 48 |
| TinaCMS | tinacms/tinacms | 13.6k | 378 | 32 |
| Decap CMS | decaporg/decap-cms | 19.2k | 559 | 30 |
| Builder.io | BuilderIO/builder | 8.8k | 62 | 24 |
| Medusa | medusajs/medusa | 33k | 111 | 71 |

## Highlights worth a look

- **Security — Strapi (critical/urgent):** `#26494` no rate limiting on `register-admin` + race condition. A security-tagged, urgent-priority issue on the admin auth path.
- **Security — Decap CMS:** `#7875` path traversal in `decap-server` proxy allows read/write/delete of files outside the configured repo root.
- **Security — Builder.io:** `#4501` cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346).
- **Security — Ghost:** `#27445` feature request to add optional malware scanning for uploaded files.
- **Relevant to LumiBase (AI/MCP):** Directus `#27039` MCP `files` tool update action schema mismatch, and Payload `#16214` MCP plugin produces `{ type: 'null' }` for nullable relationship fields — useful references as LumiBase builds its own AI/MCP tooling.

---

## Strapi
Repo: [strapi/strapi](https://github.com/strapi/strapi/issues) · Blog: [strapi.io/blog](https://strapi.io/blog)

- 🔒 **[#26494] no rate limiting on register-admin + race condition** — security, Priority: Urgent, severity: critical, core:admin, v5. Opened May 30, 2026.
- 🐛 **[#26524] firstPublishedAt: entry falsely marked as modified after first publish** — bug, medium, pending reproduction, v5. Opened Jun 2, 2026.
- 🐛 **[#26492] [CI] Nightly release workflow publishes to npm without running tests** — bug, high, tooling. Opened May 30, 2026.
- 🐛 **[#26490] [CI] docker-compose.test.yml missing healthchecks on postgres/mysql** — bug, tooling. Opened May 30, 2026.
- 🐛 **[#26487] Hard refresh / direct access of collections list URL → 500** — bug, high, core:admin, v5. Opened May 29, 2026.
- 🐛 **[#26468] Wildcard characters in filters not escaped → incorrect literal matching** — bug, medium, core:database, v5. Opened May 28, 2026.
- 💬 **[#26463] Community plugin @strapi-community/plugin-seo archived — marketplace policy + Strapi 5 panel API migration** — discussion, marketplace. Opened May 27, 2026.
- 🐛 **[#26434] Content Manager: "Cannot read properties of undefined (reading 'attributes')" navigating Single Types** — bug, Urgent, critical, core:content-manager, v5. Opened May 26, 2026.
- 🐛 **[#26396] "Cannot read properties of undefined (reading 'list')"** — bug, Urgent, critical, core:content-manager, v5. Opened May 20, 2026.
- 🐛 **[#26387] Replace media updates metadata but asset content stays original** — bug, high, core:upload, **confirmed**, v5. Opened May 19, 2026.

## Directus
Repo: [directus/directus](https://github.com/directus/directus/issues) · Blog: [directus.io/blog](https://directus.io/blog)

- 🐛 **[#27091] Save as copy throws error** — bug, High Impact, Regression, Studio, Assets/Files. Opened Apr 10, 2026.
- 🤖 **[#27039] [MCP] files tool update action fails — data schema typed as array but API expects object** — AI/MCP, bug, High Impact. Opened Apr 3, 2026.
- 🐛 **[#27042] WYSIWYG not rendering when returning from edit then revisiting as user (v11.16.1)** — bug, High Impact, UX/DX. Opened Apr 3, 2026.
- 🐛 **[#27028] WYSIWYG not accessible in macOS Safari with a trackpad** — bug, High Impact, Studio, UX/DX. Opened Apr 2, 2026.
- 🐛 **[#27124] GET /permissions/me returns 500 when non-admin policy has `directus_flows:trigger`** — Needs Info. Opened Apr 15, 2026.
- 🐛 **[#27119] Unable to register API extensions hook — `document is not defined`** — bug, Ext SDK, Extensions. Opened Apr 15, 2026.
- 🐛 **[#27111] Apple OAuth first_name/last_name not populated on registration** — Opened Apr 14, 2026.
- 🐛 **[#27003] Aliased GraphQL relational objects within a fragment return null** — bug, GraphQL, Regression, ⚠️ Enterprise. Opened Mar 30, 2026.
- 🐛 **[#27062] [Map Layout] postgis `geometry.Point` geospatial field produces error** — bug, Engine, Needs Info. Opened Apr 7, 2026.
- ✨ **[#27016] Unhelpful error on weak password validation** — improvement, Studio, UX/DX. Opened Mar 31, 2026.

## Payload
Repo: [payloadcms/payload](https://github.com/payloadcms/payload/issues) · Blog: [payloadcms.com/blog](https://payloadcms.com/blog)

- 🐛 **[#16286] @payloadcms/plugin-multi-tenant causes 404 with Next.js 16.2.3 + Turbopack** — plugin: multi-tenant. Opened Apr 15, 2026.
- 🐛 **[#16288] suppressHydrationWarning doesn't work after Next upgrade to 16.2.\*** — area: core. Opened Apr 15, 2026.
- 🐛 **[#16287] Bulk upload into a Folder-enabled upload collection doesn't set the folder** — area: ui. Opened Apr 15, 2026.
- 🐛 **[#16283] Date field `timezone: true` writes empty string to `_tz` enum in Postgres → invalid enum input** — db: postgres. Opened Apr 15, 2026.
- 🐛 **[#16273] Malfunctioning lexical rich text editing in custom block drawer** — richtext-lexical. Opened Apr 14, 2026.
- 🐛 **[#16270] Cache components may cause full page refresh when selecting media** — area: core, needs-triage. Opened Apr 13, 2026.
- 🐛 **[#16262] richtext-lexical: `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported** — richtext-lexical. Opened Apr 13, 2026.
- 🐛 **[#16256] vercelPostgresAdapter fails on large queries (68KB+ SQL, 30+ lateral joins)** — Opened Apr 12, 2026.
- ✨ **[#16250] Dashboard widgets: default `collections` widget prevents customization; `Widget` type omits `imageURL`** — Opened Apr 11, 2026.
- 🤖 **[#16214] [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields** — plugin: mcp. Opened Apr 8, 2026.

## Sanity
Repo: [sanity-io/sanity](https://github.com/sanity-io/sanity/issues) · Blog: [sanity.io/blog](https://www.sanity.io/blog)

- 🐛 **[#12870] Image upload silently stalls when file has no extension — no error shown** — Opened May 24, 2026.
- 🔧 **[#12869] Tests Dashboard & auto-balancing Playwright shards** — internal tooling. Opened May 23, 2026.
- 🐛 **[#12835] Unable to revert to default ordering/layout after manual selection** — Opened May 17, 2026.
- ✨ **[#12834] Include document language (or field values) in edit intent params for `canHandleIntent` routing** — feature. Opened May 15, 2026.
- ✨ **[#12812] Preserve original image metadata / add IPTC metadata on upload** — feature, CLDX. Opened May 10, 2026.
- ✨ **[#12787] Support multiple `typegen` configurations** — feature, CLI. Opened May 5, 2026.
- 🐛 **[#12794] Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio** — SAPP. Opened Apr 16, 2026.
- 🐛 **[#12806] Safari: Presentation Tool "Unable to connect" — cross-origin iframe sandboxing errors** — Opened Apr 5, 2026.
- 🐛 **[#12620] Field presence is not cleared when focus leaves a field** — bug. Opened Apr 13, 2026.
- ✨ **[#12636] Add option to make radio buttons non-clearable** — feature. Opened Apr 14, 2026.

## Ghost
Repo: [TryGhost/Ghost](https://github.com/TryGhost/Ghost/issues) · Blog: [ghost.org/resources](https://ghost.org/resources/)

- 🔒 **[#27445] Security: add optional malware scanning for uploaded files (pompelmi)** — needs:triage. Opened Apr 17, 2026.
- 🐛 **[#27415] Share button broken — portal.min.js not loaded when subscriptions disabled** — needs:triage. Opened Apr 15, 2026.
- ✨ **[#27717] Document HelmForge chart as a third-party Kubernetes install option** — needs:triage. Opened May 6, 2026.
- 🐛 **[#27551] Signup Card email placeholder hardcoded ("Your email"), no i18n/per-card override** — needs:triage. Opened Apr 25, 2026.
- ✨ **[#27478] [Feature] Set excerpt length to 2000 characters** — needs:triage. Opened Apr 21, 2026.
- 🐛 **[#26905] HTML entities visible in email (inbox) in publication date** — community. Opened Mar 20, 2026.
- 🐛 **[#26677] Admin API always saves revisions even when `save_revision=false`** — needs:triage. Opened Mar 3, 2026.
- 🐛 **[#26607] Editor opening staff settings triggers forbidden API calls + permission toast** — needs:triage. Opened Feb 26, 2026.
- 🐛 **[#26399] Unhandled `JSON.parse()` in Portal `fetchQueryStrData()` crashes widget on malformed preview URLs** — community. Opened Feb 14, 2026.
- 📌 Tracking mega-issues: **[#23924] 🔥 Breaking Changes for 6.0**, **[#23361] 🌐 i18n mega-issue**.

## KeystoneJS
Repo: [keystonejs/keystone](https://github.com/keystonejs/keystone/issues) · Blog: [keystonejs.com/blog](https://keystonejs.com/blog)

- ⬆️ **[#9798] Bump Next to >15.5.13** — dependencies. Opened Apr 3, 2026.
- ✨ **[#9789] Should Keystone enforce GraphQL query depth limits by default?** — feature (security-adjacent). Opened Mar 18, 2026.
- 🐛 **[#9785] `statelessSessions` uses unsupported `Authorization: Basic` header instead of cookie** — discussion/docs/help wanted. Opened Mar 6, 2026.
- 🐛 **[#9779] `npm run dev` fails with EPERM on Windows** — Opened Feb 20, 2026.
- 🐛 **[#9772] Error loading single entity — `ID!` used where `IDFilter` expected** — Opened Feb 3, 2026.
- 🐛 **[#9765] Admin UI unhandled runtime error editing Post on fresh CLI install** — Opened Jan 24, 2026.
- 🐛 **[#9753] Access operation function called with no session during successful login** — Opened Dec 18, 2025.
- 🐛 **[#9665] Field editable when `graphql.omit.update` is set** — bug, help wanted. Opened Jul 22, 2025.
> Note: Keystone's tracker is comparatively low-velocity; several "recent" open issues date back months.

## TinaCMS
Repo: [tinacms/tinacms](https://github.com/tinacms/tinacms/issues) · Blog: [tina.io/blog](https://tina.io/blog)

- ✨ **[#7169] Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown** — enhancement, rich-text. Opened Jul 7, 2026.
- 🐛 **[#7162] Starter template 'basic' fails install with yarn on Node 22** — bug (CI bot). Opened Jul 6, 2026.
- 🐛 **[#7148] Folder-based collection with create:false + delete:false is unnavigable** — bug, pending triage. Opened Jul 4, 2026.
- 🐛 **[#7134] Reference fields fully hydrate on every keystroke during visual editing, exceeding 1MB preview-overlay cap silently** — Opened Jul 1, 2026.
- 🐛 **[#7116] Save button stays enabled after successful save until clicked again** — bug, v4. Opened Jun 30, 2026.
- 📝 **[#7118] Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export)** — Astro. Opened Jun 30, 2026.
- 🐛 **[#7096] Pressing Enter in editor inserts line break at wrong position, corrupts bullet list** — Needs Refinement. Opened Jun 25, 2026.
- ✨ **[#7092] Plugin System — Auth Plugin — better-auth** — technical-debt, v4. Opened Jun 23, 2026.
- ✨ **[#7075] Markdown — support Markdown plugins** — rich-text, for 4.1. Opened Jun 22, 2026.
- ✨ **[#7068] Split `tinacms build` (pure codegen) from deploy-time publish gate** — @tinacms/cli, dx, enhancement. Opened Jun 18, 2026.
- ✨ **[#7067] Deploy schema gate should wait for schemaSha convergence, not one-shot compare** — @tinacms/cli, dx. Opened Jun 18, 2026.
> TinaCMS is the most active tracker this window (multiple issues opened in early July 2026).

## Decap CMS
Repo: [decaporg/decap-cms](https://github.com/decaporg/decap-cms/issues) · Blog: [decapcms.org/blog](https://decapcms.org/blog/)

- 🔒 **[#7875] Path traversal in decap-server proxy — read/write/delete files outside repo root** — bug (security). Opened Jul 5, 2026.
- 🐛 **[#7873] Images not rendered in preview since Decap CMS v3.13.0** — bug. Opened Jun 29, 2026.
- 🐛 **[#7871] TypeError: Cannot read properties of undefined (reading 'path')** — Opened Jun 29, 2026.
- 🐛 **[#7870] NotFoundError: `removeChild` — node to be removed is not a child** — Opened Jun 28, 2026.
- 🐛 **[#7869 / #7868] TypeError: Cannot destructure property 'url' of 'e.element.data' (undefined)** — duplicate reports. Opened Jun 28, 2026.
- 🐛 **[#7867] Impossible to login with Forgejo — missing secret** — bug. Opened Jun 25, 2026.
- ✨ **[#7823] Support open authoring for GitLab** — feature. Opened May 21, 2026.
- 🐛 **[#7816] Soft line breaks in new richtext widget** — bug. Opened May 19, 2026.
- 🐛 **[#7802] Can't copy and paste into Rich Text** — bug, richtext. Opened May 4, 2026.
- 🐛 **[#7800] Preview pane stops accepting scroll events after resizing form/preview divider** — bug, preview-pane. Opened May 2, 2026.

## Builder.io
Repo: [BuilderIO/builder](https://github.com/BuilderIO/builder/issues) · Blog: [builder.io/blog](https://www.builder.io/blog)

- 🔒 **[#4501] Security: cross-origin code execution via unvalidated postMessage in builder-block (CWE-346)** — Opened Apr 4, 2026.
- ✨ **[#4220] Add validation to prevent duplicate component names during registration** — Opened Jan 8, 2026.
- 🐛 **[#4219] Vue 3 — Extraneous non-props attributes warning** — Opened Dec 19, 2025.
- 🐛 **[#4212] Using `eval` for detecting server code throws CSP error** — Opened Dec 15, 2025.
- 🐛 **[#4191] EnableEditor state merging breaks reactivity of blocks in Qwik** — Opened Nov 25, 2025.
- 🐛 **[#4166] State stored is extremely wasteful** — Opened Oct 25, 2025.
- 🐛 **[#4164] Storybook 10 support** — Opened Oct 20, 2025.
- 🐛 **[#4137] @builder.io/react fails to install on Node.js 24+ (C++20 compilation)** — Opened Aug 30, 2025.
> Note: Builder.io's public tracker is slow-moving; newest open issue dates to Apr 2026.

## Medusa (e-commerce)
Repo: [medusajs/medusa](https://github.com/medusajs/medusa/issues) · Blog: [medusajs.com/blog](https://medusajs.com/blog)

- 🐛 **[#15399] /store/products returns 500 for any category_id/tag_id filter when index_engine flag enabled** — needs triaging, v2.0. Opened May 14, 2026.
- 🐛 **[#15398] @medusajs/icons peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE** — bug, requires-team. Opened May 13, 2026.
- 🐛 **[#15360] Race condition in cart promotions can create duplicate line item adjustments** — bug, requires-team, v2.0. Opened May 11, 2026.
- 🐛 **[#15371] RTL layout issues in admin dashboard for Hebrew/Arabic/Farsi** — bug, help-wanted. Opened May 11, 2026.
- 🐛 **[#15353] Error sorting orders by Total / Fulfillment status / Payment status** — bug, good first issue, v2.0. Opened May 10, 2026.
- 🐛 **[#15343] getDatabaseURL in @medusajs/test-utils breaks for passwords with special URL chars** — bug, v2.0. Opened May 8, 2026.
- 🐛 **[#15341] Build silently excludes any file path containing 'test' substring** — bug, good first issue. Opened May 8, 2026.
- 🐛 **[#15321] db:sync-links generates invalid Postgres "ALTER TABLE schema.old RENAME TO schema.new"** — bug, help-wanted. Opened May 7, 2026.
- 🐛 **[#15306] Refund workflow reports success after partial refund failures (silent failure)** — bug, needs triaging. Opened May 6, 2026.
- 🐛 **[#15300] `medusa db:migrate` exit code** — bug, v2.0. Opened May 5, 2026.
- 📝 **[#15406] Local dev setup for contributors is confusing, undocumented, lacks hot reload for plugins** — docs. Opened May 14, 2026.

---

## Blog sources (for manual/next-run review)
JS-rendered blog pages were not scraped this run. Direct links:
Strapi [blog](https://strapi.io/blog) · Directus [blog](https://directus.io/blog) · Payload [blog](https://payloadcms.com/blog) · Sanity [blog](https://www.sanity.io/blog) · Ghost [resources](https://ghost.org/resources/) · Keystone [blog](https://keystonejs.com/blog) · Tina [blog](https://tina.io/blog) · Decap [blog](https://decapcms.org/blog/) · Builder [blog](https://www.builder.io/blog) · Medusa [blog](https://medusajs.com/blog)

## Method & caveats
- Source: each project's GitHub Issues list (open issues, default newest-first), fetched 2026-07-11.
- Issue "type" icons (🐛 bug, ✨ feature/enhancement, 🔒 security, 📝 docs, ⬆️ deps, 💬 discussion, 🤖 AI/MCP) are inferred from GitHub labels and titles; where a repo doesn't label consistently, classification is by title.
- Only the first page (~12) of each tracker was captured, so this is the freshest slice, not the full backlog.
- Baseline run: no day-over-day diff yet. Subsequent runs should compare issue numbers against this file to surface only newly opened/closed items.
