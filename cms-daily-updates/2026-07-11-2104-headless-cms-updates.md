# Headless CMS — Daily Update Digest

**Date:** 2026-07-11 · **Run:** automated (scheduled task, 21:04 +07) · **Coverage:** 10 headless CMS projects
**Previous run:** 2026-07-11 20:04 (+07)

> Sources this run: each project's **GitHub Issues** page (open-issue counts + newest open issues with ID/title/labels/open-date, quoted from the fetched page), fetched live and verified this cycle for all 10. This run the **Strapi and Medusa blogs were re-fetched and returned real content** (verified); the other 8 vendor blogs were not re-fetched, so their "latest blog post" lines are carried forward and labeled `[Unverified]`. Version numbers not printed on a fetched page are `[Unverified]`. Security reads beyond issues explicitly labeled/titled as security are `[Inference]` (based on title/topic, not a confirmed advisory/CVE).

---

## TL;DR — Changes since previous run (2026-07-11 20:04)

**No change this cycle.** All 10 GitHub issue trackers returned the identical newest open issue (same ID, title, open date) and identical open-issue counts as the 20:04 run. Verified live this run.

**Blogs:** Strapi and Medusa blogs were re-fetched this cycle and their latest posts match the carried-forward lines — now **verified** (Strapi MCP GA, Jun 29; Medusa Layout Composer, Jul 1). Remaining 8 blogs carried forward as `[Unverified]`.

Newest-open issue confirmed this run: Strapi #26524 (Jun 2) · Directus #27129 (Apr 15) · Payload #16288 (Apr 15) · Sanity #12870 (May 24) · Ghost #27717 (May 6) · KeystoneJS #9798 (Apr 3) · TinaCMS #7169 (Jul 7) · Decap #7875 (Jul 5) · Builder.io #4501 (Apr 4) · Medusa #15406 (May 14).

Open-issue counts (unchanged): Strapi 396 · Directus 326 · Payload 288 · Sanity 75 · Ghost 63 · KeystoneJS 100 · TinaCMS 378 · Decap 559 · Builder.io 62 · Medusa 111.

**Top action items (security-grade, all persist):** **Strapi #26494** (no rate limit on register-admin + race condition, critical) · **Decap #7875** (path traversal in decap-server proxy, critical) · **Builder.io #4501** (postMessage cross-origin code execution, CWE-346).

---

## At a glance

| CMS | Open issues | Newest open issue (verified) | Latest blog post | Security item this cycle |
| --- | --- | --- | --- | --- |
| Strapi | 396 | #26524 (Jun 2) | Strapi MCP server now GA (Jun 29) **verified** | #26494 register-admin rate limit (critical) |
| Directus | 326 | #27129 (Apr 15) | Jul 10 vuln-disclosure post `[Unverified]` | #27094 outdated openid-client `[Inference]` |
| Payload | 288 | #16288 (Apr 15) | Early look at Payload 4.0 (Jun 9) `[Unverified]` | #16214 MCP plugin null-type `[Inference]` |
| Sanity | 75 | #12870 (May 24) | not fetched `[Unverified]` | #12794 preview secret wrong dataset `[Inference]` |
| Ghost | 63 | #27717 (May 6) | not fetched `[Unverified]` | #27445 upload malware-scan (feature req) |
| KeystoneJS | 100 | #9798 (Apr 3) | not fetched `[Unverified]` | #9789 GraphQL depth-limit `[Inference]` |
| TinaCMS | 378 | #7169 (Jul 7) | not fetched `[Unverified]` | — |
| Decap | 559 | #7875 (Jul 5) | not fetched `[Unverified]` | #7875 path traversal (critical) |
| Builder.io | 62 | #4501 (Apr 4) | not fetched `[Unverified]` | #4501 postMessage RCE (CWE-346) |
| Medusa | 111 | #15406 (May 14) | Layout Composer in Medusa Admin (Jul 1) **verified** | #15360 promo race / #15306 refund `[Inference]` |

**Cross-cutting signals:** Framework-migration friction remains the dominant bug driver — Next.js 16.2 / Turbopack on Payload (#16286, #16288), Node 22/24 on TinaCMS (#7162, #7109) and Builder.io (#4137), React 19 peer-dep conflicts on Medusa (#15398), Next >15.5.13 bump on Keystone (#9798). AI/agent tooling continues to surface across trackers and blogs (Strapi MCP GA + plugin-extension tutorial, Directus MCP #27039, Payload MCP #16214, Medusa MCP/agentic tooling). Two critical, still-open trust-boundary vulns (Decap path traversal #7875, Builder postMessage RCE #4501) remain unresolved.

---

## Strapi
**Open issues:** 396 (verified). Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues

**Newest / notable open issues (verified this run):**
- **#26524** — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled — bug / severity: medium / pending reproduction / v5 — Jun 2, 2026
- **#26494** — no rate limiting on `register-admin` + race condition — **security / Priority: Urgent / severity: critical** / core:admin / v5 — May 30, 2026
- **#26492** — [CI] Nightly release workflow publishes to npm without running any tests — bug / severity: high / tooling — May 30, 2026
- **#26490** — [CI] `docker-compose.test.yml` missing healthchecks on postgres/mysql services — bug / tooling — May 30, 2026
- **#26487** — Hard refresh / direct access of collections list URL gives 500 — bug / severity: high / core:admin / v5 — May 29, 2026
- **#26468** — Wildcard characters in filters not escaped → incorrect literal matching — bug / severity: medium / core:database / v5 — May 28, 2026
- **#26463** — Community plugin `@strapi-community/plugin-seo` archived — marketplace policy + Strapi 5 panel API migration — discussion / marketplace — May 27, 2026
- **#26434** — Content Manager "Cannot read properties of undefined (reading 'attributes')" navigating Single Types — bug / Urgent / critical / core:content-manager / v5 — May 26, 2026

**Blog (verified this run):** Latest post *"The Strapi MCP server is now GA: a stable surface to wire agents to your content"* — Marco Autiero, Jun 29, 2026 (Product, 8 min). Recent supporting posts: *June Community Call Recap* (Jun 29), *Release roundup: everything that changed March→June 2026* (Jun 18), *How to Extend Strapi's MCP Server with Custom Tools via a Plugin* (Jun 13), *Security Disclosure of Vulnerabilities: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886* (May 13).

---

## Directus
**Open issues:** 326 (verified). Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues

**Newest / notable open issues (verified this run):**
- **#27129** — Back button broken for all item pages — Needs Info — Apr 15, 2026
- **#27124** — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` permission — Needs Info — Apr 15, 2026
- **#27119** — Unable to register API extension hook because `document` is not defined — Bug / Ext SDK / Extensions — Apr 15, 2026
- **#27111** — Apple OAuth first_name/last_name not populated on registration — Apr 14, 2026
- **#27094** — `@directus/api` using an old version of tsdown and **openid-client** — Apr 11, 2026 `[Inference: security-relevant dependency]`
- **#27091** — "Save as copy" throws error — Bug / Assets-Files / High Impact / Regression / Studio — Apr 10, 2026
- **#27039** — [MCP] files tool update action fails — data schema typed as array but API expects object — AI/MCP / Bug / Engine / High Impact — Apr 3, 2026

**Blog:** `[Unverified]` — carried forward: Jul 10 vulnerability-disclosure post. Not re-fetched this run.

---

## Payload
**Open issues:** 288 (verified). Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues

**Newest / notable open issues (verified this run):**
- **#16288** — `suppressHydrationWarning` doesn't work after Next upgrade to 16.2.* — area: core — Apr 15, 2026
- **#16287** — Bulk upload into folder-enabled upload collection doesn't set the folder — area: ui — Apr 15, 2026
- **#16286** — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack — plugin: multi-tenant — Apr 15, 2026
- **#16283** — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres — db: postgres — Apr 15, 2026
- **#16273** — Malfunctioning lexical rich-text editing in custom block drawer — richtext-lexical — Apr 14, 2026
- **#16256** — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) — Apr 12, 2026
- **#16214** — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields — plugin: mcp — Apr 8, 2026 `[Inference: agent-tooling correctness]`

**Blog:** `[Unverified]` — carried forward: "Early look at Payload 4.0" (Jun 9). Not re-fetched this run.

---

## Sanity
**Open issues:** 75 (verified). Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues

**Newest / notable open issues (verified this run):**
- **#12870** — [BUG] Image upload silently stalls when file has no extension — no error shown — May 24, 2026
- **#12869** — Tests Dashboard & auto-balancing Playwright shards — May 23, 2026
- **#12835** — [BUG] Unable to revert to default ordering/layout after manual selection — May 17, 2026
- **#12834** — Feature request: include document language/field values in edit-intent params for `canHandleIntent` routing — Feature — May 15, 2026
- **#12812** — Feature request: preserve original image metadata / add IPTC metadata on upload — CLDX / Feature — May 10, 2026
- **#12794** — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio — SAPP — Apr 16, 2026 `[Inference: cross-dataset secret leakage]`
- **#12733** — Cannot create new account on sign-up page; "Password is too weak" for a strong password — identity / Bug — Apr 22, 2026

**Blog:** `[Unverified]` — not fetched this run.

---

## Ghost
**Open issues:** 63 (verified). Blog: https://ghost.org/resources/ · Issues: https://github.com/TryGhost/Ghost/issues

**Newest / notable open issues (verified this run):**
- **#27717** — Document HelmForge chart as a third-party Kubernetes installation option — needs:triage — May 6, 2026
- **#27551** — Signup Card email input placeholder hardcoded ("Your email"), no i18n/per-card override — needs:triage — Apr 25, 2026
- **#27478** — [Feature] Set excerpt length to 2000 characters — needs:triage — Apr 21, 2026
- **#27445** — Security: add optional malware scanning for uploaded files (pompelmi) — needs:triage — Apr 17, 2026 (feature request)
- **#27415** — Share button doesn't work because `portal.min.js` isn't loaded when subscriptions disabled — needs:triage — Apr 15, 2026
- **#26677** — Admin API always saves revisions even when `save_revision=false` — needs:triage — Mar 3, 2026

**Pinned:** 🔥 Breaking Changes for 6.0 (#23924) · 🌐 i18n mega-issue (#23361).

**Blog:** `[Unverified]` — not fetched this run.

---

## KeystoneJS
**Open issues:** 100 (verified). Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues

**Newest / notable open issues (verified this run):**
- **#9798** — Bump Next to >15.5.13 — dependencies — Apr 3, 2026
- **#9789** — Should Keystone enforce GraphQL query-depth limits by default? — Feature — Mar 18, 2026 `[Inference: DoS-hardening]`
- **#9785** — `statelessSessions` attempts to use unsupported `Authorization: Basic` header rather than the cookie — discussion / docs / help wanted — Mar 6, 2026
- **#9779** — `npm run dev` fails with EPERM error on Windows — Feb 20, 2026
- **#9772** — "ID!" used in position expecting type "IDFilter" when loading single entity — Feb 3, 2026
- **#9665** — Field can be editable when `graphql.omit.update` is set — Bug / help wanted — Jul 22, 2025

**Blog:** `[Unverified]` — not fetched this run.

---

## TinaCMS
**Open issues:** 378 (verified). Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues

**Newest / notable open issues (verified this run):**
- **#7169** — ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown — enhancement / rich-text — Jul 7, 2026
- **#7162** — Starter template 'basic' failed during install with yarn using Node 22 — bug — Jul 6, 2026
- **#7148** — Folder-based collection with `create:false + delete:false` is unnavigable — bug / pending triage — Jul 4, 2026
- **#7134** — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding 1MB preview-overlay cap — Jul 1, 2026
- **#7116** — Save button stays enabled after successful save until clicked again — bug / v4 — Jun 30, 2026
- **#7109** — Starter 'tina-astro-starter' failed during build with npm using Node 24 — bug — Jun 28, 2026
- **#7092** — ✨ Plugin System — Auth Plugin — better-auth — technical-debt / v4 — Jun 23, 2026

**Blog:** `[Unverified]` — not fetched this run.

---

## Decap CMS
**Open issues:** 559 (verified). Blog: https://decapcms.org/blog/ · Issues: https://github.com/decaporg/decap-cms/issues

**Newest / notable open issues (verified this run):**
- **#7875** — **Path traversal in decap-server proxy** allows read/write/delete of files outside configured repo root — type: bug — Jul 5, 2026 **(critical trust-boundary)**
- **#7873** — Images not rendered in preview starting from Decap CMS v3.13.0 — type: bug — Jun 29, 2026
- **#7871** — TypeError: Cannot read properties of undefined (reading 'path') — Jun 29, 2026
- **#7869 / #7868** — TypeError: Cannot destructure property 'url' of 'e.element.data' as undefined — Jun 28, 2026
- **#7867** — Impossible to login with Forgejo — missing secret — type: bug — Jun 25, 2026
- **#7823** — Support open authoring for GitLab — type: feature — May 21, 2026

**Blog:** `[Unverified]` — not fetched this run.

---

## Builder.io
**Open issues:** 62 (verified). Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues

**Newest / notable open issues (verified this run):**
- **#4501** — **Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346)** — Apr 4, 2026 **(critical)**
- **#4220** — Add validation to prevent duplicate component names during registration — Jan 8, 2026
- **#4212** — Using `eval` for detecting server code throws CSP error — Dec 15, 2025
- **#4191** — EnableEditor state merging breaks reactivity of blocks in Qwik — Nov 25, 2025
- **#4137** — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements — Aug 30, 2025
- **#4164** — Storybook 10 support — Oct 20, 2025

**Blog:** `[Unverified]` — not fetched this run.

---

## Medusa
**Open issues:** 111 (verified). Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues

**Newest / notable open issues (verified this run):**
- **#15406** — Local dev setup for contributors is confusing, undocumented, lacks hot reload for plugins — type: docs — May 14, 2026
- **#15399** — [Bug] `/store/products` returns 500 for any category_id/tag_id filter when `index_engine` flag enabled — needs triaging / v2.0 — May 14, 2026
- **#15398** — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) — ERESOLVE in npm workspaces — requires-team / bug — May 13, 2026
- **#15360** — [Bug] Race condition in cart promotions can create duplicate line-item adjustments — requires-team / bug / v2.0 — May 11, 2026 `[Inference: data-integrity]`
- **#15306** — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) — needs triaging / bug — May 6, 2026 `[Inference: financial-integrity]`
- **#15321** — `db:sync-links` generates invalid PostgreSQL schema-qualified `RENAME TO` — help-wanted / bug — May 7, 2026

**Blog (verified this run):** Latest post *"Announcing new Layout Composer in Medusa Admin"* — Nicolas Gorga, Jul 1, 2026 (Product).

---

## Method & caveats
- GitHub issue lists render server-side and were fetched live for all 10 repos this run; counts and newest-issue metadata are quoted from the fetched pages.
- Strapi and Medusa blogs returned real (non-shell) content this run and are marked **verified**; the other 8 blogs were not re-fetched and their latest-post lines are carried forward as `[Unverified]`.
- `[Inference]` marks a security read derived from an issue's title/topic, not a confirmed advisory or CVE. Confirmed CVEs appear only where a vendor page lists them (this run: Strapi's May 13 disclosure post).
- No write actions were taken; this is a read-only report per the scheduled-task contract.
