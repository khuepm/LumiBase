# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 06:24 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 04:04 (+07)

> Sources this run: each project's **GitHub Issues** page, fetched live and verified (open-issue counts + newest open issue ID/title/open-date quoted exactly as shown). **Blog/release highlights are carried forward from earlier runs and were not re-fetched this run** — labeled `[carried forward]`. Version numbers not printed on a fetched page are labeled `[Unverified]`.

---

## TL;DR — Changes since previous run (2026-07-11 04:04)

**Tracker data: no change.** All 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 04:04 run. Verified live this run.

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

Three security-grade open issues persist and remain the top action items: **Strapi #26494** (register-admin rate limit, critical), **Decap #7875** (path traversal in decap-server proxy, critical), **Builder.io #4501** (postMessage RCE, CWE-346).

> **Note on cadence:** trackers were identical to the run ~2 hours earlier, so blogs were not re-crawled this cycle (they change at most daily). Blog highlights below are `[carried forward]`.

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post (date) `[carried forward]` | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | Extend MCP Server via Plugin (Jun 13) | #26494 register-admin rate limit (critical) |
| Directus | 326 | #27129 (Apr 15) | v12 license change (Apr 22) | — |
| Payload | 288 | #16288 (Apr 15) | Early look at Payload 4.0 (Jun 9) | — |
| Sanity | 75 | #12870 (May 24) | AI content ops report (Jun 15) | — |
| Ghost | 63 | #27717 (May 6) | (resources library; changelog separate) | #27445 malware scan (feature request) |
| KeystoneJS | 100 | #9798 (Apr 3) | Year of releases in review (Aug 2024) | depth-limit proposal #9789 |
| TinaCMS | 378 | #7169 (Jul 7) | Separate Content Repos for TinaCloud (Jun 12) | — |
| Decap | 559 | #7875 (Jul 5) | Announcing Decap Turbo (May 5) | #7875 path traversal (critical) |
| Builder.io | 62 | #4501 (Apr 4) | Building Without the Handoffs (Jun 29) | #4501 postMessage RCE (CWE-346) |
| Medusa | 111 | #15406 (May 14) | Layout Composer in Medusa Admin (Jul 1) | refund/promotion reliability bugs |

**Cross-cutting signals:** AI/MCP tooling remains the dominant blog theme across Strapi, Directus, Payload, Sanity, Medusa and Builder.io; Next.js 16.2 / React 19 migration friction continues to drive Payload and Medusa bug reports; agent-native / "content operations" framing dominates Sanity and Builder.io messaging.

---

## Strapi
**Open issues:** 396 (verified). Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / status: pending reproduction / v5 — Jun 2, 2026
- **#26494** — no rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching — bug / severity: medium / core:database / v5 — May 28, 2026
- **#26463** — Community plugin `@strapi-community/plugin-seo` archived — marketplace policy + Strapi 5 panel API migration — discussion — May 27, 2026
- **#26387** — Replace-media updates metadata but asset content remains original file — bug / severity: high / core:upload / **status: confirmed** / v5 — May 19, 2026

**Content Manager stability cluster (Priority: Urgent / critical):** #26434, #26396, #26389 (undefined-property crashes navigating single types / admin UI). Related plugin-SEO error #26437 also open.

**Blog highlights `[carried forward]`:** "How To Extend Strapi's MCP Server With Custom Tools via a Plugin" (Jun 13); "The Strapi MCP server is out" — v5.47.0 `[Unverified]`, built-in MCP server exposing content types as agent tools (May 28); "Strapi Better Auth Tutorial" (May 21).

---

## Directus
**Open issues:** 326 (verified). Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#27129** — Back button broken on all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` — Needs Info — Apr 15, 2026
- **#27119** — API extension hook fails to register: `document is not defined` — Bug / Ext SDK / Extensions / Low Impact — Apr 15, 2026
- **#27111** — Apple OAuth `first_name`/`last_name` not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` uses an old version of tsdown and openid-client — Apr 11, 2026
- **#27091** — Save-as-copy throws error — Bug / Regression / Studio / High Impact — Apr 10, 2026
- **#27062** — [Map Layout] postgis `geometry.Point` geospatial field produces error — Bug / Engine / Needs Info — Apr 7, 2026
- **#27042** — WYSIWYG not rendering on return-from-edit as non-admin user (v11.16.1) — Bug / High Impact — Apr 3, 2026
- **#27039** — [MCP] files-tool update action fails: schema typed as array but API expects object — AI/MCP / Bug / High Impact — Apr 3, 2026
- **#27003** — Aliased GraphQL relational objects within a fragment return null — Bug / GraphQL / Regression / Enterprise — Mar 30, 2026

**Blog highlights `[carried forward]`:** "Evolving Our License for Long-Term Sustainability (v12 license change)" (Apr 22); v11.17 Background Imports / Netlify Deployments / Translations Generator (Apr 10); native MCP support (v11.13, Nov 2025) remains an active roadmap area.

---

## Payload CMS
**Open issues:** 288 (verified). Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → `invalid input value for enum` — db: postgres — Apr 15, 2026
- **#16273** — Malfunctioning lexical rich-text editing in custom block drawer — plugin: richtext-lexical — Apr 14, 2026
- **#16270** — Cache components might cause full page refresh when selecting a media — area: core / needs-triage — Apr 13, 2026
- **#16262** — `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported — plugin: richtext-lexical — Apr 13, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) — Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — Apr 8, 2026

**Signal:** dominant theme is Next.js 16.2 / Turbopack migration breakage (#16288, #16286) plus lexical rich-text and MCP-plugin schema issues.

**Blog highlights `[carried forward]`:** "An early look at Payload 4.0" (Jun 9); ongoing Payload MCP plugin work; Next.js 16 compatibility track.

---

## Sanity
**Open issues:** 75 (verified). Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — May 24, 2026
- **#12869** — Tests Dashboard & auto-balancing Playwright shards — tooling — May 23, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature: include document language / field values in edit-intent params for `canHandleIntent` routing — Feature — May 15, 2026
- **#12812** — Feature: preserve original image metadata / add IPTC metadata on photo upload — CLDX / Feature — May 10, 2026
- **#12787** — Feature: support multiple `typegen` configurations — CLI / Feature — May 5, 2026
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — Apr 16, 2026
- **#12733** — Cannot create new account on sign-up page: "Password too weak" for a strong password — identity / Bug — Apr 22, 2026
- **#12806** — Safari: Presentation Tool "Unable to connect" — cross-origin iframe sandboxing errors — Apr 5, 2026

**Blog highlights `[carried forward]`:** "Agents leave receipts. We read 1.46 million of them" (Jun 15, AI content-ops analysis); "Sanity Studio v6: A focused upgrade" (Jun 9, faster Vite 8 builds, drops EOL Node 20); "What's New – June 2026" (Jun 8).

---

## Ghost
**Open issues:** 63 (verified). Resources: https://ghost.org/resources · Issues: https://github.com/TryGhost/Ghost/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#27717** — Document HelmForge chart as a third-party Kubernetes install option — needs:triage — May 6, 2026
- **#27551** — Signup Card email placeholder hardcoded ("Your email"), no i18n / per-card override — needs:triage — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — needs:triage — Apr 17, 2026
- **#27415** — Share button broken: `portal.min.js` not loaded when subscriptions disabled — needs:triage — Apr 15, 2026
- **#26905** — HTML entities visible in email publication date — community — Mar 20, 2026
- **#26677** — Admin API always saves revisions even when `save_revision=false` — needs:triage — Mar 3, 2026
- **#26607** — Editor opening staff settings triggers forbidden API calls + unrelated permission toast — needs:triage — Feb 26, 2026

**Ongoing tracked epics (pinned):** 🔥 Breaking Changes for 6.0 (#23924), 🌐 i18n mega-issue (#23361). Ghost `/resources` is an evergreen guide library; product releases live on the separate changelog.

---

## KeystoneJS
**Open issues:** 100 (verified). Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query depth limits by default? — Feature — Mar 18, 2026
- **#9785** — `statelessSessions` attempts `Authorization: Basic` header instead of cookie — discussion / docs / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — "ID!" used where "IDFilter" expected when loading single entity — Feb 3, 2026
- **#9766** — Document Fields Demo docs page refers to a form that doesn't exist — Jan 24, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing a Post on fresh CLI install — Jan 24, 2026
- **#9753** — Access operation function called with no session during successful login — Dec 18, 2025
- **#9665** — Field editable when `graphql.omit.update` is set — Bug / help wanted — Jul 22, 2025

**Note:** blog is low-frequency (newest "A year of releases in review", Aug 2024); product news now lands mainly in GitHub Releases. Pinned: Node 20 (LTS) support (#8987).

---

## TinaCMS
**Open issues:** 378 (verified). Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#7169** — ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template 'basic' fails during install with yarn on Node 22 — bug — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` unnavigable (single-doc auto-open fires in folder views) — bug — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap, no error — Jul 1, 2026
- **#7118** — 📝 Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export) — Astro — Jun 30, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 — Jun 30, 2026
- **#7109** — Starter template 'tina-astro-starter' fails during build with npm on Node 24 — bug — Jun 28, 2026
- **#7096** — Pressing Enter in editor inserts line break at wrong position, corrupts bullet lists — Jun 25, 2026
- **#7092** — ✨ Plugin System – Auth Plugin – better-auth — technical-debt / v4 — Jun 23, 2026
- **#7075** — Markdown: support markdown plugins — rich-text / for 4.1 — Jun 22, 2026
- **#7068 / #7067** — Split `tinacms build` (pure codegen) from deploy-time publish gate; schema gate should wait for `schemaSha` convergence — CLI / dx / enhancement — Jun 18, 2026

**Signal:** active v4 track work (auth plugin, CLI build/deploy split, rich-text improvements). Repo shows "issue creation is restricted."

**Blog highlights `[carried forward]`:** "Separate Content Repos are here for TinaCloud" (Jun 12); "Astro is becoming the default starter for TinaCMS" (May 28); "What we're planning for TinaCMS v4" (May 13).

---

## Decap CMS
**Open issues:** 559 (verified). Blog: https://decapcms.org/blog · Issues: https://github.com/decaporg/decap-cms/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside configured repo root — **type: bug (critical)** — Jul 5, 2026
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871 / #7870 / #7869 / #7868** — TypeErrors (undefined `path`; `removeChild`; destructure `url` of `e.element.data`) — Jun 28–29, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026
- **#7816 / #7802 / #7801 / #7800** — Soft line breaks / copy-paste / `value?.get` TypeError / scroll issues in new richtext (Plate) widget — type: bug — May 2026

**Blog highlights `[carried forward]`:** "Announcing Decap Turbo" (May 5, SaaS upgrade: performance, centralized auth, granular permissions); "Richtext Widget Replaces the Markdown Widget" (Apr 16, new Plate-based richtext widget; markdown widget deprecated).

---

## Builder.io
**Open issues:** 62 (verified). Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#4501** — **Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** — Apr 4, 2026
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4219** — Vue 3: `[Vue warn] Extraneous non-props attributes` — Dec 19, 2025
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4191** — EnableEditor state merging breaks reactivity of blocks in Qwik — Nov 25, 2025
- **#4166** — State stored is extremely wasteful — Oct 25, 2025
- **#4165** — Qwik temporary code not reverted inside content component — Oct 23, 2025
- **#4164** — Storybook 10 support — Oct 20, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ (C++20 compilation) — Aug 30, 2025

**Blog highlights `[carried forward]`:** "Building Without the Handoffs" (Jun 29); "Introducing Clips: an open-source, agent-native Loom alternative" (Jun 26); "Introducing /visual-plan: Scannable Claude Code plans" (Jun 24).

---

## Medusa
**Open issues:** 111 (verified). Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Newest / notable open issues (bugs & specs) — verified this run:**
- **#15406** — Local dev setup for contributors is confusing/undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — `/store/products` returns 500 for any `category_id` / `tag_id` filter when `index_engine` flag enabled — v2.0 / needs triaging — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE — bug / requires-team — May 13, 2026
- **#15371** — RTL layout issues in admin dashboard for Hebrew/Arabic/Farsi — bug / help-wanted — May 11, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — bug / v2.0 / requires-team — May 11, 2026
- **#15353** — Error sorting orders by Total / Fulfillment status / Payment status — good first issue / v2.0 — May 10, 2026
- **#15343** — `getDatabaseURL` in `@medusajs/test-utils` breaks for passwords with special URL chars (#, @, :) — bug / v2.0 — May 8, 2026
- **#15341** — Build silently excludes any file path containing 'test' substring (`Compiler.backendIgnoreFiles`) — good first issue / bug — May 8, 2026
- **#15321** — `db:sync-links` generates invalid PostgreSQL schema-qualified `RENAME TO` — bug / help-wanted — May 7, 2026
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — bug / needs triaging — May 6, 2026

**Blog highlights `[carried forward]`:** "Announcing new Layout Composer in Medusa Admin" (Jul 1); ongoing agent tooling (Medusa MCP, Cloud CLI, Agent Skills, "Fix with AI").

---

## Methodology & caveats
- **Verified this run (live):** open-issue counts and newest open issue (ID/title/open-date) for all 10 repos, read directly from the GitHub Issues pages.
- **`[carried forward]`:** blog/release highlights were not re-crawled this run (trackers were identical to the prior run ~2 hours earlier; blogs change at most daily).
- **`[Unverified]`:** specific release/version numbers not printed on a fetched page. GitHub issue lists are sorted newest-first (not by last-activity), so older issues with recent comments may not appear here.
- **No write actions taken.** This is a read-only monitoring report.

*Generated automatically — headless CMS watch, run 2026-07-11 06:24 (+07).*
