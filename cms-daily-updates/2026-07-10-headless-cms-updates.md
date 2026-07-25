# Headless CMS — Daily Update Digest

**Date:** 2026-07-10 · **Run:** automated (scheduled task) · **Coverage:** 10 headless CMS projects
**Last refreshed:** 2026-07-10 23:05 (+07) — third run of the day (verification pass)

> Sources: each project's GitHub Issues page (server-rendered), re-fetched live this run. Version/release prose is carried forward from the earlier run today (web search of official changelogs) and is **not** re-verified this run — treat it as `[Unverified]` unless dated. Issue numbers and dates are quoted as shown on GitHub. Where a fact could not be verified, it is labeled `[Unverified]`.

---

## 🔁 Re-run verification — 2026-07-10 23:05 (+07)

A third scheduled pass re-fetched all 10 GitHub issue trackers directly. **No change since the 22:05 run.** Every tracker returned the identical newest open issue (same ID, title, and open date) and identical open-issue count as recorded below. A web-search sweep for any release/CVE dated after the 22:05 run surfaced **nothing new** — the only security items returned are the already-tracked Ghost CVEs (**CVE-2026-26980** SQLi and **CVE-2026-29053** theme RCE, both fixed in **6.19.1**).

Newest-open confirmed this pass: Strapi Jun 2 (#26524) · Directus Apr 15 (#27129) · Payload Apr 15 (#16288) · Sanity May 24 (#12870) · Ghost May 6 (#27717) · KeystoneJS Apr 3 (#9798) · TinaCMS Jul 7 (#7169) · Decap Jul 5 (#7875) · Builder.io Apr 4 (#4501) · Medusa May 14 (#15406).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

Freshest tracker items across all 10 remain **TinaCMS #7169** (Jul 7 — semantic `<thead>/<th>` for markdown tables) and **Decap #7875** (Jul 5 — path-traversal in decap-server proxy, critical). Nothing new to action.

---

## Changes since previous run (2026-07-10 16:07)

No new GitHub issue activity in the last ~6 hours: the newest open issue in every one of the 10 repositories is unchanged from the earlier run. Confirmed newest-open dates — Strapi Jun 2 (#26524), Directus Apr 15 (#27129), Payload Apr 15 (#16288), Sanity May 24 (#12870), Ghost May 6 (#27717), KeystoneJS Apr 3 (#9798), TinaCMS Jul 7 (#7169), Decap Jul 5 (#7875), Builder.io Apr 4 (#4501), Medusa May 14 (#15406).

This run additionally captured a handful of open issues that were live but not listed in the earlier digest (folded into the per-project sections below and marked `[+]`): Directus #27129, #27124, #27111, #27094; Ghost #27478; KeystoneJS #9772, #9753; TinaCMS #7118; Decap #7870/#7869/#7868, #7801, #7800; Medusa #15353, #15343, #15341, #15321, #15300, #15283. None are newer than the earlier run — they surfaced from reading deeper into each open-issue list, not from new activity.

Open-issue counts this run: Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

---

## At a glance

| CMS | Latest version | Recent theme | Security items this cycle |
| --- | --- | --- | --- |
| Strapi | 5.50.0 | Relation lifecycle + admin perf | #26494 register-admin rate limit (critical) |
| Directus | v11.17.2 | AI/MCP tooling, content versioning | — |
| Payload | v3.85.1 (4.0 pre-alpha) | Next.js 16.2 compat, admin redesign | — |
| Sanity | v6.2.0 | AI "skills" CLI, Content Releases | — |
| Ghost | rolling (6.0 in progress) | Member automation, i18n | #27445 malware scan (feature) |
| KeystoneJS | 6.5.2 | Security hardening | isFilterable/cursor fix; depth-limit proposal |
| TinaCMS | @tinacms/search 1.2.21 | v4 track, visual-editor UX | — |
| Decap | v3.11.0 (npm 3.14.1) | Plate richtext, Git backends | #7875 path traversal (critical) |
| Builder.io | SDK (no single tag) | Qwik reactivity, CSP | #4501 postMessage RCE |
| Medusa | v2.16.0 | Async payments, price tiers | refund/promotion reliability bugs |

Notable cross-cutting signals: **AI/MCP tooling** is now a first-class roadmap item at Directus, Payload, Sanity and Ghost; **Next.js 16.2 / React 19 migration friction** is hitting Payload and Medusa; and there are **three security-grade issues open** (Strapi #26494, Decap #7875, Builder.io #4501) worth watching.

---

## Strapi
**Latest release / version:** 5.50.0. Recent work: relation improvements during the publish lifecycle (self-referential relations preserved through publish/discard; hidden inverse relations no longer dropped), admin performance (progressive homepage widget rendering, batched permission checks, faster DB migrations), and a new `publicationFilter` parameter to query draft + published content in one call across REST, document service, and GraphQL. Strapi 4 reached End of Life (formally marked in v5.46.0), with five CVEs patched for v4 LTS as a final courtesy.

**Recent notable issues (GitHub):**

- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / v5 — opened Jun 2, 2026
- **#26494** — No rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — opened May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — opened May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — opened May 29, 2026
- **#26468** — Wildcard characters in filters not escaped, causing incorrect literal matching — bug / severity: medium / core:database / v5 — opened May 28, 2026
- **#26387** — Replace media updates metadata but asset content remains original file — bug / severity: high / core:upload / **status: confirmed** / v5 — opened May 19, 2026

**Notable specs / in progress:** Content Manager stability (multiple "Cannot read properties of undefined" crashes: #26434, #26396, #26389) and the SEO plugin/marketplace panel-API migration (#26463, #26437).

---

## Directus
**Latest release / version:** v11.17.2 (Apr 6, 2026). Recent releases add timezone-aware datetime display, corrected data exports (alias fields excluded), fixed invite-acceptance error translations, and persistent relational-field removals in draft items. v11.16.0 introduced automatic global draft versions for content versioning and an AI Assistant that can process images/PDFs across OpenAI, Anthropic, and Google Gemini.

**Recent notable issues (GitHub):**

- **#27119** — "Unable to register API extensions hook because document is not defined" — bug / Ext SDK / Extensions — opened Apr 15, 2026
- **#27091** — "Save as copy" throws error — bug / regression / high impact / Studio — opened Apr 10, 2026
- **#27062** — [Map Layout] PostGIS `geometry.Point` geospatial field produces error — bug / Engine — opened Apr 7, 2026
- **#27042** — WYSIWYG not rendering when returning from edit then revisiting record (v11.16.1) — bug / high impact — opened Apr 3, 2026
- **#27039** — [MCP] files tool update action fails — data schema typed as array but API expects object — bug / AI-MCP / high impact — opened Apr 3, 2026
- **#27003** — Aliased GraphQL relational objects within a fragment return null — bug / GraphQL / regression / Enterprise — opened Mar 30, 2026
- `[+]` **#27129** — Back button broken for all item pages — Needs Info — opened Apr 15, 2026
- `[+]` **#27124** — `GET /permissions/me` returns 500 when a non-admin policy has `directus_flows:trigger` permission — Needs Info — opened Apr 15, 2026
- `[+]` **#27111** — Apple OAuth `first_name`/`last_name` not populated on registration — opened Apr 14, 2026
- `[+]` **#27094** — `@directus/api` shipping an old version of `tsdown` + `openid-client` — opened Apr 11, 2026

**Notable specs / in progress:** Heavy investment in AI/MCP tooling (MCP files tool, multimodal AI Assistant) and content versioning with automatic global drafts. Open regressions cluster around the Studio WYSIWYG editor and GraphQL fragments.

---

## Payload CMS
**Latest release / version:** v3.85.1 (Jun 9, 2026); v3.85.0 (May 26, 2026) took `plugin-import-export` out of beta with collection- and field-level hook support. **Payload 4.0** is in active development (pre-alpha, not for production), headlined by an admin UI redesign plus hierarchy, DAM, and AI/MCP workflow improvements.

**Recent notable issues (GitHub):**

- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — opened Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — opened Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → invalid enum error — db: postgres — opened Apr 15, 2026
- **#16273** — Malfunctioning Lexical rich-text editing in custom block drawer — plugin: richtext-lexical — opened Apr 14, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) — bug — opened Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — opened Apr 8, 2026

**Notable specs / in progress:** 4.0 preview centers on a cleaner admin UI, DAM enhancements, and AI/MCP workflows. Current-cycle friction is dominated by Next.js 16.2 compatibility (hydration, Turbopack) and Postgres adapter edge cases.

---

## Sanity
**Latest release / version:** v6.2.0 (Jun 24, 2026). v6.1.0 (Jun 16, 2026) improves error navigation in Content Releases (jumps to problematic fields) and fixes geopoint config + Portable Text block editing; the v6.0.x line added search matching on reference fields, a `skills install` command, and initialization-crash fixes. v5.30.0 (Jun 3, 2026) fixed an SSO auth loop and a missing `getWorkspace` in `@sanity/cli`.

**Recent notable issues (GitHub):**

- **#12870** — Image upload silently stalls when file has no extension — no error shown — bug — opened May 24, 2026
- **#12835** — Unable to revert to default ordering/layout after manual selection — bug — opened May 17, 2026
- **#12834** — Include document language / field values in edit-intent params for `canHandleIntent` routing — feature — opened May 15, 2026
- **#12812** — Preserve original image metadata / add IPTC metadata on photo upload — feature / CLDX — opened May 10, 2026
- **#12787** — Support multiple `typegen` configurations — feature / CLI — opened May 5, 2026
- **#12733** — Unable to create account on sign-up — "Password is too weak" for a strong password — bug / identity — opened Apr 22, 2026

**Notable specs / in progress:** New `skills` / `skills install` CLI command signals an AI-skills direction; ongoing work on Content Releases error highlighting, Presentation/Visual Editing (incl. Safari cross-origin iframe issues), and typegen configs.

---

## Ghost
**Latest release / version:** Rolling weekly changelog through 2026. Recent additions: automated welcome-email sequences for new free/paid members (Jul 6, 2026), quick admin access for staff users in Beta (Jun 18, 2026), and self-updating saved member views (Jun 11, 2026). Ghost 6.0 work is in progress (breaking changes tracked in #23924). Ghost was recognized as a Digital Public Good by the DPGA (Apr 29, 2026).

**Recent notable issues (GitHub):**

- **#27717** — Document HelmForge chart as third-party Kubernetes install option — feature / needs:triage — opened May 6, 2026
- **#27551** — Signup Card email placeholder hardcoded "Your email", no i18n/per-card override — bug / i18n / needs:triage — opened Apr 25, 2026
- **#27445** — Security: add optional malware scanning for uploaded files — security / feature / needs:triage — opened Apr 17, 2026
- **#27415** — Share button broken because `portal.min.js` not loaded when subscriptions disabled — bug / needs:triage — opened Apr 15, 2026
- **#26677** — Admin API always saves revisions even when `save_revision=false` — bug / needs:triage — opened Mar 3, 2026
- **#26399** — Unhandled `JSON.parse()` exceptions in Portal's `fetchQueryStrData()` crash widget on malformed preview URLs — bug / community — opened Feb 14, 2026
- `[+]` **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — opened Apr 21, 2026

**Notable specs / in progress:** Two mega-issues drive work — #23924 (Breaking Changes for 6.0) and #23361 (i18n mega-issue). An "agentic-workflows" label (e.g., #26644) suggests internal automation/AI experimentation.

---

## KeystoneJS
**Latest release / version:** `@keystone-6/core` 6.5.2 (Mar 19, 2026) — a security patch fixing an `isFilterable` bypass via the cursor parameter in `findMany` queries (reported as CVE-2026-33326 in search results — `[Unverified]` CVE ID). Broader recent improvements: Prisma v5.13.0 upgrade, extendable `PrismaClient`, `context.transaction` for interactive transactions, and new `migrate create` / `migrate apply` commands.

**Recent notable issues (GitHub):**

- **#9798** — Bump Next to >15.5.13 — dependencies — opened Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query-depth limits by default? — feature (security-relevant) — opened Mar 18, 2026
- **#9785** — `statelessSessions` attempts unsupported `Authorization: Basic` header instead of cookie — discussion / docs / help wanted — opened Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — bug — opened Feb 20, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing Post on fresh CLI install — bug — opened Jan 24, 2026
- **#9665** — Field editable when `graphql.omit.update` is set — bug / help wanted — opened Jul 22, 2025
- `[+]` **#9772** — `"ID!" used in position expecting type "IDFilter"` error when loading a single entity — opened Feb 3, 2026
- `[+]` **#9753** — Access-operation function called with no session during a successful login — opened Dec 18, 2025

**Notable specs / in progress:** Security hardening is a theme — proposal to enforce GraphQL query-depth limits by default (#9789) alongside the recent isFilterable/cursor access-control fix. Node 20 LTS support (#8987) and dependency modernization remain open.

---

## TinaCMS
**Latest release / version:** `@tinacms/search` 1.2.21 (Jul 1, 2026) — adds a back-to-collection breadcrumb in the admin editor + visual-editor sidebar. 2026 feature themes: global-collection UX cleanup (single "Site" sidebar entry, opens directly in form), date handling modernized onto date-fns v4 (dropped moment/moment-timezone, ~18.6 KB smaller bundle), edge-runtime cache fixes (Cloudflare Workers / Vercel Edge), and unified folder-name validation.

**Recent notable issues (GitHub):**

- **#7162** — Starter template 'basic' failed during install with yarn on Node 22 — bug — opened Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` unnavigable; single-doc auto-open fires inside folder views — bug / pending triage — opened Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap with no error — bug — opened Jul 1, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / pending triage / v4 — opened Jun 30, 2026
- **#7109** — Starter 'tina-astro-starter' failed during build with npm on Node 24 — bug — opened Jun 28, 2026
- **#7096** — Enter key inserts line break at wrong position, corrupts bullet-list formatting — bug / Needs Refinement — opened Jun 25, 2026
- `[+]` **#7118** — 📝 Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export) — Astro — opened Jun 30, 2026

**Notable specs / in progress:** Active v4 track — better-auth Auth plugin (#7092) and multiple v4-tagged fixes. CLI/deploy: splitting `tinacms build` (pure codegen) from a deploy-time publish gate (#7068) and making the deploy schema gate wait for schemaSha convergence (#7067). Rich-text: semantic table rendering (#7169) and Markdown plugin support (#7075).

---

## Decap CMS
**Latest release / version:** v3.11.0 (Mar 24, 2026) on GitHub Releases; npm shows a more recent v3.14.1. Notable: a new richtext widget built on the Plate editor (legacy markdown widget now deprecated/unmaintained), plus "Decap Turbo," a new SaaS upgrade for teams focused on performance, centralized auth, and granular permissions.

**Recent notable issues (GitHub):**

- **#7875** — Path traversal in `decap-server` proxy allows read/write/delete outside repo root — **security / bug** — opened Jul 5, 2026
- **#7873** — Images not rendered in preview starting from v3.13.0 — bug — opened Jun 29, 2026
- **#7871** — `TypeError: Cannot read properties of undefined (reading 'path')` — bug — opened Jun 29, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — bug — opened Jun 25, 2026
- **#7823** — Support open authoring for GitLab — feature — opened May 21, 2026
- **#7802** — Can't copy and paste into Rich Text — bug (richtext widget) — opened May 4, 2026
- `[+]` **#7870 / #7869 / #7868** — Cluster of uncaught `TypeError`s (`removeChild` on Node; `Cannot destructure property 'url' of 'e.element.data'`) — opened Jun 28, 2026
- `[+]` **#7801** — `TypeError: this.props.value?.get is not a function` — opened May 2, 2026
- `[+]` **#7800** — Preview pane stops accepting scroll events after resizing the form/preview divider — bug (preview-pane) — opened May 2, 2026

**Notable specs / in progress:** Work centers on the new Plate-based richtext widget (copy/paste #7802, soft line breaks #7816) and expanding Git backend support (GitLab open authoring #7823, Forgejo login). ~559 open issues total.

---

## Builder.io
**Latest release / version:** No single version tag found for the OSS SDK; releases tracked at github.com/BuilderIO/builder/releases and product updates at builder.io/updates. In 2026 Builder.io is positioned as an AI-assisted visual development platform pairing Fusion (Figma-to-React/Next.js code) with Publish (drag-and-drop CMS with A/B testing and personalization). Specific 2026 changelog details `[Unverified]` / not found.

**Recent notable issues (GitHub):**

- **#4501** — Cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346) — **security** — opened Apr 4, 2026
- **#4220** — Add validation to prevent duplicate component names during registration — feature — opened Jan 8, 2026
- **#4212** — Using `eval` for detecting server code throws CSP error — bug — opened Dec 15, 2025
- **#4191** — EnableEditor state merging breaks reactivity of blocks in Qwik — bug — opened Nov 25, 2025
- **#4166** — State stored is extremely wasteful — bug — opened Oct 25, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ (C++20 compilation requirement) — bug — opened Aug 30, 2025

**Notable specs / in progress:** Issue activity is dominated by Qwik SDK reactivity/state problems (#4191, #4165, #4136) and CSP/security hardening (#4501, #4212). Storybook 10 support requested (#4164). ~62 open issues; repo skews older (many from 2025), suggesting slower issue triage.

---

## Medusa
**Latest release / version:** v2.16.0 (April 2026). Notable additions: asynchronous payment methods (webhook-confirmed payments across the Payment module, Stripe provider, workflows, JS SDK, and admin), quantity-based price tiers in the admin, descriptive per-page document titles, and a new first-party `@medusajs/eslint-plugin`. Minor release but carries several breaking changes requiring code/config updates.

**Recent notable issues (GitHub):**

- **#15399** — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — bug / needs triaging / v2.0 — opened May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE — bug / requires-team — opened May 13, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — bug / v2.0 — opened May 11, 2026
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — bug — opened May 6, 2026
- **#15371** — RTL layout issues in admin dashboard for Hebrew/Arabic/Farsi — bug / help-wanted — opened May 11, 2026
- **#15406** — Local dev setup for contributors is confusing/undocumented, lacks plugin hot reload — docs — opened May 14, 2026
- `[+]` **#15353** — Error sorting orders by Total / Fulfillment status / Payment status — bug / good first issue / v2.0 — opened May 10, 2026
- `[+]` **#15343** — `getDatabaseURL` in `@medusajs/test-utils` breaks for passwords with special URL chars (`#`, `@`, `:`) — bug / v2.0 — opened May 8, 2026
- `[+]` **#15341** — Build silently excludes any file path containing the `test` substring (`Compiler.backendIgnoreFiles`) — bug / good first issue — opened May 8, 2026
- `[+]` **#15321** — `db:sync-links` generates invalid Postgres `ALTER TABLE schema.old RENAME TO schema.new` — bug / help-wanted — opened May 7, 2026
- `[+]` **#15300** — `medusa db:migrate` exit code incorrect — bug / v2.0 — opened May 5, 2026

**Notable specs / in progress:** Open bugs cluster around the v2.0 line — the new index-engine feature flag (#15399), cart/promotion concurrency (#15360), and payment/refund reliability (#15306). React 19 migration friction is surfacing (#15398). ~111 open issues.

---

## Method & caveats

- Data pulled from each project's public GitHub Issues page (server-rendered HTML) and web search of official release notes/changelogs on 2026-07-10.
- GitHub issue lists are sorted by GitHub's default (recently updated / open first); "opened" dates are quoted from the page. Some listed issues were opened before today — they surfaced as currently active/open, not necessarily created in the last 24h.
- Version numbers marked `[Unverified]` or "not found" could not be confirmed to a single authoritative source at run time. Release/version prose in the per-project sections was gathered at the 16:07 run and carried forward — it was **not** re-fetched at 22:05, so treat it as `[Unverified]` for this run.
- This is the **second run of 2026-07-10** (baseline: the 16:07 run). GitHub issue data was re-fetched live at 22:05 and diffed against that baseline in the "Changes since previous run" section above.
- Blog feeds (Strapi, Directus, Payload, Sanity, Ghost, Keystone, Tina, Decap, Builder, Medusa) are client-rendered and return page shells to a raw fetch; feature/release detail therefore comes from GitHub + the earlier changelog search rather than a live blog scrape this run.
