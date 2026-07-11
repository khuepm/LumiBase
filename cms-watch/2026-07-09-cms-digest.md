# Headless CMS Daily Digest — 2026-07-09

> Scheduled watch over 10 popular headless CMS projects. Signals drawn from each project's public **release notes / changelog / blog** and, via **WebSearch snippets**, their **GitHub open-issue trackers**. Direct `web_fetch` of GitHub `/issues` HTML and `api.github.com` **remained blocked this run** (`net::ERR_FAILED` / not in provenance), so issue-level items (#numbers, opened dates) come from search results and are labeled **[Unverified]** — treat them as leads, not confirmed tracker state.
>
> _This file supersedes the earlier 2026-07-09 passes (01:45, ~02:xx, 03:04, ~04:04, ~05:0x, ~06:0x, ~07:5x). This **~08:0x pass** surfaces one genuinely significant correction: **Directus shipped a major version — v12 — in May 2026 with a license change (BSL → MSCL)**, which every prior pass missed (they tracked Directus at v11.17.x). Otherwise the day's release/CVE picture is stable — no new versions or CVEs across the other 9 projects. Also corrected: the **Ghost 6.19.1 patch date is ~Feb 19, 2026** per NVD/SentinelOne (prior pass said ~Feb 16). Data-source blocker unchanged (see below)._
>
> **Legend:** 🐛 bug/fix · ✨ feature/enhancement · 🔒 security · 📝 docs · 🧰 tooling/CI · 🤖 AI/MCP · ⚠️ upgrade caution

---

## Summary of the day

- **🔒 Two critical, time-sensitive CVEs are the headline.**
  - **Ghost — CVE-2026-26980 (CVSS 9.4, actively exploited):** unauthenticated blind SQL injection in the Content API via `filter=slug:` / `order=slug:` (ORDER BY). Affects ~3.24.0–6.19.0; **patched in 6.19.1**. Reported as exploited in the wild — **700+ sites hijacked** for ClickFix malware, victims reportedly including **DuckDuckGo, Harvard, and Oxford**; public PoCs exist. Anyone below 6.19.1 should upgrade urgently.
  - **Strapi — May 13, 2026 disclosure (five CVEs):** **CVE-2026-22599** (CVSS 9.3, SQLi in Content-Type Builder via `column.defaultTo` → Knex `raw()`) and **CVE-2026-27886** (CVSS 9.3, sensitive-data exposure via unsanitized relational filtering), plus **CVE-2025-64526**, **CVE-2026-22706** (password-reset not revoking refresh sessions), **CVE-2026-22707** (Upload MIME-validation bypass). Fixed across **v5.33.2 / v5.37.0+** (and v4.26.1+).
- **🤖 AI / MCP remains the competitive front line.** Strapi's built-in **MCP server is GA (v5.49.0, Jun 24)**; Directus's **AI Assistant is multimodal** (images + PDFs across OpenAI/Anthropic/Gemini); Payload 4.0's direction leads with MCP + TanStack + admin redesign; Builder.io has pivoted to the agentic **Builder 2.0** ("collaborative coding with Claude/Codex/Gemini").
- **🆕 Fresh releases this week:** **Sanity Studio v6.4.0** (Jul 7), **Ghost email-sequences** feature (Jul 6), **TinaCMS** breadcrumb/date-fns + edge-cache work (early Jul), **Medusa v2.17.1**.
- **⚖️ Directus v12 (May 2026) is a license event, not just a version.** The switch from **BSL → MSCL** (source-available, GPLv3 after 4 years) plus **software keys** and a free **Innovation Grant** (under $5M revenue AND 50 employees) means teams above those thresholds must review terms and obtain a key on upgrade.
- **⚠️ Upgrade caution:** **Medusa v2.17.0** has a worker-instance regression — go straight to **v2.17.1**.

### Changes since last run (~07:5x pass → this ~08:0x pass)
- 🆕⚠️🔒 **Directus — v12 shipped May 2026 with a LICENSE CHANGE (corrects a standing miss).** Every prior pass tracked Directus at v11.17.x; a fresh search surfaced that **Directus v12 launched in May 2026** and replaced the **Business Source License (BSL)** with the **Monospace Sustainable Core License (MSCL)** — a source-available license derived from the Fair Core License (FCL), split into two parts: **MSCL** (governs use/distribution) + an **Innovation Grant** (governs who uses it free). Free tier: **individuals/orgs under $5M annual revenue AND 50 employees** use the platform free via the Innovation Grant; **every version auto-converts to GPLv3 after 4 years**. Directus now issues **software keys**; existing customers can upgrade to v12 immediately and enter a **30-day grace period** (prompt to contact `licensing@directus.io`). This is vendor-confirmed (directus.com/resources) — treat as **confirmed**, not a lead. Action for adopters above the free thresholds: review the MSCL/Innovation-Grant terms before upgrading.
- 🔒📅 **Ghost — patch-date correction.** The **6.19.1** fix for **CVE-2026-26980** is dated **~Feb 19, 2026** per NVD / SentinelOne (prior pass estimated ~Feb 16). Guidance unchanged: patch to **≥6.19.1**.
- ✅ **No new releases or CVEs otherwise:** Strapi **v5.50.0** (Jul 2) still latest — no v5.51; Payload **v3.85.2** still latest — no v3.86; Sanity Studio **v6.4.0** (Jul 7); Medusa **v2.17.1**; Keystone **v6.5.2**; Decap **v3.14.1**. No v3.86 / v5.51 / v2.18 surfaced.
- ⚠️ **Data-source status unchanged:** `api.github.com` still returns **"URL not in provenance,"** GitHub `/issues` HTML + CMS blog pages remain unfetchable; release facts and issue IDs remain **WebSearch-derived**, issue-level leads stay **[Unverified]**.

### Changes since last run (~06:0x pass → ~07:5x pass)
- 🔒➕ **TinaCMS** — added detail: the July release also includes **security hardening** — hardened **cross-window `postMessage` handling** and **rich-text URL sanitization** (alongside the already-logged edge-cache skip, date-fns migration, and breadcrumb/global-collection UX work). No version bump beyond the ~Jul-1 `@tinacms/search@1.2.21` line.
- 🔒📅 **Ghost** — added detail: the **6.19.1** fix for **CVE-2026-26980** is dated **~Feb 16, 2026** per NVD / vendor advisories (the mass-exploitation campaign was first detected ~May 7, 2026). Guidance unchanged: patch to **≥6.19.1**.
- ✅ **No new releases or CVEs otherwise:** Strapi **v5.50.0** (Jul 2) still latest — no v5.51; Payload **v3.85.2** (npm) still latest — no v3.86; Sanity Studio **v6.4.0** (Jul 7); Directus **v11.17.x**; Medusa **v2.17.1**; Keystone **v6.5.2**; Decap **v3.14.1**. No v11.18 / v2.18 / v3.86 surfaced.
- ⚠️ **Data-source status unchanged:** `api.github.com` still returns **"URL not in provenance,"** GitHub `/issues` HTML returns **`net::ERR_FAILED`**, and the CMS blog pages remain unfetchable. Release facts and issue IDs remain **WebSearch-derived**; issue-level leads stay **[Unverified]**.

### Changes since last run (~05:0x pass → ~06:0x pass)
- ✅🆕 **Decap — v3.14.1 CONFIRMED** (resolves the prior [Unverified] lead). It is the current **latest on npm** (published ~mid-Jun 2026). Contents: **Slovak locale** added; **"New entry" button label unified** to `＋ %{collectionLabel}` across locales; **GitLab** fixes — use Bearer auth scheme for GraphQL requests + refresh expired PKCE access tokens; `shell-quote` bumped 1.8.3→1.8.4; dead-code cleanup. So the line is now **v3.14.1**, ahead of the v3.12.x logged earlier.
- 🆕 **Payload — v3.85.2 confirmed on npm** (~Jul 1, published "7 days ago"), one patch ahead of the v3.85.1 baseline. Release body/notes still not exposed in feeds; the separate **Jul-7** release reference remains **[Unverified]** (date only, no contents).
- 🐛➕ **Strapi** — added detail: **v5.50.0** includes a fix to **prevent a dynamic-zone crash when the value is null (#26816)**. New open-issue lead **#26916** (bug, core admin, opened Jul 6, pending reproduction) joins #26917/#26918 from the same day.
- ✅ **No new releases or CVEs otherwise:** Strapi v5.50.0 (Jul 2) still latest (no v5.51); Sanity Studio v6.4.0 (Jul 7); Ghost email-sequences (Jul 6) + CVE-2026-26980 picture unchanged (patch ≥6.19.1); Directus v11.17.2; Medusa v2.17.1; Keystone v6.5.2. No v11.18 / v2.18 surfaced.
- ⚠️ **Data-source status unchanged:** direct `web_fetch` of the CMS blogs (`net::ERR_FAILED`) and GitHub `/issues` HTML / `api.github.com` ("not in provenance") all failed again; release facts and issue IDs remain **WebSearch-derived**.

### Changes (~04:04 pass → ~05:0x pass)
- 🆕✨ **Directus** — the **v11.17.0** feature set is now surfaced (baseline had only the v11.17.2 patch + v11.16 features): **Background Imports** (kick off an import and keep working; auto-timeout after 1h, max 20 concurrent — both configurable via `IMPORT_TIMEOUT` / `IMPORT_MAX_CONCURRENCY`); **Netlify** support in the deployment module (connect account, pick sites, publish from Data Studio); a **translations generator** (~10s vs the old 10–15 min); a native **Tabs** interface. ⚠️ **Breaking:** the Data Studio UI was shrunk to **90%** of its previous size (px → rem); extensions with hardcoded px values may render incorrectly.
- ✨ **TinaCMS** — added detail: the July line also **skips the filesystem response cache on edge runtimes** (Cloudflare Workers, Vercel Edge, where Node `fs` exists but is unusable) and adds a `cache` option to `createClient` to force-disable caching.
- 🆕 **Decap** — GitHub release list now hints at a **v3.14.x** tag (search surfaced `decap-cms@3.14.1`) newer than the v3.12.x logged in the ~04:04 pass. **[Unverified]** — search also still returns v3.11.0 as "latest," so treat as a lead until the tag/date is confirmed.
- ✅ **No new releases or CVEs** otherwise: Strapi v5.50.0 (Jul 2) remains latest (no v5.51); Sanity Studio v6.4.0 (Jul 7); Ghost email-sequences (Jul 6); Medusa v2.17.1. Payload's Jul-7 release body is **still not exposed** (search confirms the date, not the contents).
- ⚠️ **Data-source status unchanged:** direct `web_fetch` of GitHub `/issues` HTML, `api.github.com`, and even the Directus/Payload blog pages all failed again (`net::ERR_FAILED` / not in provenance); release facts and issue IDs remain **search-derived**.

### Changes (03:04 pass → ~04:04 pass)
- 🆕 **Decap** — corrected: the **Plate-based richtext widget shipped in v3.12.0** (drop-in for the deprecated markdown widget, flagged **beta**); **v3.12.1** added `decap-cms-widget-richtext` as a dep; **v3.12.2** let special characters pass through slugification + added `mdast-util-to-string`. Prior pass listed v3.11.0 as latest and the richtext widget as an unshipped ~April beta.
- 🔒♻️ **Strapi** — the security-disclosure post now enumerates the **full five-CVE cluster**: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706 (password-reset sessions), CVE-2026-22707 (Upload MIME bypass), CVE-2026-27886.
- 🔒♻️ **Ghost** — CVE-2026-26980 press now **names high-profile victims** (DuckDuckGo, Harvard, Oxford) among the 700+ compromised sites; guidance unchanged (patch to ≥6.19.1).
- ✅ **No new releases** beyond those already logged (Strapi v5.50.0, Sanity v6.4.0, Payload Jul-7 release body still not exposed, Directus v11.17.2, Medusa v2.17.1). Keystone/Builder/Decap cadence unchanged.
- ⚠️ **Data-source status unchanged:** GitHub `/issues` HTML and `api.github.com` fetches failed again (`net::ERR_FAILED` / not in provenance); issue IDs below remain search-derived leads.

---

## 1. Strapi — `strapi/strapi`

**Releases / blog:**
- 🤖 **v5.49.0** (Jun 24, 2026) — built-in **MCP server reached GA**; `defineTool`/`defineResource`/`definePrompt` builder exports; `initiallySelectedAssets` support.
- ✨ **v5.48.1** (Jun 17) — Billing Portal link; upsell banner points to Strapi Billing.
- ✨🐛 **v5.48.0** (Jun 10) — optional OpenAPI spec route with config-gated endpoint access; fix for upload returning unsigned URLs on media-info update.
- ✨ **v5.47.0** — `publicationFilter` query param (cohort modes across REST, Document Service, GraphQL, incl. nested populate); MCP server first landed here.
- ✨🐛 **v5.50.0** (Jul 2) — active device-session management in admin; security defaults in `create-strapi-app` templates; exported DB lifecycle event type; **fix: prevent dynamic-zone crash when value is null (#26816)**.

**🔒 Security (disclosed May 13, 2026) — upgrade if below v5.37.0:**
- **CVE-2026-22599** (Critical, CVSS 9.3) — SQL injection in Content-Type Builder via `column.defaultTo` → Knex `raw()`. Patched **v5.33.2 / v4.26.1+**.
- **CVE-2026-27886** (Critical, CVSS 9.3) — sensitive-data exposure via unsanitized relational filtering (boolean-oracle on `admin_users`). Patched **v5.37.0+**.
- **CVE-2026-22706** — password reset does not revoke existing refresh sessions.
- **CVE-2026-22707** — Upload-plugin MIME-validation bypass.
- **CVE-2025-64526** — fifth ID in the same disclosure bundle (plus a rate-limit bypass).

**Open-issue leads [Unverified — search-derived]:** #26917 (bug, opened Jul 6, pending repro), #26916 (bug, core admin, Jul 6, pending repro), #26918 (bug, low, Jul 6), #24994 (admin/API slowdown after ~2 days uptime), #20651 (server shuts down), #24240 (notice: end of Strapi 4 bug fixes).

_Sources: GitHub release tags v5.48–v5.49; Strapi Mar–Jun 2026 release roundup; Strapi security disclosure post; GHSA-rjg2-95x7-8qmx._

## 2. Directus — `directus/directus`

**Releases / blog:**
- 🆕⚠️🔒 **v12 (launched May 2026) — MAJOR version + LICENSE CHANGE.** Directus replaced the **Business Source License (BSL)** with the **Monospace Sustainable Core License (MSCL)**, a source-available license derived from the Fair Core License (FCL). The model splits into **MSCL** (governs how the software is used/distributed) + a separate **Innovation Grant** (governs who uses it free). Free tier: **individuals and organizations under $5M annual revenue AND 50 employees** use the platform completely free via the Innovation Grant; above those thresholds you can still build within Core-tier limits. **Every version auto-converts to GPLv3 after 4 years.** Directus introduced **software keys** and separated usage policy from license: existing customers can upgrade to v12 immediately without a key, then get a **30-day grace period** (prompt to contact `licensing@directus.io`). **Confirmed** (directus.com/resources). ⚠️ Adopters above the free thresholds should review MSCL + Innovation-Grant terms before upgrading. _(Prior passes tracked Directus at v11.17.x and missed this — corrected here.)_
- 🐛 **v11.17.2** (Apr 6, 2026) — fixes: datetime-with-timezone display; data export excluding alias fields; relational field removals within groups for draft items.
- ✨⚠️ **v11.17.0** — **Background Imports** (start an import and keep working; auto-timeout after 1 hour, max 20 concurrent — both configurable via `IMPORT_TIMEOUT` / `IMPORT_MAX_CONCURRENCY`); **Netlify** support in the deployment module (connect account → pick sites → publish from Data Studio); **translations generator** (scaffolds full translation setup in ~10s vs 10–15 min); native **Tabs** interface. **Breaking:** Data Studio UI shrunk to **90%** of prior size (sizing px → rem) — extensions with hardcoded px may render incorrectly.
- ✨🤖 **v11.16.0** — **Global Draft Versions** (auto-draft per versioned item; stage → preview → promote); **multimodal AI Assistant** (images + PDFs across OpenAI/Anthropic/Gemini) + "Ask User" clarification tool; role-based deployments; `json()` extractor.
- ✨ **v11.15 / v11.13** — Collaborative Editing native; AI Assistant GA; native MCP endpoint out of beta.

**Open-issue leads [Unverified]:** #27832 (engine bug, Jul 2), #27830 (data-modeling bug, Jul 2), #27794 (assets/files bug, Jun 28), #27679 (custom dropdown in `directus_files` missing options editor, Jun 4), #27026 (missing types for `@directus/api`, Apr 2), #26877 (TUS uploads require update perm on `directus_files`, Mar 11).

**Security:** none surfaced this run. [Unverified]

_Sources: directus.com/resources/directus-v12-license-change; directus.io/bsl-faq; directus.com/docs/licensing/overview; GitHub directus/directus releases; directus.io/blog._

## 3. Payload CMS — `payloadcms/payload`

**Releases / blog:**
- 🐛 **v3.85.2** (~Jul 1, 2026, per npm) — latest published tag; patch above v3.85.1 (release body not exposed in feeds).
- 🐛 **v3.85.1** (Jun 9, 2026) — fixes incl. draft save/duplicate on upload collections, bin script `type:module`, CSS export types for TS6, upload MIME redirect handling, import/export nesting, tabs-field visibility with `admin.condition`.
- ✨ **v3.85.0** (May 26) — `@payloadcms/plugin-import-export` **GA**: locale-aware CSV/JSON bulk export/import + hooks.
- 🐣 **v4.0** — pre-alpha/beta; admin-UI redesign, DAM, AI/MCP workflows, Tailwind + TanStack. Team warns against production use of `main`.
- ❓ A release referenced **Jul 7, 2026** but the body was not exposed in feeds. [Unverified]

**Open-issue leads [Unverified]:** #17167 (Jul 1, needs-triage), #17164 (Jul 1), #17142 (Jun 29), #15828 (localized+required text field fails on create API), #15180 (Next.js Server Actions crash in prod), #15429 (config returns null in prod build, Next 16 + Turbopack RSC). Regression noted in **v3.83.0** — custom admin views at `/foo` shadow `/foo/:id` detail routes.

**Security:** none surfaced this run. [Unverified]

_Sources: payloadcms.com/posts/releases; GitHub release tags v3.85.0/v3.85.1._

## 4. Sanity — `sanity-io/sanity`

**Releases / blog (Studio v6 series):**
- ✨🐛 **v6.4.0** (Jul 7, 2026) — org-scoped user attributes; **request-error-handling overhaul** ("Try again" dialog instead of Studio crash on dropped connection/rate limit); fixes for copying references, review-change connectors, Safari.
- **v6.2.0** (Jun 24) — released; notes [Unverified].
- ✨🐛 **v6.1.0** (Jun 16) — content-release validation errors jump to offending field; geopoint config + Portable Text block editing fixes.
- ✨⚠️ **v6.0.0** (~Jun 9–11, exact date [Unverified]) — **breaking**: Vite 8 build (2–9× faster, ~4.8× median); default search `groqLegacy` → `groq2024` (wildcards/phrases/negation); React strict mode on by default in dev; custom auth providers drop `mode` option; **Node.js 20 support removed**.
- 🤖 Content Agent reachable from Dashboard, Slack, API (@-mention).

**Open-issue leads [Unverified]:** open items dated Jun 27 / 26 / 21 / 20 / 2, no confirmable #numbers (tracker blocked). A Presentation/Visual-Editing Portable-Text re-focus bug was recently fixed.

_Sources: sanity.io/blog (Studio v6); sanity.io/docs/changelog; GitHub release v6.4.0._

## 5. Ghost — `TryGhost/Ghost`

**Releases / blog:**
- ✨ **Jul 6, 2026** — automated **email sequences** (multi-step welcome flow spaced over time; replaces single welcome email).
- ✨ **Jun 18** — quick admin access for publication staff users.
- ✨ **Jun 11** — saved member views that stay current automatically.
- (Earlier passes noted v6.51.0 Jul 3: Social Web handle prefs #29042, comped-member + security-history fixes.)

**🔒 Security — critical, act now:**
- **CVE-2026-26980** (Critical, CVSS 9.4, **actively exploited**) — unauthenticated **blind SQL injection** in Content API via `filter=slug:` / `order=slug:` (ORDER BY). Affects ~3.24.0–6.19.0; **patched in 6.19.1 (~Feb 19, 2026** per NVD/SentinelOne). Reported: 700+ sites hijacked for ClickFix malware (first seen ~May 7, 2026); public PoCs on GitHub. Named victims include DuckDuckGo, Harvard, Oxford, Auburn (per XLab/Qianxin).
- **CVE-2026-29053** — RCE via malicious themes (arbitrary JS), reportedly 0.7.2–6.19.0. [Unverified severity]

**Open-issue leads [Unverified]:** #28310 (Jun 2, needs triage), #28264 (May 31), #28222 (May 28), #28155 (May 26), #27433 (migration fails upgrading 6.25.0 → 6.30.0).

_Sources: ghost.org/changelog; The Hacker News & SonicWall CVE-2026-26980 write-ups._

## 6. KeystoneJS — `keystonejs/keystone`

**Releases / blog:**
- 🔒 **@keystone-6/core v6.5.2** (Mar 19, 2026) — latest found; fixes **CVE-2026-33326**: `{field}.isFilterable` access-control bypass in `findMany` via `cursor` param (can confirm record existence by protected field values) (#9790).
- No newer dated release surfaced for Jun–Jul 2026 — cadence remains slow.

**Open-issue leads [Unverified]:** #9768 (bug, Jan 28 — `Cannot read properties of undefined (reading 'slice')` with `@keystone-6/fields-document` following the tutorial). No clear new Jun–Jul 2026 issues surfaced.

_Sources: GitHub keystonejs/keystone releases; keystonejs.com/blog._

## 7. TinaCMS — `tinacms/tinacms`

**Releases / blog:**
- ✨ **`@tinacms/search@1.2.21`** (~Jul 1, 2026) — back-to-collection breadcrumb on admin editor/create + visual-editor sidebar; separator chevron → slash; truncation improvements.
- ✨ **Global collection UX** (Jul) — global collections appear once under "Site" (deduped), open directly in form (no popup); single-doc globals skip list view.
- 🧰 **Date handling** (Jul) — standardized on **date-fns**, removed `moment` stack; non-breaking token converter (~18.6 KB gzip smaller admin bundle).
- 🧰🐛 **Edge cache** (Jul) — skips the filesystem-backed response cache on edge runtimes (Cloudflare Workers, Vercel Edge) where Node `fs` is present but unusable; adds a `cache` option to `createClient` to force-disable caching.
- 🔒 **Security hardening** (Jul) — hardened **cross-window `postMessage` handling** and **rich-text URL sanitization** in the admin/visual-editor surface.
- ✨🐛 **v2.8.1** (Jun 1) — toolbar `headingLevels` override; search whitespace trimming; `notifiySubscribers` → `notifySubscribers`; dropdown-hidden-behind-fields fix; optional-datetime auto-fill fix.
- ☁️ **TinaCloud** (Jun 10 & 16) — JWT claims refactor, new OAuth endpoints, branch-aware media on by default.

**Open-issue leads [Unverified]:** #7118 (bug, Jun 30), #7115 (bug, Jun 29), #6722 (feature — media library file rename).

**⚠️ Caution:** verify custom date formats after the moment → date-fns migration.

_Sources: tina.io/whats-new; GitHub tinacms CHANGELOG._

## 8. Decap CMS — `decaporg/decap-cms`

**Releases / blog:**
- ✨ **v3.12.0** — ships the new **Plate-based rich-text widget** as a **drop-in replacement** for the markdown widget (flagged **beta**; markdown widget now deprecated but still available). This is the current line — supersedes the earlier "v3.11.0 latest / richtext still an April beta" note.
- 🐛 **v3.12.1** — added `decap-cms-widget-richtext` as a package dependency.
- ✨🐛 **v3.12.2** — allow special characters to pass through slugification; added `mdast-util-to-string` to richtext direct deps.
- ✅ **v3.14.1 — CONFIRMED latest** (on npm; ~mid-Jun 2026) — resolves the prior [Unverified] lead. Contents: **Slovak locale** added; **"New entry" button label unified** to `＋ %{collectionLabel}` across locales; **GitLab** — use Bearer auth scheme for GraphQL requests + refresh expired PKCE access tokens; `shell-quote` bumped 1.8.3→1.8.4; dead-code cleanup. (v3.14.0 also on npm just below it.)
- ☁️ **Decap Turbo** (May 2026) — SaaS upgrade for teams (performance, centralized auth, granular permissions).

**Open-issue leads [Unverified]:** #7801 (editor/preview-pane bug, May 2), #7799 (richtext widget bug, May 1), #7781 (image widget bug, Apr 13), #7457 (stuck on old commit / changes not shown).

**⚠️ Caution:** Plate richtext widget is beta; markdown widget deprecated — plan migration, test edge cases.

_Sources: GitHub decaporg/decap-cms releases (v3.12.0–v3.14.1); npm decap-cms; decapcms.org/docs/widgets; decapcms.org/blog._

## 9. Builder.io — `BuilderIO/builder`

**Releases / announcements:**
- 🤖 **Builder 2.0 — "Collaborative Coding with Claude and Codex"** (Apr 12, 2026) — raised $67M; supports Claude/Codex/Gemini; real-time human+agent collaboration ("Google Docs for code," live cursors); start tasks from local branch, Slack, or Jira; hundreds of parallel agents; ships via existing CI/CD. Related product line: **Fusion**.
- ⚠️ **No verifiable Jun–Jul 2026 changelog entry** surfaced this run. **[Unverified]** — product focus has shifted from the OSS repo to the agentic platform.

**Open-issue leads [Unverified]:** #4501 (Apr 4), #4220 (Jan 8), #4219 (Dec 19 2025) — labels unconfirmed; OSS repo appears less active.

_Sources: builder.io/blog/builder-2-0; builder.io/updates (not readable)._

## 10. Medusa — `medusajs/medusa` (e-commerce)

**Releases / blog:**
- ⚠️ **v2.17.1** — current recommended patch. **v2.17.0 has a worker-instance regression — skip it, go to 2.17.1.**
- ✨ **Global Product Options** (preview) — options ("Size"/"Color") defined once at store level, reusable across products; new DB relationships + `is_exclusive` field. Reduces duplication for large catalogs (schema change — review migration).
- Historical: v2.16.0 prior release; **Medusa 2.0 shipped Oct 2024** (not 2026) — the line is well into 2.17.x.

**Open-issue leads [Unverified]:** #15945 (bug, good first issue, Jul 6), #15940 (bug+docs, Jul 5), #15938 (Jul 4), #15927 (Jul 2), #15921 (needs triaging, Jul 2), #15911 (Jul 1), #15513 (admin orders page), #15300 (`medusa db:migrate` exit code), #14637 (linking Google OAuth to existing email/password customers).

_Sources: medusajs.com/changelog; medusajs.com/blog (Global Product Options); docs.medusajs.com/learn/update._

---

## Method & caveats

- **What worked:** `WebSearch` across each project's release/changelog/blog surfaces and security advisories. Release-level facts are attributed to version tags and dates where search results stated them.
- **What was blocked this run:** every `web_fetch` of GitHub `/issues` HTML and `api.github.com` returned `net::ERR_FAILED` / "not in provenance." **Open-issue #numbers and opened-dates are therefore search-derived leads, labeled [Unverified]** — they may lag or misstate the live tracker.
- **Verification standard:** CVE items cite public advisories/press; where a project had no verifiable Jul-2026 signal (Builder.io OSS repo), it is labeled [Unverified] rather than guessed.
- **Suggested fix for future runs:** allow-list `api.github.com` (JSON, JS-free) for this watch task, or pre-populate the specific `/issues` URLs so they enter the fetch provenance set — that would let issue-level bug/feature tracking be confirmed directly instead of via search.

<!-- next-run hint (as of ~08:0x pass): release/CVE picture stable across 8 passes; no new versions or CVEs. Latest tags confirmed: Strapi v5.50.0, Payload v3.85.2, Sanity v6.4.0, Medusa v2.17.1, Keystone v6.5.2, Decap v3.14.1. CORRECTION this pass: Directus is on v12 (launched May 2026, license BSL→MSCL, GPLv3-after-4-years, software keys, Innovation Grant free tier <$5M rev & <50 employees) — prior passes wrongly tracked v11.17.x; do NOT revert. Also corrected: Ghost 6.19.1 patch dated ~Feb 19 2026 (was ~Feb 16). Still open: (1) Payload Jul-7 release body — date only, contents not exposed; (2) any Directus v12.x point release / Medusa v2.18 / Payload v3.86 / Strapi v5.51; (3) confirm Directus v12 exact minor + whether v11.17.x is still maintained. Watch the Aug-1 Builder.io platform update flagged in search. Data-source blocker persists: web_fetch of CMS blogs returns net::ERR_FAILED and GitHub /issues HTML + api.github.com are not-in-provenance; WebSearch remains the effective source. Allow-listing api.github.com (JSON, JS-free) would let issue leads be confirmed directly. -->
