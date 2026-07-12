# Headless CMS — Daily Update Digest

**Date:** 2026-07-12 · **Run:** automated (scheduled task, 09:03 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-12 06:03 (+07)

> Sources this run: each project's **GitHub Issues** page (open-issue counts + newest open issues with ID/title/labels/open-date), fetched live and verified this cycle for all 10. **Blogs** were not re-hydrated this cycle (client-rendered pages return shells without JS); "latest blog post" lines are **carried forward** from the last verified run and marked `[Unverified this cycle]`. Version numbers not printed on a fetched page are `[Unverified]`. Security-severity characterizations beyond a label/title the vendor itself applied are `[Inference]` (based on title/topic, not a confirmed advisory/CVE unless a CVE is named).

---

## TL;DR — Changes since previous run (2026-07-12 06:03)

**GitHub issues: no change.** All 10 trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 06:03 run. Verified live this run. The last new issue observed across all trackers remains **TinaCMS #7169** (Jul 7).

**Blogs: not re-verified this cycle** — carried forward. Most recent activity on record: **Directus** — "AI is straining vulnerability disclosure for maintainers" (Jul 10) · **Builder.io** — "How KPMG Closed the Design-to-Engineering Gap" (Jul 6) · **Medusa** — "Announcing new Layout Composer in Medusa Admin" (Jul 1).

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**Top action items (security-grade, all persist):** **Strapi #26494** (no rate limit on `register-admin` + race condition — vendor-labeled security/critical/urgent) · **Decap #7875** (path traversal in decap-server proxy — read/write/delete outside repo root) · **Builder.io #4501** (postMessage cross-origin code execution, CWE-346, vendor title). Also on record: **Strapi** batch security disclosure (CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886) published May 13.

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post (carried fwd) | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | "The Strapi MCP server is now GA" — Jun 29 `[Unverified this cycle]` | #26494 register-admin rate limit (vendor: security/critical) |
| Directus | 326 | #27129 (Apr 15) | "AI is straining vulnerability disclosure for maintainers" — Jul 10 `[Unverified this cycle]` | #27094 outdated openid-client `[Inference]` |
| Payload | 288 | #16288 (Apr 15) | "An early look at Payload 4.0" — Jun 9 `[Unverified this cycle]` | #16214 MCP plugin null-type `[Inference]` |
| Sanity | 75 | #12870 (May 24) | "Skills are how your company works…" — Jun 22 `[Unverified this cycle]` | #12794 preview secret → wrong dataset `[Inference]` |
| Ghost | 63 | #27717 (May 6) | Resources library (evergreen); running Ghost 6.51 `[Unverified this cycle]` | #27445 upload malware-scan (feature req) |
| KeystoneJS | 100 | #9798 (Apr 3) | "A year of releases in review" — Aug 7 2024 (blog stale) `[Unverified this cycle]` | #9789 GraphQL depth-limit `[Inference]` |
| TinaCMS | 378 | #7169 (Jul 7) | "Separate Content Repos are here for TinaCloud" — Jun 12 `[Unverified this cycle]` | — |
| Decap | 559 | #7875 (Jul 5) | "Announcing Decap Turbo" — May 5 `[Unverified this cycle]` | #7875 path traversal (vendor: bug) |
| Builder.io | 62 | #4501 (Apr 4) | "How KPMG Closed the Design-to-Engineering Gap" — Jul 6 `[Unverified this cycle]` | #4501 postMessage RCE (CWE-346, vendor title) |
| Medusa | 111 | #15406 (May 14) | "Announcing new Layout Composer in Medusa Admin" — Jul 1 `[Unverified this cycle]` | #15360 promo race / #15306 refund `[Inference]` |

**Cross-cutting signals:** (1) **Framework-migration friction** remains the dominant bug driver — Next.js 16.2 / Turbopack on Payload (#16286, #16288), Node 22/24 on TinaCMS (#7162, #7109) and Builder.io (#4137), React 19 peer-dep conflicts on Medusa (#15398), Next >15.5.13 bump on Keystone (#9798). (2) **AI/agent tooling** stays the dominant blog theme across nearly every vendor — MCP servers (Strapi GA, Payload 4.0, Directus, Sanity) and agent-native workflows (Ghost's `agentic-workflows` label appears on #26644). (3) Two still-open trust-boundary vulns (Decap path traversal #7875, Builder postMessage RCE #4501) remain unresolved.

---

## Strapi
**Open issues:** 396 (verified). Stars ~72.3k · Forks 9.7k. · Issues: https://github.com/strapi/strapi/issues · Blog: https://strapi.io/blog

**Newest / notable open issues (verified this run):**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / pending reproduction / v5 — Jun 2, 2026
- **#26494** — no rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching — bug / severity: medium / core:database / v5 — May 28, 2026
- **#26463** — Community plugin `@strapi-community/plugin-seo` archived — marketplace policy + Strapi 5 panel API migration — discussion / marketplace — May 27, 2026
- **#26437** — Plugin SEO error when select (from sidebar) — bug — May 26, 2026
- **#26434** — Content Manager "Cannot read properties of undefined (reading 'attributes')" navigating Single Types — bug / Urgent / critical / core:content-manager / v5 — May 26, 2026
- **#26396** — "Cannot read properties of undefined (reading 'list')" — bug / Urgent / critical / content-manager / v5 — May 20, 2026

**Blog (carried forward, `[Unverified this cycle]`):** "The Strapi MCP server is now GA" — Jun 29 · "June Community Call Recap" — Jun 29 · "Release roundup: March–June 2026" — Jun 18 · Security disclosure (CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886) — May 13.

---

## Directus
**Open issues:** 326 (verified). Stars ~34.8k · Forks 4.7k. · Issues: https://github.com/directus/directus/issues · Blog: https://directus.io/blog

**Newest / notable open issues (verified this run):**
- **#27129** — Back button broken for all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` permission — Needs Info — Apr 15, 2026
- **#27119** — Unable to register API extensions hook because `document` is not defined — Bug / Ext SDK / Extensions / Low Impact — Apr 15, 2026
- **#27111** — Apple OAuth `first_name` / `last_name` not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` uses an old version of tsdown and openid-client — Apr 11, 2026 `[Inference: dependency freshness / potential security relevance]`
- **#27091** — Save-as-copy throws error — Bug / Assets/Files / High Impact / Regression / Studio — Apr 10, 2026
- **#27062** — [Map Layout] postgis `geometry.Point` geospatial field produces error — Bug / Engine — Apr 7, 2026
- **#27042** — WYSIWYG not rendering when returning from edit (non-admin user), v11.16.1 — Bug / High Impact — Apr 3, 2026
- **#27039** — [MCP] files tool update action fails — data schema typed as array but API expects object — AI/MCP / Bug / High Impact — Apr 3, 2026
- **#27028** — WYSIWYG not accessible in macOS Safari when using a trackpad — Bug / High Impact / Studio — Apr 2, 2026
- **#27016** — Unhelpful error on weak password validation — Improvement / Low Impact / Studio — Mar 31, 2026
- **#27003** — Aliased GraphQL relational objects within a fragment return null — Bug / GraphQL / Regression / Enterprise — Mar 30, 2026

**Blog (carried forward, `[Unverified this cycle]`):** "AI is straining vulnerability disclosure for maintainers" — Jul 10.

---

## Payload CMS
**Open issues:** 288 (verified). Stars ~41.8k · Forks 3.6k. · Issues: https://github.com/payloadcms/payload/issues · Blog: https://payloadcms.com/blog

**Newest / notable open issues (verified this run):**
- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → `invalid input value for enum` — db: postgres / invalid-reproduction — Apr 15, 2026
- **#16273** — Malfunctioning lexical rich-text editing in custom block drawer — plugin: richtext-lexical — Apr 14, 2026
- **#16270** — Cache components may cause full page refresh when selecting media — area: core / needs-triage — Apr 13, 2026
- **#16262** — `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported (richtext-lexical) — Apr 13, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) — Apr 12, 2026
- **#16251** — Table header misalignment with `orderable: true` — area: ui / needs-triage — Apr 11, 2026
- **#16250** — Dashboard widgets: unconditional default `collections` widget prevents customization; `Widget` type omits `imageURL` — Apr 11, 2026
- **#16221** — Overflow issues in nav bar in 'edit dashboard' mode — area: ui / needs-triage — Apr 9, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — Apr 8, 2026 `[Inference: AI/MCP tooling]`

**Blog (carried forward, `[Unverified this cycle]`):** "An early look at Payload 4.0" — Jun 9.

---

## Sanity
**Open issues:** 75 (verified). Stars ~6.1k · Forks 538. · Issues: https://github.com/sanity-io/sanity/issues · Blog: https://www.sanity.io/blog

**Pinned:** Dependency Dashboard (#12568, bot).

**Newest / notable open issues (verified this run):**
- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — May 24, 2026
- **#12869** — Tests Dashboard & auto-balancing Playwright shards — May 23, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature: include document language (or field values) in edit intent params for `canHandleIntent` routing — Feature — May 15, 2026
- **#12812** — Feature: preserve original image metadata / add IPTC metadata on photo upload — CLDX / Feature — May 10, 2026
- **#12787** — Feature: support multiple `typegen` configurations — CLI / Feature — May 5, 2026
- **#12733** — Unable to create account on sign-up page — "Password is too weak" for a strong password — identity / Bug — Apr 22, 2026
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — Apr 16, 2026 `[Inference: potential secret-leak across datasets]`
- **#12636** — Add option to make radio buttons non-clearable — Feature — Apr 14, 2026
- **#12620** — Field presence not cleared when focus leaves a field — Bug — Apr 13, 2026
- **#12806** — Safari: Presentation Tool "Unable to connect" — cross-origin iframe sandboxing errors — Apr 5, 2026

**Blog (carried forward, `[Unverified this cycle]`):** "Skills are how your company works…" — Jun 22.

---

## Ghost
**Open issues:** 63 (verified). Stars ~52.8k · Forks 11.5k. · Issues: https://github.com/TryGhost/Ghost/issues · Resources: https://ghost.org/resources/

**Pinned:** 🔥 Breaking Changes for 6.0 (#23924) · 🌐 i18n mega-issue (#23361) · Dependency Dashboard (#13265).

**Newest / notable open issues (verified this run):**
- **#27717** — Document HelmForge chart as a third-party Kubernetes installation option — needs:triage — May 6, 2026
- **#27551** — Signup Card email input placeholder hardcoded ("Your email"), no i18n / per-card override — needs:triage — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — needs:triage — Apr 17, 2026
- **#27415** — Share button broken because `portal.min.js` isn't loaded when subscriptions disabled — needs:triage — Apr 15, 2026
- **#26905** — HTML entities visible in email (inbox) in publication date — community — Mar 20, 2026
- **#26677** — 🐛 Admin API always saves revisions even when `save_revision=false` — needs:triage — Mar 3, 2026
- **#26644** — [aw] No-Op Runs — agentic-workflows — Mar 2, 2026
- **#26607** — Editor opening staff settings/profile triggers forbidden API calls + unrelated permission toast — needs:triage — Feb 26, 2026
- **#26439** — [Accessibility] Add translucent background behind video controls — needs:triage — Feb 17, 2026
- **#26399** — Unhandled `JSON.parse()` exceptions in Portal's `fetchQueryStrData()` crash widget on malformed preview URLs — community — Feb 14, 2026
- **#26398** — Regression: email toggles — needs:triage — Feb 13, 2026

**Blog (carried forward, `[Unverified this cycle]`):** Resources library (evergreen); running Ghost 6.51.

---

## KeystoneJS
**Open issues:** 100 (verified). Stars ~9.9k · Forks 1.3k. · Issues: https://github.com/keystonejs/keystone/issues · Blog: https://keystonejs.com/blog

**Pinned:** Node 20 (LTS) support (#8987, opened Jan 2024, still open).

**Newest / notable open issues (verified this run):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query depth limits by default? — Feature — Mar 18, 2026 `[Inference: DoS-hardening relevance]`
- **#9785** — `statelessSessions` attempts to use unsupported `Authorization: Basic` header rather than the cookie — discussion / docs / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — Error loading single entity: "ID!" used in position expecting type "IDFilter" — Feb 3, 2026
- **#9766** — Document Fields Demo page refers to a form that doesn't exist — Jan 24, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing Post on fresh CLI install — Jan 24, 2026
- **#9753** — Access operation function called with no session during successful login — Dec 18, 2025
- **#9712** — Admin UI not working as expected for extended / merged list schema — Sep 23, 2025
- **#9665** — Field editable when `graphql.omit.update` is set — Bug / help wanted — Jul 22, 2025
- **#9657** — JSON fields and SQLite has no Prisma default — Bug — Jul 16, 2025

**Note:** activity remains slow (newest open issue is Apr 3). Blog carried forward is stale ("A year of releases in review" — Aug 2024).

---

## TinaCMS
**Open issues:** 378 (verified). Stars ~13.6k · Forks 730. · Issues: https://github.com/tinacms/tinacms/issues · Blog: https://tina.io/blog

**Newest / notable open issues (verified this run) — most-recently-active tracker this cycle:**
- **#7169** — ✨ Rich-text: render semantic `<thead>`/`<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template 'basic' failed during install with yarn using Node 22 — bug — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` unnavigable — single-doc auto-open fires inside folder views — bug / pending triage — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing → silently exceed 1MB preview-overlay cap, no error — Jul 1, 2026
- **#7118** — 📝 Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export) — Astro — Jun 30, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 / YakShaver — Jun 30, 2026
- **#7109** — Starter 'tina-astro-starter' failed during build with npm using Node 24 — bug — Jun 28, 2026
- **#7096** — 🐛 Pressing Enter in editor inserts line break at wrong position and corrupts bullet-list formatting — Needs Refinement / YakShaver — Jun 25, 2026
- **#7092** — ✨ Plugin System — Auth Plugin — better-auth — technical-debt / v4 — Jun 23, 2026
- **#7075** — Markdown — support Markdown plugins — For 4.1 / rich-text — Jun 22, 2026
- **#7068 / #7067** — Split `tinacms build` (pure codegen) from deploy-time publish gate; schema gate should wait for `schemaSha` convergence — cli / dx / enhancement — Jun 18, 2026

**Note:** issue creation is restricted in this repo (bot/maintainer-driven intake). **Blog (carried forward, `[Unverified this cycle]`):** "Separate Content Repos are here for TinaCloud" — Jun 12.

---

## Decap CMS
**Open issues:** 559 (verified). Stars ~19.2k · Forks 3.1k. · Issues: https://github.com/decaporg/decap-cms/issues · Blog: https://decapcms.org/blog/

**Newest / notable open issues (verified this run):**
- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside the configured repository root — type: bug — Jul 5, 2026 `[Security-relevant; vendor labeled 'bug', no CVE named]`
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871** — `TypeError: Cannot read properties of undefined (reading 'path')` — Jun 29, 2026
- **#7870** — `NotFoundError: Failed to execute 'removeChild' on 'Node'` — Jun 28, 2026
- **#7869 / #7868** — `TypeError: Cannot destructure property 'url' of 'e.element.data'` — Jun 28, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026
- **#7816** — Soft line breaks in new richtext widget — type: bug — May 19, 2026
- **#7802** — Can't copy and paste into Rich Text — richtext / type: bug — May 4, 2026
- **#7801** — `TypeError: this.props.value?.get is not a function` — May 2, 2026
- **#7800** — Preview pane stops accepting scroll events after resizing the form/preview divider — type: bug — May 2, 2026

**Note:** issue creation is restricted in this repo. **Blog (carried forward, `[Unverified this cycle]`):** "Announcing Decap Turbo" — May 5.

---

## Builder.io
**Open issues:** 62 (verified). Stars ~8.8k · Forks 1.2k. · Issues: https://github.com/BuilderIO/builder/issues · Blog: https://www.builder.io/blog

**Newest / notable open issues (verified this run):**
- **#4501** — **Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** — Apr 4, 2026 `[Security-relevant; vendor title cites CWE-346, no CVE named]`
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4219** — Vue 3 "[Vue warn]: Extraneous non-props attributes" — Dec 19, 2025
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4191** — EnableEditor state merging breaks reactivity of blocks in Qwik — Nov 25, 2025
- **#4166** — State stored is extremely wasteful — Oct 25, 2025
- **#4165** — Qwik temporary code not reverted yet inside content component — Oct 23, 2025
- **#4164** — Storybook 10 support — Oct 20, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements — Aug 30, 2025
- **#4136** — Localized tests trigger `useComputed$` mutation state warnings — Aug 26, 2025
- **#4124** — Nuxt 3 examples preview environment broken for initial SSR loads (fix attached) — Jul 31, 2025

**Note:** slow tracker (newest open issue Apr 4). Blog carried forward: "How KPMG Closed the Design-to-Engineering Gap" — Jul 6.

---

## Medusa
**Open issues:** 111 (verified). Stars ~33k · Forks 4.4k. · Issues: https://github.com/medusajs/medusa/issues · Blog: https://medusajs.com/blog

**Newest / notable open issues (verified this run):**
- **#15406** — Local dev setup for contributors confusing, undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — [Bug] `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — needs triaging / v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE in npm workspaces — type: bug — May 13, 2026
- **#15371** — bug(dashboard): RTL layout issues for Hebrew/Arabic/Farsi — help-wanted / type: bug — May 11, 2026
- **#15360** — [Bug] Race condition in cart promotions can create duplicate line-item adjustments — requires-team / type: bug / v2.0 — May 11, 2026 `[Inference: data-integrity/financial impact]`
- **#15353** — [Bug] Error sorting orders by Total / Fulfillment status / Payment status — good first issue / v2.0 — May 10, 2026
- **#15343** — [Bug] `getDatabaseURL` in `@medusajs/test-utils` breaks for passwords with special URL chars (#, @, :) — v2.0 — May 8, 2026
- **#15341** — Build silently excludes any file path containing 'test' substring (`Compiler.backendIgnoreFiles`) — good first issue — May 8, 2026
- **#15321** — `db:sync-links` generates invalid PostgreSQL schema-qualified `ALTER TABLE ... RENAME TO` — help-wanted / type: bug — May 7, 2026
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — needs triaging / type: bug — May 6, 2026 `[Inference: financial correctness]`
- **#15300** — [Bug] `medusa db:migrate` exit code — type: bug / v2.0 — May 5, 2026
- **#15283** — Limited visibility of text due to AI message bubble — feedback — May 3, 2026

**Blog (carried forward, `[Unverified this cycle]`):** "Announcing new Layout Composer in Medusa Admin" — Jul 1.

---

## Methodology & caveats
- GitHub Issues pages fetched live and parsed this run for all 10 repositories; open-issue counts, newest issue IDs, titles, labels, and open-dates are taken directly from the fetched pages.
- GitHub content is served via cached snapshots; snapshot request timestamps varied across repos, so "newest open issue" reflects the most recent snapshot available this cycle, not necessarily the second-by-second live tracker.
- Blog "latest post" lines are **carried forward** from the last verified run and labeled `[Unverified this cycle]` — vendor blogs are client-rendered and return empty shells to a plain fetch.
- Security characterizations: only labels/titles the vendor itself applied are treated as fact. Any severity/impact framing beyond that is marked `[Inference]`. Named CVEs are reproduced as published.
- Reality filter: any figure not printed on a fetched page is marked `[Unverified]`.
