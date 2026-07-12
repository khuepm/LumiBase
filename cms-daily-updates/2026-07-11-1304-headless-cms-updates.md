# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 13:04 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 12:04 (+07)

> Sources this run: each project's **GitHub Issues** page (open-issue counts + newest open issue ID/title/labels/open-date, quoted exactly as shown), fetched live and verified this cycle for all 10. Two vendor blogs (Strapi, Medusa) were re-fetched live this run and returned fully. The Directus blog was re-fetched but returned a **degraded/partial** render (hydrated only through Apr-2026 posts, missing the Jul 10 article confirmed last run) — its latest post is carried forward as `[Unverified]` this cycle. Five blogs (Payload, Sanity, Ghost, KeystoneJS, TinaCMS, Decap, Builder.io) were not fetched this run and rely on carried-forward context labeled `[Unverified]`. Version numbers not printed on a fetched page are `[Unverified]`. Security reads beyond issues explicitly labeled/titled as security are `[Inference]` (based on title/topic, not a confirmed advisory/CVE).

---

## TL;DR — Changes since previous run (2026-07-11 12:04)

**No change this cycle.** All 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 12:04 run. Verified live this run.

**Blogs re-fetched this cycle:**
- **Strapi** — *"The Strapi MCP server is now GA"* (Jun 29, 2026) still top. CVE-disclosure post (CVE-2025-64526, CVE-2026-22599/22706/22707/27886, May 13, 2026) still live. No change.
- **Medusa** — *"Announcing new Layout Composer in Medusa Admin"* (Jul 1, 2026) still top. No change.
- **Directus** — blog fetch **degraded this run** (article list hydrated only through Apr 22, 2026; the Jul 10 "AI is straining vulnerability disclosure for maintainers" article confirmed at 12:04 did not appear in this render). No regression assumed — latest post carried forward as `[Unverified]`; will re-confirm next cycle.

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**Top action items (security-grade, all persist):** **Strapi #26494** (no rate limit on register-admin + race condition, critical) · **Decap #7875** (path traversal in decap-server proxy, critical) · **Builder.io #4501** (postMessage cross-origin code execution, CWE-346).

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post (this run) | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | Strapi MCP server now GA (Jun 29) ✅ verified | #26494 register-admin rate limit (critical) |
| Directus | 326 | #27129 (Apr 15) | Jul 10 vuln-disclosure post `[Unverified]` (degraded fetch) | #27094 outdated openid-client `[Inference]` |
| Payload | 288 | #16288 (Apr 15) | Early look at Payload 4.0 (Jun 9) `[Unverified]` | #16214 MCP plugin null-type `[Inference]` |
| Sanity | 75 | #12870 (May 24) | not fetched this run `[Unverified]` | #12794 preview secret wrong dataset `[Inference]` |
| Ghost | 63 | #27717 (May 6) | not fetched this run `[Unverified]` | #27445 upload malware-scan (feature req) |
| KeystoneJS | 100 | #9798 (Apr 3) | not fetched this run `[Unverified]` | #9789 GraphQL depth-limit `[Inference]` |
| TinaCMS | 378 | #7169 (Jul 7) | not fetched this run `[Unverified]` | — |
| Decap | 559 | #7875 (Jul 5) | not fetched this run `[Unverified]` | #7875 path traversal (critical) |
| Builder.io | 62 | #4501 (Apr 4) | not fetched this run `[Unverified]` | #4501 postMessage RCE (CWE-346) |
| Medusa | 111 | #15406 (May 14) | Layout Composer in Medusa Admin (Jul 1) ✅ verified | #15360 promo race / #15306 refund `[Inference]` |

**Cross-cutting signals:** AI/agent tooling continues to dominate the fetched blogs (Strapi MCP GA, Medusa MCP/agent tooling + Layout Composer). Framework-migration friction persists as a bug driver — Next.js 16.2 / Turbopack on Payload (#16286, #16288), Node 22/24 on TinaCMS (#7162, #7109) and Builder.io (#4137), React 19 peer-dep conflicts on Medusa (#15398), Next >15.5.13 bump on Keystone (#9798). Two critical, still-open trust-boundary vulns (Decap path traversal #7875, Builder postMessage RCE #4501) remain unresolved.

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
- **#26434** — Content Manager "Cannot read properties of undefined (reading 'attributes')" navigating Single Types — bug / Urgent / critical / core:content-manager — May 26, 2026

**Blog highlights (live this run):** *"The Strapi MCP server is now GA"* (Jun 29) still top. Also live: June Community Call recap (Jun 29), release roundup Mar–Jun 2026 (Jun 18), "How To Extend Strapi's MCP Server With Custom Tools via a Plugin" (Jun 13), "Building Docs for the AI Era, Part 1: Self-Healing Docs" (Jun 11), "How to Migrate from Contentful to Strapi Using a Claude Code Skill" (Jun 4), and the CVE-disclosure post (May 13).

---

## Directus
**Open issues:** 326 (verified). Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Newest / notable open issues (verified this run):**
- **#27129** — Back button broken for all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` permission — Needs Info — Apr 15, 2026
- **#27119** — Cannot register API extensions hook — `document is not defined` — Bug / Ext SDK / Extensions / Low Impact — Apr 15, 2026
- **#27111** — Apple OAuth `first_name`/`last_name` not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` using an old version of `tsdown` and `openid-client` — Apr 11, 2026
- **#27091** — Save-as-copy throws error — Bug / Regression / Studio / High Impact — Apr 10, 2026
- **#27062** — [Map Layout] postgis `geometry.Point` geospatial field produces error — Bug / Needs Info — Apr 7, 2026
- **#27042** — WYSIWYG not rendering on record revisit as non-admin user (v11.16.1) — Bug / High Impact — Apr 3, 2026
- **#27039** — [MCP] files-tool update fails: schema typed as array but API expects object — AI/MCP / Bug / High Impact — Apr 3, 2026

**Blog highlights:** `[Unverified]` this run — the blog re-fetch returned a **degraded render** (article list hydrated only through *"Evolving Our License for Long-Term Sustainability"*, Apr 22, 2026, and older; the Jul 10 *"AI is straining vulnerability disclosure for maintainers"* article confirmed at 12:04 did not appear). No regression assumed; carried forward and flagged to re-confirm next cycle.

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
- **#16262** — `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported (richtext-lexical) — Apr 13, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL with 30+ lateral joins) — Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — Apr 8, 2026

**Blog highlights:** `[Unverified]` this run — blog not re-fetched. Carried context: *"An early look at Payload 4.0: Admin UI Redesign, TanStack, MCP, and More"* (Jun 9); "Critical Security Notice Affecting React 19 and Next.js" (Dec 4, 2025).

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
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — Apr 16, 2026

**Blog highlights:** `[Unverified]` this run — blog not re-fetched. Carried context: *"Agents leave receipts. We read 1.46 million of them"* (Jun 15).

**Security watch [Inference]:** #12794 (preview secret written to wrong dataset), #12733 (password-strength validation).

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
- **#26677** — Admin API always saves revisions even when `save_revision=false` — needs:triage — Mar 3, 2026
- **#26607** — Editor opening staff settings triggers forbidden API calls + unrelated permission toast — needs:triage — Feb 26, 2026
- **#26399** — Unhandled `JSON.parse()` crash in Portal on malformed preview URLs (potential DoS) — community — Feb 14, 2026

**Blog/changelog:** `[Unverified]` this run — not re-fetched.

**Security watch:** #27445 (upload malware-scan feature request); #26399 (`JSON.parse()` crash `[Inference]`).

---

## KeystoneJS
**Open issues:** 100 (verified). Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

**Newest / notable open issues (verified this run):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query-depth limits by default? — Feature — Mar 18, 2026
- **#9785** — `statelessSessions` uses unsupported `Authorization: Basic` header instead of cookie — discussion / documentation / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM on Windows — Feb 20, 2026
- **#9772** — Error loading single entity: `ID!` used where `IDFilter` expected — Feb 3, 2026
- **#9766** — Document Fields Demo page refers to a form that doesn't exist — Jan 24, 2026
- **#9765** — Admin UI throws Unhandled Runtime Error editing Post on fresh CLI install — Jan 24, 2026
- **#9753** — Access operation function called with no session during successful login — Dec 18, 2025

**Blog:** `[Unverified]` this run — not re-fetched; blog remains infrequent/stale.

**Security watch [Inference]:** #9789 (query-depth → DoS hardening), #9785 & #9753 (auth/session handling).

---

## TinaCMS
**Open issues:** 378 (verified). Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Newest / notable open issues (verified this run):**
- **#7169** — ✨ Rich-text: render semantic `<thead>`/`<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template "basic" fails during install with yarn using Node 22 — bug — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false` + `delete:false` is unnavigable — bug / pending triage — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap with no error — Jul 1, 2026
- **#7118** — 📝 Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export) — Astro — Jun 30, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / pending triage / v4 — Jun 30, 2026
- **#7109** — Starter template "tina-astro-starter" fails during build with npm using Node 24 — bug — Jun 28, 2026
- **#7096** — Pressing Enter in editor inserts line break at wrong position, corrupts bullet-list formatting — Needs Refinement — Jun 25, 2026
- **#7092** — ✨ Plugin System — Auth Plugin — better-auth — technical-debt / v4 — Jun 23, 2026

**Blog:** `[Unverified]` this run — not re-fetched. Carried context: *"Separate Content Repos are here for TinaCloud"* (Jun 12).

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
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026
- **#7816** — Soft line breaks in new richtext widget — type: bug — May 19, 2026

**Blog:** `[Unverified]` this run — not re-fetched. Carried context: *"Announcing Decap Turbo"* (May 5).

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
- **#4165** — Qwik temporary code not reverted yet inside content component — Oct 23, 2025
- **#4164** — Storybook 10 support — Oct 20, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements — Aug 30, 2025

**Blog:** `[Unverified]` this run — not re-fetched. Carried context: *"Building Without the Handoffs"* (Jun 29).

**Security:** ⚠️ **#4501** — explicit, unresolved cross-origin code-execution vuln. #4212 (`eval`/CSP) security-adjacent `[Inference]`.

---

## Medusa
**Open issues:** 111 (verified). Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Newest / notable open issues (verified this run):**
- **#15406** — Local dev setup for contributors is confusing/undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled — needs triaging / v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE — requires-team / bug — May 13, 2026
- **#15371** — RTL layout issues in admin dashboard (Hebrew/Arabic/Farsi) — help-wanted / bug — May 11, 2026
- **#15360** — Race condition in cart promotions can create duplicate line-item adjustments — requires-team / bug / v2.0 — May 11, 2026
- **#15353** — Error sorting orders by Total / Fulfillment status / Payment status — good first issue / bug / v2.0 — May 10, 2026
- **#15343** — `getDatabaseURL` breaks for passwords containing special URL characters (#, @, :) — bug / v2.0 — May 8, 2026
- **#15341** — Build silently excludes any file path containing 'test' substring — good first issue / bug — May 8, 2026
- **#15321** — `db:sync-links` generates invalid PostgreSQL schema-qualified `RENAME TO` — help-wanted / bug — May 7, 2026
- **#15306** — Refund workflow reports success after partial refund failures (silent failure in `refundPaymentsStep`) — needs triaging / bug — May 6, 2026

**Blog highlights (live this run):** *"Announcing new Layout Composer in Medusa Admin"* by Nicolas Gorga (Jul 1) still top.

**Financial-integrity watch [Inference]:** #15360 (duplicate promotion adjustments) and #15306 (refund workflow reports success after partial failures).

---

## Methodology & caveats
- GitHub open-issue counts and newest-issue details are quoted exactly from the live issue pages at fetch time (~13:04 +07), verified for all 10 projects.
- Two vendor blogs (Strapi, Medusa) were re-fetched live this run and returned fully. The Directus blog re-fetch returned a degraded/partial render (missing its latest posts), so its latest article is labeled `[Unverified]` and carried forward. The other blogs were not fetched and are labeled `[Unverified]`.
- "Newest open issue" is by open date; some pages list a higher-priority/pinned issue first, so the top-listed item is not always the most recent.
- Security reads beyond issues explicitly labeled/titled as security are marked `[Inference]` (based on title/topic, not confirmed advisories or CVEs).
- No tracker deltas vs. the 12:04 run. Strapi and Medusa blogs unchanged; Directus blog fetch was degraded (no confirmed change). A fully steady-state cycle.
