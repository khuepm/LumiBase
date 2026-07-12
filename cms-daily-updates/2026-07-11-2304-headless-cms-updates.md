# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 23:04 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 22:04 (+07)

> Sources this run: each project's **GitHub Issues** page (open-issue counts + newest open issues with ID/title/labels/open-date, quoted as shown) **and** each project's **vendor blog**, all fetched live and verified this cycle for all 10. Unlike recent cycles, blogs were successfully re-hydrated this run, so "latest blog post" lines are **verified** (not carried forward). Version numbers not printed on a fetched page are `[Unverified]`. Security-severity characterizations beyond a label/title the vendor itself applied are `[Inference]` (based on title/topic, not a confirmed advisory/CVE unless a CVE is named).

---

## TL;DR — Changes since previous run (2026-07-11 22:04)

**GitHub issues: no change.** All 10 trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 22:04 run. Verified live this run.

**Blogs: re-verified this cycle** (prior several runs carried these forward as `[Unverified]`). Latest posts confirmed live for all 10 with dates. Most recent activity: **Directus** — "AI is straining vulnerability disclosure for maintainers" (Jul 10) · **Builder.io** — "How KPMG Closed the Design-to-Engineering Gap" (Jul 6) · **Medusa** — "Announcing new Layout Composer in Medusa Admin" (Jul 1).

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**Top action items (security-grade, all persist):** **Strapi #26494** (no rate limit on register-admin + race condition — vendor-labeled security/critical/urgent) · **Decap #7875** (path traversal in decap-server proxy — read/write/delete outside repo root) · **Builder.io #4501** (postMessage cross-origin code execution, CWE-346, vendor title). Also note **Strapi** published a batch security disclosure (CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886) on May 13.

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post (verified this run) | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | "The Strapi MCP server is now GA" — Jun 29 | #26494 register-admin rate limit (vendor: security/critical) |
| Directus | 326 | #27129 (Apr 15) | "AI is straining vulnerability disclosure for maintainers" — Jul 10 | #27094 outdated openid-client `[Inference]` |
| Payload | 288 | #16288 (Apr 15) | "An early look at Payload 4.0" — Jun 9 | #16214 MCP plugin null-type `[Inference]` |
| Sanity | 75 | #12870 (May 24) | "Skills are how your company works…" — Jun 22 | #12794 preview secret → wrong dataset `[Inference]` |
| Ghost | 63 | #27717 (May 6) | Resources library (evergreen); running Ghost 6.51 | #27445 upload malware-scan (feature req) |
| KeystoneJS | 100 | #9798 (Apr 3) | "A year of releases in review" — Aug 7 2024 (blog stale) | #9789 GraphQL depth-limit `[Inference]` |
| TinaCMS | 378 | #7169 (Jul 7) | "Separate Content Repos are here for TinaCloud" — Jun 12 | — |
| Decap | 559 | #7875 (Jul 5) | "Announcing Decap Turbo" — May 5 | #7875 path traversal (vendor: bug) |
| Builder.io | 62 | #4501 (Apr 4) | "How KPMG Closed the Design-to-Engineering Gap" — Jul 6 | #4501 postMessage RCE (CWE-346, vendor title) |
| Medusa | 111 | #15406 (May 14) | "Announcing new Layout Composer in Medusa Admin" — Jul 1 | #15360 promo race / #15306 refund `[Inference]` |

**Cross-cutting signals:** (1) **Framework-migration friction** remains the dominant bug driver — Next.js 16.2 / Turbopack on Payload (#16286, #16288), Node 22/24 on TinaCMS (#7162, #7109) and Builder.io (#4137), React 19 peer-dep conflicts on Medusa (#15398), Next >15.5.13 bump on Keystone (#9798). (2) **AI/agent tooling is now the dominant blog theme** across nearly every vendor — MCP servers (Strapi GA, Payload 4.0, Directus OAuth 2.1 for MCP, Sanity MCP), agent-native workflows (Builder.io, Sanity "we don't write code anymore"), and AI-assisted content ops. (3) Two still-open trust-boundary vulns (Decap path traversal #7875, Builder postMessage RCE #4501) remain unresolved.

---

## Strapi
**Open issues:** 396 (verified). Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues

**Newest / notable open issues (verified this run):**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / pending reproduction / v5 — Jun 2, 2026
- **#26494** — no rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching — bug / severity: medium / core:database / v5 — May 28, 2026
- **#26434** — Content Manager "Cannot read properties of undefined (reading 'attributes')" navigating Single Types — bug / Urgent / critical / core:content-manager / v5 — May 26, 2026

**Blog (verified this run):**
- **"The Strapi MCP server is now GA: a stable surface to wire agents to your content"** — Marco Autiero, Jun 29, 2026 (Product). MCP server moves from preview to GA as a stable agent-facing surface for content ops.
- "Strapi June Community Call Recap — Updates, news, Strapi MCP in GA" — Jun 29.
- "Strapi release roundup: everything that changed between March and June 2026" — Jun 18 (Product).
- Security: "Disclosure of Vulnerabilities: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886" — May 13.

---

## Directus
**Open issues:** 326 (verified). Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Newest / notable open issues (verified this run):**
- **#27129** — Back button is broken for all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when a non-admin policy has `directus_flows:trigger` permission — Needs Info — Apr 15, 2026
- **#27119** — Unable to register API extensions hook because `document` is not defined — Bug / Ext SDK / Extensions — Apr 15, 2026
- **#27111** — Apple OAuth first_name/last_name not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` using an old version of tsdown and openid-client — Apr 11, 2026 `[Inference: dependency-freshness / potential security relevance]`
- **#27091** — "Save as copy" throws error — Bug / High Impact / Regression / Studio — Apr 10, 2026
- **#27039** — [MCP] files tool update action fails — data schema typed as array but API expects object — AI/MCP / Bug / High Impact — Apr 3, 2026

**Blog (verified this run):**
- **"AI is straining vulnerability disclosure for maintainers"** — Rijk van Zanten, Jul 10, 2026 (Articles). Newest post overall this run.
- "We're moving to a hardened Docker image. Here's what that means." — David Stockton, Jun 29 (Product).
- "Headless CMS with AI Capabilities: What to Look For" — Jun 26.
- Product milestone: "A Backend for Everyone on Your Team" — May 26 — native draft & publishing workflows, redesigned Studio, AI-assisted translations, JSON filtering, and OAuth 2.1 for MCP.

---

## Payload
**Open issues:** 288 (verified). Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues

**Newest / notable open issues (verified this run):**
- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres — db: postgres — Apr 15, 2026
- **#16273** — Malfunctioning lexical rich text editing in custom block drawer — richtext-lexical — Apr 14, 2026
- **#16256** — vercelPostgresAdapter fails on large queries (68KB+ SQL, 30+ lateral joins) — Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — Apr 8, 2026 `[Inference: AI-tooling correctness]`

**Blog (verified this run):**
- **"An early look at Payload 4.0: Admin UI Redesign, TanStack, MCP, and More"** — Sean Zubrickas, Jun 9, 2026. Preview of a 4.0 admin redesign, TanStack adoption, and MCP.
- "Critical Security Notice Affecting React 19 and Next.js" — Payload Team, Dec 4, 2025.
- Context: Payload is now part of Figma (announced Jun 2025).

---

## Sanity
**Open issues:** 75 (verified). Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues

**Newest / notable open issues (verified this run):**
- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — May 24, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature request: include document language/field values in edit-intent params for `canHandleIntent` routing — Feature — May 15, 2026
- **#12812** — Feature request: preserve original image metadata / add IPTC metadata on upload — CLDX / Feature — May 10, 2026
- **#12787** — Feature request: support multiple `typegen` configurations — CLI / Feature — May 5, 2026
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — Apr 16, 2026 `[Inference: secret-scoping issue]`

**Blog (verified this run):**
- **"Skills are how your company works, written down for agents"** — Knut Melvær, Jun 22, 2026 (newest by date). Internal skills platform on Sanity for authoring agent knowledge.
- "How to get product feedback from agents" — Jun 18.
- "We don't write code anymore" — Jun 12 (engineering).
- **"Sanity Studio v6: A focused upgrade"** — Jun 9 — builds 2–9× faster on Vite 8 (per vendor testing), search/custom-auth improvements, drops end-of-life Node 20. `[Unverified: perf figures are vendor-reported]`
- Featured: "Agents leave receipts. We read 1.46 million of them" — Jun 15 (content-ops analysis).

---

## Ghost
**Open issues:** 63 (verified). Resources: https://ghost.org/resources · Changelog: https://ghost.org/changelog · Issues: https://github.com/TryGhost/Ghost/issues

**Newest / notable open issues (verified this run):**
- **#27717** — Document HelmForge chart as a third-party Kubernetes install option — needs:triage — May 6, 2026
- **#27551** — Signup Card email input placeholder hardcoded ("Your email"), no i18n / per-card override — needs:triage — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — needs:triage — Apr 17, 2026 (feature request)
- **#27415** — Share button fails: `portal.min.js` not loaded when subscriptions disabled — needs:triage — Apr 15, 2026
- Pinned/long-running: **#23924** "Breaking Changes for 6.0"; **#23361** i18n mega-issue.

**Blog (verified this run):** Ghost's public content hub (`/resources`) is an **evergreen guide library** (Building / Publishing / Growth / Business), not a dated news feed — no new dated post surfaced this run. Product-news activity lives in the **Changelog**. Fetched page reports the site runs **Ghost 6.51**. `[Unverified: 6.51 is the marketing-site generator version, not necessarily the newest published release]`

---

## KeystoneJS
**Open issues:** 100 (verified). Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

**Newest / notable open issues (verified this run):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query depth limits by default? — Feature — Mar 18, 2026 `[Inference: DoS-hardening relevance]`
- **#9785** — `statelessSessions` attempts to use unsupported `Authorization: Basic` header rather than the cookie — discussion/docs/help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — Error loading single entity: `ID!` used where `IDFilter` expected — Feb 3, 2026
- **#9665** — Field editable when `graphql.omit.update` is set — Bug / help wanted — Jul 22, 2025

**Blog (verified this run):** Latest post is **"A year of releases in review" — Aug 7, 2024**. The Keystone blog remains **stale (~11 months)**; active updates are published via **GitHub Releases** (https://github.com/keystonejs/keystone/releases), not the blog.

---

## TinaCMS
**Open issues:** 378 (verified). Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Newest / notable open issues (verified this run):**
- **#7169** — ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template 'basic' failed during install with yarn using Node 22 — bug (CI-generated) — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false + delete:false` is unnavigable — bug / pending triage — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap — Jul 1, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 — Jun 30, 2026
- **#7109** — Starter template 'tina-astro-starter' failed during build with npm using Node 24 — bug (CI) — Jun 28, 2026
- **#7092** — ✨ Plugin System — Auth Plugin — better-auth — technical-debt / v4 — Jun 23, 2026

**Blog (verified this run):**
- **"Separate Content Repos are here for TinaCloud"** — Josh Berman, Jun 12, 2026.
- "Astro is becoming the default starter for TinaCMS" — May 28.
- "What we're planning for TinaCMS v4" — May 13 (roadmap for v4).

---

## Decap CMS
**Open issues:** 559 (verified). Blog: https://decapcms.org/blog · Issues: https://github.com/decaporg/decap-cms/issues

**Newest / notable open issues (verified this run):**
- **#7875** — Path traversal in `decap-server` proxy allows read/write/delete of files outside the configured repo root — type: bug — Jul 5, 2026 (**trust-boundary; treat as high severity** `[Inference]`)
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871 / #7870 / #7869 / #7868** — assorted `TypeError` crashes (undefined `path`, `removeChild`, destructure of `url`) — late Jun 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026

**Blog (verified this run):**
- **"Announcing Decap Turbo"** — Martin Jagodic, May 5, 2026 — a SaaS upgrade for teams: CMS performance, centralized auth, granular permissions (early access).
- "Richtext Widget Replaces the Markdown Widget" — Apr 16, 2026 — new richtext widget built on the Plate editor; the markdown widget remains available but is **deprecated and unmaintained**.

---

## Builder.io
**Open issues:** 62 (verified). Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues

**Newest / notable open issues (verified this run):**
- **#4501** — Security: Cross-origin code execution via unvalidated `postMessage` in builder-block (**CWE-346**, vendor title) — Apr 4, 2026
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4191 / #4165** — Qwik reactivity / temporary-code-not-reverted issues — late 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements — Aug 30, 2025

**Blog (verified this run):**
- **"How KPMG Closed the Design-to-Engineering Gap with Builder"** — Amy Cross, Jul 6, 2026 (featured; claims 88% faster delivery `[Unverified: vendor case-study figure]`).
- "Building Without the Handoffs" — Jun 29 (Headless CMS / Governance & Security).
- "Introducing Clips: An open-source, agent-native Loom alternative" — Jun 26.
- Builder's blog is now almost entirely **AI / agent-native** framed.

---

## Medusa
**Open issues:** 111 (verified). Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Newest / notable open issues (verified this run):**
- **#15406** — Local dev setup for contributors is confusing, undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — [Bug] `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — needs triaging / v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE in npm workspaces — bug — May 13, 2026
- **#15360** — [Bug] Race condition in cart promotions can create duplicate line-item adjustments — bug / v2.0 — May 11, 2026 `[Inference: data-integrity]`
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — bug — May 6, 2026 `[Inference: financial-correctness]`
- **#15343** — `getDatabaseURL` breaks for passwords with special URL chars (#, @, :) — bug / v2.0 — May 8, 2026

**Blog (verified this run):**
- **"Announcing new Layout Composer in Medusa Admin"** — Nicolas Gorga, Jul 1, 2026 (Product) — new admin layout-composition capability.

---

## Method & caveats

- GitHub counts/issue metadata and all 10 vendor blogs were fetched live and verified this run (2026-07-11 ~23:04 +07). The GitHub "Issues N" count includes only open issues; PR counts are shown separately on each repo and excluded here.
- Newest-open-issue ordering is GitHub's default relevance view, cross-checked against open dates; a few pinned/tracking issues (e.g., Ghost #23924, Keystone #8987) are excluded from "newest."
- Security characterizations use the vendor's own label/title where one exists (Strapi #26494, Builder #4501, Ghost #27445). Where no vendor severity label exists, the security relevance is my `[Inference]` from the title/topic and is not a confirmed advisory. Named CVEs (Strapi disclosure) are quoted as published.
- Vendor-reported performance/impact figures (Sanity v6 build speedups, Builder KPMG 88%) are labeled `[Unverified]` — they are marketing claims, not independently confirmed.
