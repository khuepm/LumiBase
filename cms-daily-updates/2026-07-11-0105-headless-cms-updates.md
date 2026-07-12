# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 01:05 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 00:04 (+07)

> Sources this run: each project's **GitHub Issues** page and **official blog** page, fetched live. Issue numbers, issue titles, blog-post titles and their dates are quoted exactly as shown on the pages (verified). Release/version numbers not printed on a fetched page are labeled `[Unverified]`.

---

## TL;DR — Changes since previous run (2026-07-11 00:04)

**Tracker data: no change.** All 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 00:04 run.

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**This run additionally captures each project's latest blog/release posts** (features & announcements), summarized per project below. Freshest blog items across all 10: **Medusa** "Layout Composer in Medusa Admin" (Jul 1) · **Strapi** "Extend Strapi's MCP Server via a Plugin" (Jun 13) · **TinaCMS** "Separate Content Repos for TinaCloud" (Jun 12) · **Builder.io** "Building Without the Handoffs" (Jun 29).

Three security-grade open issues persist and remain the top action items: **Strapi #26494** (register-admin rate limit, critical), **Decap #7875** (path traversal in decap-server proxy, critical), **Builder.io #4501** (postMessage RCE, CWE-346).

---

## At a glance

| CMS | Open issues | Newest open issue | Latest blog post (date) | Security item this cycle |
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

**Cross-cutting signals:** AI/MCP tooling is now a headline theme on nearly every blog (Strapi, Directus, Payload, Sanity, Medusa, Builder.io); Next.js 16.2 / React 19 migration friction continues to generate Payload and Medusa bugs; agent-native / "content operations" framing dominates Sanity and Builder.io messaging.

---

## Strapi
**Open issues:** 396. Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues

**Latest blog posts (features / announcements):**
- **How To Extend Strapi's MCP Server With Custom Tools via a Plugin** — Jun 13, 2026. Guide to registering custom agent-callable tools through a plugin.
- **The Strapi MCP server is out: wire agents to your content** — May 28, 2026. Strapi **v5.47.0** `[Unverified]` ships a built-in MCP server exposing content types as agent tools, scoped by admin-token permissions; free, self-hosted.
- **Strapi Better Auth Tutorial (Strapi v5 + Next.js 16)** — May 21, 2026. Community Better-Auth plugin integration.
- **Building Docs for the AI Era, Part 1: Self-Healing Docs** — Jun 11, 2026.

**Newest / notable open issues (bugs & specs):**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / v5 — Jun 2, 2026
- **#26494** — No rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching — bug / severity: medium / core:database / v5 — May 28, 2026
- **#26387** — Replace-media updates metadata but asset content remains original file — bug / severity: high / core:upload / **status: confirmed** / v5 — May 19, 2026

**Content Manager stability cluster:** #26434, #26396, #26389 (undefined-property crashes navigating single types / admin UI).

---

## Directus
**Open issues:** 326. Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Latest blog posts (features / releases):**
- **Evolving Our License for Long-Term Sustainability (v12 license change)** — Apr 22, 2026.
- **Directus v11.17: Background Imports, Netlify Deployments, Translations Generator** — Apr 10, 2026.
- **Directus v11.16: Global Draft Versions, Multimodal AI, Smarter Deployments** — Mar 10, 2026.
- **Directus v11.15: Native Collaborative Editing, AI Assistant GA, One-Click Deployments** — Feb 12, 2026.
- **Native Model Context Protocol (MCP) support** — launched Nov 2025 (v11.13); AI/MCP remains an active roadmap area.

**Newest / notable open issues (bugs & specs):**
- **#27129** — Back button broken on all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` — Apr 15, 2026
- **#27119** — API extension hook fails to register: `document is not defined` — Bug / Ext SDK / Extensions — Apr 15, 2026
- **#27091** — Save-as-copy throws error — Bug / Regression / Studio / High Impact — Apr 10, 2026
- **#27039** — [MCP] files-tool update action fails: schema typed as array but API expects object — AI/MCP / Bug / High Impact — Apr 3, 2026
- **#27003** — Aliased GraphQL relational objects within a fragment return null — Bug / GraphQL / Regression — Mar 30, 2026

---

## Payload CMS
**Open issues:** 288. Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues

**Latest blog posts (features / announcements):**
- **An early look at Payload 4.0: Admin UI Redesign, TanStack, MCP, and More** — Jun 9, 2026.
- **Critical Security Notice Affecting React 19 and Next.js** — Dec 4, 2025.
- **Deploy Payload onto Cloudflare in a single click** — Oct 3, 2025.
- Context: Payload is now part of Figma (announced Jun 2025).

**Newest / notable open issues (bugs & specs):**
- **#16288** — `suppressHydrationWarning` doesn't work after Next.js upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres — db: postgres — Apr 15, 2026
- **#16273** — Malfunctioning Lexical rich-text editing in custom block drawer — richtext-lexical — Apr 14, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) — Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — Apr 8, 2026

**Signal:** heavy Next.js 16.2 / Turbopack / React 19 migration friction across core, plugins and DB adapters.

---

## Sanity
**Open issues:** 75. Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues

**Latest blog posts (features / announcements):**
- **Agents leave receipts. We read 1.46 million of them** — Jun 15, 2026 (AI content-operations analysis).
- **Sanity Studio v6: A focused upgrade** — Jun 9, 2026. Builds 2–9× faster on Vite 8 (their testing); default-search & custom-auth improvements; **drops end-of-life Node 20 support**.
- **What's New – June 2026** — Jun 8, 2026 (hosted Studio from one chat, Content Agent on Slack Marketplace).
- Recurring theme: Content Agent, Agent API/Context, MCP Server.

**Newest / notable open issues (bugs & specs):**
- **#12870** — [BUG] Image upload silently stalls when file has no extension (no error shown) — May 24, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature request: include document language/field values in edit-intent params for `canHandleIntent` routing — May 15, 2026
- **#12812** — Feature request: preserve original image metadata / add IPTC metadata on upload — CLDX — May 10, 2026
- **#12787** — Feature request: support multiple `typegen` configurations — CLI — May 5, 2026
- **#12794** — Presentation tool writes `previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — Apr 16, 2026

---

## Ghost
**Open issues:** 63. Resources: https://ghost.org/resources · Issues: https://github.com/TryGhost/Ghost/issues

> Ghost's `/resources` page is an evergreen guide library (no dated release posts); product releases live on the separate changelog. Version prose below is `[Unverified]` this run.

**Newest / notable open issues (bugs & specs):**
- **#27717** — Document HelmForge chart as a third-party Kubernetes install option — needs:triage — May 6, 2026
- **#27551** — Signup Card email placeholder hardcoded ("Your email"), no i18n / per-card override — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — Apr 17, 2026
- **#27415** — Share button broken: `portal.min.js` not loaded when subscriptions disabled — Apr 15, 2026
- **#26677** — Admin API always saves revisions even when `save_revision=false` — Mar 3, 2026

**Ongoing tracked epics:** 6.0 breaking changes (#23924), i18n mega-issue (#23361). Previously tracked Ghost CVEs (CVE-2026-26980 SQLi; CVE-2026-29053 theme RCE) reported fixed in **6.19.1** `[Unverified]` — no new CVE surfaced this run.

---

## KeystoneJS
**Open issues:** 100. Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

> Blog is low-frequency; newest post is "A year of releases in review" (Aug 7, 2024). Product news now lands mainly in GitHub Releases.

**Newest / notable open issues (bugs & specs):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query depth limits by default? — Feature — Mar 18, 2026
- **#9785** — `statelessSessions` attempts `Authorization: Basic` header instead of cookie — discussion / docs / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — "ID!" used where "IDFilter" expected when loading single entity — Feb 3, 2026
- **#9665** — Field editable when `graphql.omit.update` is set — Bug / help wanted — Jul 22, 2025

---

## TinaCMS
**Open issues:** 378. Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Latest blog posts (features / announcements):**
- **Separate Content Repos are here for TinaCloud** — Jun 12, 2026.
- **Astro is becoming the default starter for TinaCMS** — May 28, 2026.
- **What we're planning for TinaCMS v4** — May 13, 2026.

**Newest / notable open issues (bugs & specs):**
- **#7169** — ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` unnavigable (single-doc auto-open fires in folder views) — bug — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap, no error — Jul 1, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 — Jun 30, 2026
- **#7092** — ✨ Plugin System – Auth Plugin – better-auth — v4 — Jun 23, 2026
- **#7068 / #7067** — Split `tinacms build` (pure codegen) from deploy-time publish gate; schema gate should wait for `schemaSha` convergence — CLI / dx / enhancement — Jun 18, 2026

**Signal:** active v4 track work (auth plugin, CLI build/deploy split, rich-text improvements).

---

## Decap CMS
**Open issues:** 559. Blog: https://decapcms.org/blog · Issues: https://github.com/decaporg/decap-cms/issues

**Latest blog posts (features / announcements):**
- **Announcing Decap Turbo** — May 5, 2026. New SaaS upgrade for teams: CMS performance, centralized auth, granular permissions; early access.
- **Richtext Widget Replaces the Markdown Widget** — Apr 16, 2026. New richtext widget built on the Plate editor; markdown widget deprecated (remains available, no longer actively maintained).

**Newest / notable open issues (bugs & specs):**
- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside configured repo root — **type: bug (critical)** — Jul 5, 2026
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871 / #7870 / #7869 / #7868** — TypeErrors (undefined `path`; `removeChild`; destructure `url` of `e.element.data`) — Jun 28–29, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026
- **#7816 / #7802** — Soft line breaks / copy-paste issues in new richtext widget — type: bug — May 2026

---

## Builder.io
**Open issues:** 62. Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues

**Latest blog posts (features / announcements):**
- **Building Without the Handoffs** — Jun 29, 2026 (Headless CMS + Governance/Security).
- **Introducing Clips: an open-source, agent-native Loom alternative** — Jun 26, 2026.
- **Introducing /visual-plan: Scannable Claude Code plans** — Jun 24, 2026.
- **How to Make AI Agents Follow Your Design System** — Jun 15, 2026.

**Newest / notable open issues (bugs & specs):**
- **#4501** — **Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** — Apr 4, 2026
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4219** — Vue 3: `[Vue warn] Extraneous non-props attributes` — Dec 19, 2025
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4164** — Storybook 10 support — Oct 20, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ (C++20 compilation) — Aug 30, 2025

---

## Medusa
**Open issues:** 111. Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Latest blog posts (features / announcements):**
- **Announcing new Layout Composer in Medusa Admin** — Jul 1, 2026 (Product).
- Ongoing agent tooling: Medusa MCP, Cloud CLI, Agent Skills, "Fix with AI" development agent (per site nav).

**Newest / notable open issues (bugs & specs):**
- **#15406** — Local dev setup for contributors is confusing/undocumented, lacks hot reload for plugins — docs — May 14, 2026
- **#15399** — `/store/products` returns 500 for any `category_id` / `tag_id` filter when `index_engine` flag enabled — v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE — bug — May 13, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — bug / v2.0 — May 11, 2026
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — bug — May 6, 2026
- **#15353** — Error sorting orders by Total / Fulfillment status / Payment status — good first issue / v2.0 — May 10, 2026

---

## Methodology & caveats
- **Verified this run:** open-issue counts, newest open issue (ID/title/date), and blog post titles/dates — all read directly from the live GitHub Issues and blog pages listed above.
- **`[Unverified]`:** specific release/version numbers not printed on a fetched page. GitHub issue lists are sorted newest-first (not by last-activity), so an old issue with recent comments may not appear here.
- **No write actions taken.** This is a read-only monitoring report.

*Generated automatically — headless CMS watch, run 2026-07-11 01:05 (+07).*
