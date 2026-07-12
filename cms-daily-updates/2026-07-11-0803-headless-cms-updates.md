# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 08:03 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 06:24 (+07)

> Sources this run: each project's **GitHub Issues** page (open-issue counts + newest open issue ID/title/labels/open-date quoted exactly as shown) and each project's **blog**, both fetched live and verified this cycle. Version numbers not printed on a fetched page are labeled `[Unverified]`. Security reads beyond explicitly-labeled issues are marked `[Inference]`.

---

## TL;DR — Changes since previous run (2026-07-11 06:24)

**Tracker data: no change.** All 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 06:24 run. Verified live this run.

**Blogs re-fetched this cycle (not carried forward).** One newly-surfaced post:
- **Directus blog — NEW:** *"AI is straining vulnerability disclosure for maintainers"* by Rijk van Zanten — **Jul 10, 2026**. (Replaces the previously carried-forward "v12 license change" as the latest Directus post.)
- **Strapi blog — updated latest:** *"The Strapi MCP server is now GA"* — **Jun 29, 2026** (newer than the previously carried-forward Jun 13 "Extend MCP via Plugin" post). Also live on the blog: a CVE-disclosure post (CVE-2025-64526, CVE-2026-22599/22706/22707/27886) dated May 13, 2026.

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**Top action items (security-grade, all persist):** **Strapi #26494** (no rate limit on register-admin + race condition, critical) · **Decap #7875** (path traversal in decap-server proxy, critical) · **Builder.io #4501** (postMessage cross-origin code execution, CWE-346).

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post (date, live this run) | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | Strapi MCP server now GA (Jun 29) | #26494 register-admin rate limit (critical) |
| Directus | 326 | #27129 (Apr 15) | **AI straining vuln disclosure (Jul 10) — NEW** | #27094 outdated openid-client [Inference] |
| Payload | 288 | #16288 (Apr 15) | Early look at Payload 4.0 (Jun 9) | — |
| Sanity | 75 | #12870 (May 24) | Agents leave receipts — 1.46M read (Jun 15) | — |
| Ghost | 63 | #27717 (May 6) | changelog unavailable this run | #27445 upload malware-scan (feature req) |
| KeystoneJS | 100 | #9798 (Apr 3) | A year of releases in review (Aug 2024, stale) | #9789 GraphQL depth-limit [Inference] |
| TinaCMS | 378 | #7169 (Jul 7) | Separate Content Repos for TinaCloud (Jun 12) | — |
| Decap | 559 | #7875 (Jul 5) | Announcing Decap Turbo (May 5) | #7875 path traversal (critical) |
| Builder.io | 62 | #4501 (Apr 4) | Building Without the Handoffs (Jun 29) | #4501 postMessage RCE (CWE-346) |
| Medusa | 111 | #15406 (May 14) | Layout Composer in Medusa Admin (Jul 1) | #15360 promo race / #15306 refund [Inference] |

**Cross-cutting signals:** AI/agent tooling still dominates blog messaging (Strapi MCP GA, Sanity agent-ops, Directus's new post on AI-driven vuln-disclosure load, Builder.io governance). Framework-migration friction persists as a bug driver — Next.js 16.2 / Turbopack on Payload (#16286, #16288), React 19 peer-dep conflicts on Medusa (#15398). Two critical, still-open supply-of-trust vulns (Decap path traversal, Builder postMessage RCE) remain unresolved.

---

## Strapi
**Open issues:** 396 (verified). Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues

**Newest / notable open issues (verified this run):**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / pending reproduction / v5 — Jun 2, 2026
- **#26494** — no rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql services — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching (injection-adjacent) — bug / severity: medium / core:database / v5 — May 28, 2026

**Blog highlights (live this run):** *"The Strapi MCP server is now GA"* (Jun 29) — stable surface to wire agents to content types. CVE-disclosure post covering CVE-2025-64526 and CVE-2026-22599/22706/22707/27886 (May 13).

---

## Directus
**Open issues:** 326 (verified). Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Newest / notable open issues (verified this run):**
- **#27129** — Back button broken for all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` permission — Needs Info — Apr 15, 2026
- **#27119** — Cannot register API extensions hook — `document is not defined` — Bug / Ext SDK / Extensions — Apr 15, 2026
- **#27111** — Apple OAuth `first_name`/`last_name` not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` using an old version of `tsdown` and `openid-client` — Apr 11, 2026
- **#27091** — Save-as-copy throws error — Bug / Regression / Studio / High Impact — Apr 10, 2026

**Blog highlights (live this run):** **NEW** — *"AI is straining vulnerability disclosure for maintainers"* by Rijk van Zanten (Jul 10) — maintainer-side burden of AI-generated / low-quality vulnerability reports.

**Security watch [Inference]:** #27094 (outdated `openid-client` auth dependency), #27124 (permission-handling 500).

---

## Payload
**Open issues:** 288 (verified). Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues

**Newest / notable open issues (verified this run):**
- **#16288** — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into a Folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres — db: postgres / invalid-reproduction — Apr 15, 2026
- **#16273** — Malfunctioning lexical rich-text editing in custom block drawer — plugin: richtext-lexical — Apr 14, 2026
- **#16270** — Cache components may cause full page refresh when selecting media — area: core / needs-triage — Apr 13, 2026

**Blog highlights (live this run):** *"An early look at Payload 4.0: Admin UI Redesign, TanStack, MCP, and More"* (Jun 9). History includes a "Critical Security Notice Affecting React 19 and Next.js" (Dec 4, 2025).

---

## Sanity
**Open issues:** 75 (verified). Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues

**Newest / notable open issues (verified this run):**
- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — May 24, 2026
- **#12869** — Tests Dashboard & Auto-balancing Playwright Shards — May 23, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature request: include document language / field values in edit-intent params for `canHandleIntent` routing — Feature — May 15, 2026
- **#12812** — Feature request: preserve original image metadata / add IPTC metadata on upload — CLDX / Feature — May 10, 2026
- **#12787** — Feature request: support multiple `typegen` configurations — CLI / Feature — May 5, 2026
- **#12733** — Unable to create new account — server returns "Password is too weak" for a strong password — identity / Bug — Apr 22, 2026

**Blog highlights (live this run):** *"Agents leave receipts. We read 1.46 million of them"* (Jun 15) — analysis of agent-driven content operations.

---

## Ghost
**Open issues:** 63 (verified). Resources: https://ghost.org/resources/ · Changelog: https://ghost.org/changelog/ · Issues: https://github.com/TryGhost/Ghost/issues

**Newest / notable open issues (verified this run, excluding pinned #13265/#23924/#23361):**
- **#27717** — Document HelmForge chart as a third-party Kubernetes install option — needs:triage — May 6, 2026
- **#27551** — Signup Card email placeholder hardcoded ("Your email"), no i18n / per-card override — needs:triage — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — needs:triage — Apr 17, 2026
- **#27415** — Share button broken because `portal.min.js` not loaded when subscriptions disabled — needs:triage — Apr 15, 2026
- **#26905** — HTML entities visible in email inbox publication date — community — Mar 20, 2026

**Blog/changelog:** `[Unverified]` — the Ghost changelog could not be retrieved this run (fetch provenance error). Carried context: #26399 (unhandled `JSON.parse()` crash on malformed preview URLs, potential DoS) and #26607 (forbidden API calls on staff-settings open) remain open.

**Security watch:** #27445 (upload malware-scan feature request).

---

## KeystoneJS
**Open issues:** 100 (verified). Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

**Newest / notable open issues (verified this run):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query-depth limits by default? — Feature — Mar 18, 2026
- **#9785** — `statelessSessions` uses unsupported `Authorization: Basic` header instead of cookie — discussion / documentation / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — Error loading single entity: `ID!` used where `IDFilter` expected — Feb 3, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing Post on fresh CLI install — Jan 24, 2026

**Blog:** *"A year of releases in review"* (Aug 7, 2024) — blog remains stale/infrequent.

**Security watch [Inference]:** #9789 (query-depth → DoS hardening), #9785 & #9753 (auth/session handling).

---

## TinaCMS
**Open issues:** 378 (verified). Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Newest / notable open issues (verified this run):**
- **#7169** — ✨ Rich-text: render semantic `<thead>`/`<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template "basic" fails during install with yarn using Node 22 — bug — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` is unnavigable (single-document auto-open fires inside folder views) — bug / pending triage — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap with no error — Jul 1, 2026
- **#7118** — 📝 Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export) — Astro — Jun 30, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / pending triage / v4 / YakShaver — Jun 30, 2026

**Blog:** *"Separate Content Repos are here for TinaCloud"* by Josh Berman (Jun 12).

---

## Decap CMS
**Open issues:** 559 (verified). Blog: https://decapcms.org/blog/ · Issues: https://github.com/decaporg/decap-cms/issues

**Newest / notable open issues (verified this run):**
- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside the configured repository root — type: bug — **Jul 5, 2026** ⚠️ **critical**
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871** — `TypeError: Cannot read properties of undefined (reading 'path')` — Jun 29, 2026
- **#7870** — `NotFoundError: Failed to execute 'removeChild' on 'Node'` — Jun 28, 2026
- **#7869 / #7868** — `TypeError: Cannot destructure property 'url' of 'e.element.data'` (duplicate pair) — Jun 28, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026

**Blog:** *"Announcing Decap Turbo"* by Martin Jagodic (May 5).

**Security:** ⚠️ **#7875** — explicit, unresolved path-traversal vulnerability in the self-hosted proxy. Highest-priority Decap item.

---

## Builder.io
**Open issues:** 62 (verified). Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues

**Newest / notable open issues (verified this run):**
- **#4501** — **Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** — **Apr 4, 2026** ⚠️ RCE-class
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4219** — Vue 3 `[Vue warn]: Extraneous non-props attributes` — Dec 19, 2025
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4191** — `EnableEditor` state merging breaks reactivity of blocks in Qwik — Nov 25, 2025
- **#4166** — State stored is extremely wasteful — Oct 25, 2025

**Blog:** *"Building Without the Handoffs"* by Amy Cross (Jun 29) — topics: Headless CMS, Governance & Security.

**Security:** ⚠️ **#4501** — explicit, unresolved cross-origin code-execution vuln. #4212 (`eval`/CSP) security-adjacent `[Inference]`.

---

## Medusa
**Open issues:** 111 (verified). Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Newest / notable open issues (verified this run):**
- **#15406** — Local dev setup for contributors is confusing/undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — needs triaging / v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE in npm workspaces — requires-team / bug — May 13, 2026
- **#15371** — RTL layout issues in admin dashboard (Hebrew/Arabic/Farsi) — help-wanted / bug — May 11, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — requires-team / bug / v2.0 — May 11, 2026
- **#15353** — Error sorting orders by Total / Fulfillment status / Payment status — good first issue / bug / v2.0 — May 10, 2026

**Blog:** *"Announcing new Layout Composer in Medusa Admin"* by Nicolas Gorga (Jul 1).

**Financial-integrity watch [Inference]:** #15360 (duplicate promotion adjustments) and #15306 (refund workflow reports success after partial failures).

---

## Methodology & caveats
- GitHub open-issue counts and newest-issue details are quoted exactly from the live issue pages at fetch time (08:03 +07). Blogs were fetched live this run except the Ghost changelog, which returned a fetch error and is labeled `[Unverified]`.
- "Newest open issue" is by open date; some pages list a higher-priority/pinned issue first, so the top-listed item is not always the most recent.
- Security reads beyond issues explicitly labeled/titled as security are marked `[Inference]` (based on title/topic, not confirmed advisories or CVEs).
- No tracker deltas vs. the 06:24 run; the only substantive change this cycle is the newly-surfaced Directus blog post (Jul 10) and live re-fetch of blogs.
