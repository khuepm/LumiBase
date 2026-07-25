# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task) · **Coverage:** 10 headless CMS projects
**Last refreshed:** 2026-07-11 00:04 (+07)

> Sources: each project's GitHub Issues page (server-rendered), fetched live this run. Release/version prose is carried forward from the 2026-07-10 digest (web search of official changelogs) and re-checked this run via web search; where a version could not be re-verified live it is labeled `[Unverified]`. Issue numbers and dates are quoted as shown on GitHub.

---

## TL;DR — Changes since previous run (2026-07-10)

**No change.** Every one of the 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue count as the last run. A web-search sweep for any release or CVE dated after 2026-07-10 surfaced **nothing new** — the only security items returned are the already-tracked Ghost CVEs (**CVE-2026-26980** SQLi, CVSS 9.4, and **CVE-2026-29053** theme RCE), both fixed in **Ghost 6.19.1**.

Newest-open confirmed this run: Strapi Jun 2 (#26524) · Directus Apr 15 (#27129) · Payload Apr 15 (#16288) · Sanity May 24 (#12870) · Ghost May 6 (#27717) · KeystoneJS Apr 3 (#9798) · TinaCMS Jul 7 (#7169) · Decap Jul 5 (#7875) · Builder.io Apr 4 (#4501) · Medusa May 14 (#15406).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

Freshest tracker items across all 10 remain **TinaCMS #7169** (Jul 7 — semantic `<thead>/<th>` for markdown tables) and **Decap #7875** (Jul 5 — path-traversal in decap-server proxy, critical). Nothing new to action.

---

## At a glance

| CMS | Latest version | Open issues | Newest open issue | Security items this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 5.50.0 `[Unverified]` | 396 | #26524 (Jun 2) | #26494 register-admin rate limit (critical) |
| Directus | v11.17.2 `[Unverified]` | 326 | #27129 (Apr 15) | — |
| Payload | v3.85.1 (4.0 pre-alpha) `[Unverified]` | 288 | #16288 (Apr 15) | — |
| Sanity | v6.2.0 `[Unverified]` | 75 | #12870 (May 24) | — |
| Ghost | 6.19.1 (6.x rolling) `[Unverified]` | 63 | #27717 (May 6) | #27445 malware scan (feature) |
| KeystoneJS | 6.5.2 `[Unverified]` | 100 | #9798 (Apr 3) | depth-limit proposal #9789 |
| TinaCMS | v4 track `[Unverified]` | 378 | #7169 (Jul 7) | — |
| Decap | v3.11.0 (npm 3.14.1) `[Unverified]` | 559 | #7875 (Jul 5) | #7875 path traversal (critical) |
| Builder.io | SDK (no single tag) | 62 | #4501 (Apr 4) | #4501 postMessage RCE (CWE-346) |
| Medusa | v2.16.0 `[Unverified]` | 111 | #15406 (May 14) | refund/promotion reliability bugs |

Cross-cutting signals (unchanged): **AI/MCP tooling** remains a first-class roadmap item at Directus, Payload, Sanity and Ghost; **Next.js 16.2 / React 19 migration friction** continues to hit Payload and Medusa; **three security-grade open issues** persist — Strapi #26494, Decap #7875, Builder.io #4501.

---

## Strapi
**Latest version:** 5.50.0 `[Unverified]`. Open issues: 396. Ghost of prior context: relation lifecycle fixes, admin performance work, and a new `publicationFilter` query parameter. Strapi 4 reached End of Life; five v4 LTS CVEs were patched as a final courtesy.

**Newest / notable open issues (GitHub):**

- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / v5 — opened Jun 2, 2026
- **#26494** — No rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — opened May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — opened May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres and mysql — bug / tooling — opened May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — opened May 29, 2026
- **#26468** — Wildcard characters in filters not escaped, causing incorrect literal matching — bug / severity: medium / core:database / v5 — opened May 28, 2026
- **#26387** — Replace media updates metadata but asset content remains original file — bug / severity: high / core:upload / **status: confirmed** / v5 — opened May 19, 2026

**In progress:** Content Manager stability crashes (#26434, #26396, #26389) and the SEO plugin / marketplace panel-API migration (#26463, #26437).

---

## Directus
**Latest version:** v11.17.2 `[Unverified]`. Open issues: 326. Recent themes: timezone-aware datetime, content versioning (global draft versions), and an AI Assistant across OpenAI/Anthropic/Gemini.

**Newest / notable open issues (GitHub):**

- **#27129** — Back button broken for all item pages — Needs Info — opened Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when a non-admin policy has `directus_flows:trigger` — Needs Info — opened Apr 15, 2026
- **#27119** — "Unable to register API extensions hook because document is not defined" — bug / Ext SDK — opened Apr 15, 2026
- **#27111** — Apple OAuth `first_name`/`last_name` not populated on registration — opened Apr 14, 2026
- **#27094** — `@directus/api` uses old versions of tsdown and openid-client — opened Apr 11, 2026
- **#27091** — "Save as copy" throws error — bug / regression / high impact / Studio — opened Apr 10, 2026
- **#27062** — [Map Layout] PostGIS `geometry.Point` geospatial field produces error — bug / Engine — opened Apr 7, 2026
- **#27042** — WYSIWYG not rendering when returning from edit then revisiting record (v11.16.1) — bug / high impact — opened Apr 3, 2026
- **#27039** — [MCP] files tool update action fails — schema typed as array but API expects object — bug / AI-MCP / high impact — opened Apr 3, 2026
- **#27003** — Aliased GraphQL relational objects within a fragment return null — bug / GraphQL / regression / Enterprise — opened Mar 30, 2026

---

## Payload CMS
**Latest version:** v3.85.1, with 4.0 in pre-alpha `[Unverified]`. Open issues: 288. Recent theme: Next.js 16.2 compatibility and admin redesign.

**Newest / notable open issues (GitHub):**

- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — opened Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — opened Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — opened Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres — db: postgres — opened Apr 15, 2026
- **#16273** — Malfunctioning lexical rich text editing in custom block drawer — richtext-lexical — opened Apr 14, 2026
- **#16270** — Cache components might cause full page refresh when selecting media — area: core / needs-triage — opened Apr 13, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — opened Apr 8, 2026

---

## Sanity
**Latest version:** v6.2.0 `[Unverified]`. Open issues: 75. Recent theme: AI "skills" CLI, Content Releases.

**Newest / notable open issues (GitHub):**

- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — opened May 24, 2026
- **#12869** — Tests Dashboard & auto-balancing Playwright shards — opened May 23, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — opened May 17, 2026
- **#12834** — Feature: include document language (or field values) in edit intent params for `canHandleIntent` routing — opened May 15, 2026
- **#12812** — Feature: preserve original image metadata / add IPTC metadata on photo upload — CLDX — opened May 10, 2026
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — opened Apr 16, 2026

---

## Ghost
**Latest version:** 6.19.1 (6.x rolling; 6.0 breaking-changes tracked in #23924) `[Unverified]`. Open issues: 63. Security note: 6.19.1 patched **CVE-2026-26980** (Content API blind SQLi, CVSS 9.4, mass-exploited on 700+ sites for ClickFix malware) and **CVE-2026-29053** (theme RCE).

**Newest / notable open issues (GitHub):**

- **#27717** — Document HelmForge chart as a third-party Kubernetes install option — needs:triage — opened May 6, 2026
- **#27551** — Signup Card email placeholder hardcoded ("Your email"), no i18n / per-card override — opened Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — opened Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — opened Apr 17, 2026
- **#27415** — Share button broken: `portal.min.js` not loaded when subscriptions disabled — opened Apr 15, 2026
- **#26677** — Admin API always saves revisions even when `save_revision=false` — opened Mar 3, 2026

---

## KeystoneJS
**Latest version:** 6.5.2 `[Unverified]`. Open issues: 100. Recent theme: security hardening, dependency bumps.

**Newest / notable open issues (GitHub):**

- **#9798** — Bump Next to >15.5.13 — dependencies — opened Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query depth limits by default? — Feature — opened Mar 18, 2026
- **#9785** — `statelessSessions` attempts to use unsupported `Authorization: Basic` header rather than the cookie — discussion/docs — opened Mar 6, 2026
- **#9772** — Error loading single entity: "ID!" used in position expecting type "IDFilter" — opened Feb 3, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing Post on fresh CLI install — opened Jan 24, 2026
- **#9753** — Access operation function called with no session during successful login — opened Dec 18, 2025
- **#9665** — Field editable when `graphql.omit.update` is set — Bug / help wanted — opened Jul 22, 2025

---

## TinaCMS
**Latest version:** v4 track `[Unverified]`. Open issues: 378. Recent theme: rich-text/markdown improvements, deploy-gate CLI work, visual-editor UX.

**Newest / notable open issues (GitHub):**

- **#7169** — ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — opened Jul 7, 2026
- **#7162** — Starter template 'basic' failed during install with yarn using Node 22 — bug — opened Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` unnavigable — bug — opened Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, exceeding 1MB preview-overlay cap silently — opened Jul 1, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 — opened Jun 30, 2026
- **#7092** — ✨ Plugin System — Auth Plugin — better-auth — technical-debt / v4 — opened Jun 23, 2026
- **#7068 / #7067** — Split `tinacms build` from a deploy-time publish gate; schema gate should wait for `schemaSha` convergence — @tinacms/cli — opened Jun 18, 2026

---

## Decap CMS
**Latest version:** v3.11.0 (npm 3.14.1) `[Unverified]`. Open issues: 559. Recent theme: new richtext widget, Git backends.

**Newest / notable open issues (GitHub):**

- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside the configured repo root — type: bug (**critical**) — opened Jul 5, 2026
- **#7873** — Images not rendered in preview starting from v3.13.0 — bug — opened Jun 29, 2026
- **#7871** — TypeError: Cannot read properties of undefined (reading 'path') — opened Jun 29, 2026
- **#7870 / #7869 / #7868** — `removeChild` NotFoundError; destructure 'url' of `e.element.data` undefined (x2) — opened Jun 28, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — bug — opened Jun 25, 2026
- **#7823** — Support open authoring for GitLab — feature — opened May 21, 2026
- **#7802 / #7800** — Can't copy/paste into Rich Text; preview pane stops accepting scroll after resizing divider — bug — opened May 4/2, 2026

---

## Builder.io
**Latest version:** SDK-based, no single repo tag. Open issues: 62. Recent theme: Qwik reactivity, CSP.

**Newest / notable open issues (GitHub):**

- **#4501** — Security: cross-origin code execution via unvalidated `postMessage` in builder-block (**CWE-346**) — opened Apr 4, 2026
- **#4220** — Add validation to prevent duplicate component names during registration — opened Jan 8, 2026
- **#4212** — Using `eval` for detecting server code throws CSP error — opened Dec 15, 2025
- **#4191** — EnableEditor state merging breaks reactivity of blocks in Qwik — opened Nov 25, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements — opened Aug 30, 2025

---

## Medusa
**Latest version:** v2.16.0 `[Unverified]`. Open issues: 111. Recent theme: async payments, price tiers, React 19 migration.

**Newest / notable open issues (GitHub):**

- **#15406** — Local dev setup for contributors confusing/undocumented, lacks hot reload for plugins — docs — opened May 14, 2026
- **#15399** — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — v2.0 — opened May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE — bug — opened May 13, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — bug / v2.0 — opened May 11, 2026
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — bug — opened May 6, 2026
- **#15341** — Build silently excludes any file path containing 'test' substring — good first issue — opened May 8, 2026

---

## Methodology & caveats

- GitHub Issues pages are server-rendered and were fetched live this run; issue IDs, titles, dates, and open-issue counts are quoted as displayed.
- Version numbers marked `[Unverified]` are carried from prior digests / web search and were not confirmed against a live release tag this run.
- Blog posts were not individually fetched this run; no new release or CVE dated after 2026-07-10 was found via web search.
- This is a monitoring digest, not a recommendation. Security items (Strapi #26494, Decap #7875, Builder.io #4501, Ghost CVE-2026-26980/-29053) are flagged for awareness; assess applicability to your own deployment before acting.
