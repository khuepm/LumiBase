# Headless CMS Daily Digest — 2026-07-10

> Scheduled watch over 10 popular headless CMS projects. Signals drawn from each project's **GitHub open-issue tracker** (fetched directly this run) plus **WebSearch** for release/CVE context.
>
> **Data-source change this run (important):** For the first time, direct `web_fetch` of each project's GitHub `/issues` HTML **succeeded** — so issue-level items below (#numbers, titles, labels, opened dates, authors) are **confirmed from the tracker**, not search-derived leads as in prior passes. Two caveats: (1) `web_fetch` served **cached page snapshots of varying freshness** — the newest visible issue per repo ranges from ~Apr to ~Jul (see each section); treat "newest issue" as "newest in the cached snapshot," not necessarily as of today. (2) `api.github.com` and any `/issues?q=…sort=…` URL with query params still return **"URL not in provenance"**, so only the plain tracker URL from the source list is fetchable, and it uses GitHub's default sort.
>
> **Legend:** 🐛 bug/fix · ✨ feature/enhancement · 🔒 security · 📝 docs · 🧰 tooling/CI · 🤖 AI/MCP · ⚠️ upgrade caution

---

## Summary of the day

- **🔒 New CVE surfaced: Ghost CVE-2026-29053 (RCE via malicious themes).** Separate from the already-tracked SQLi CVE-2026-26980, this is a **remote code execution** flaw letting attackers run arbitrary JavaScript on a Ghost instance via a crafted/malicious theme that an admin is convinced to install. Affects ~0.7.2–6.19.0; **patched in 6.19.1** (same fix release as CVE-2026-26980). Guidance is unchanged and reinforced: **get to ≥6.19.1**. _(Search-derived — SentinelOne / public advisory.)_
- **✅ Issue trackers now directly readable.** Every prior digest labeled issue IDs `[Unverified]` because GitHub was unfetchable. This run they're confirmed from the tracker HTML. Highlights below include several **security-flavored open issues**: Strapi **#26494** (no rate-limit on `register-admin` + race condition, marked Priority: Urgent / critical), Decap **#7875** (path traversal in `decap-server` proxy), and Builder **#4501** (cross-origin code execution via unvalidated `postMessage`, CWE-346).
- **🤖 AI/MCP friction shows up in trackers.** Directus **#27039** ([MCP] files-tool update action fails — schema typed as array but API expects object) and Payload **#16214** ([MCP Plugin] create/update tools emit `{ type: 'null' }` for nullable relationship fields) are both open MCP-integration bugs — the MCP surface each project shipped is now generating real bug reports.
- **🆕 Release picture stable vs yesterday.** No new headline version bumps surfaced today: Strapi still ~v5.50.0, Payload ~v3.85.2, Sanity Studio ~v6.4.0, Medusa ~v2.17.1, Keystone ~v6.5.2, Decap ~v3.14.1, Directus v12 (May 2026, MSCL license). TinaCMS remains on the ~4.x line with active rich-text/CLI work (see #7169, #7075).

### Changes since last run (2026-07-09 → 2026-07-10)
- 🔒🆕 **Ghost — second CVE added: CVE-2026-29053 (RCE via malicious themes), patched 6.19.1.** Prior digests tracked only the SQLi CVE-2026-26980 in the same patch. Both are resolved by upgrading to **≥6.19.1**. _(Search-derived; SentinelOne vulnerability DB + GitHub PoC repo.)_
- ✅⬆️ **Source-quality upgrade: GitHub issues moved from `[Unverified]` (search snippets) to confirmed (direct tracker fetch)** for all 10 repos. The per-project sections below now list real open issues with IDs, labels, authors and opened-dates rather than search leads.
- 🐛 **Newly-visible open security/quality issues** (not in prior passes because the tracker wasn't readable): Strapi #26494 (register-admin rate-limit/race), Decap #7875 (path traversal), Builder #4501 (postMessage RCE), Ghost #27445 (feature req: optional upload malware scanning).
- ⚠️ **Freshness caveat is new too:** cached snapshots mean some repos' "newest" issue is weeks old (Directus/Payload snapshot ~Apr 15; Keystone ~Apr 3; Builder ~Apr 4). TinaCMS (~Jul 7) and Decap (~Jul 5) snapshots are current. No new *releases* detected, but absence may partly reflect snapshot age — treat "no release" as "none surfaced," not a guarantee.

---

## 1. Strapi — `strapi/strapi`
_Snapshot freshness: newest visible open issue #26524 opened Jun 2, 2026 (cache ~early June). Open issues: 396._

**Notable open issues (confirmed from tracker):**
- 🔒 **#26494 — No rate limiting on `register-admin` + race condition** (labels: issue: security, **Priority: Urgent**, severity: critical, source: core:admin, v5). Opened May 30 by ThiruselvamD. Highest-signal open item.
- 🐛 **#26434 — Content Manager: "Cannot read properties of undefined (reading 'attributes')" when navigating between Single Types via sidebar** (Priority: Urgent, severity: critical, core:content-manager, v5). May 26.
- 🐛 **#26396 — "Cannot read properties of undefined (reading 'list')"** (Priority: Urgent, critical, core:content-manager, pending reproduction, v5). May 20.
- 🐛 **#26387 — Replace-media updates metadata but asset content stays the original file** (severity: high, core:upload, **status: confirmed**, v5). May 19.
- 🐛 **#26524 — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled** (bug, severity: medium, pending reproduction, v5). Jun 2.
- 🐛 **#26468 — Wildcard characters in filters not escaped → incorrect matching for literal text** (core:database, v5). May 28.
- 🧰 **#26492 / #26490 — CI gaps:** nightly release workflow publishes to npm without running tests (#26492, severity: high); `docker-compose.test.yml` missing healthchecks on postgres/mysql (#26490).
- 🐛 **#26487 — Hard refresh / direct access of collections-list URL → 500 internal server error** (severity: high, core:admin, v5). May 29.

**Release/security context (search-derived, carried):** latest ~v5.50.0 (Jul 2). May 13 disclosure cluster (CVE-2026-22599 SQLi, CVE-2026-27886 data exposure, +3) fixed across v5.33.2 / v5.37.0+. Built-in MCP server GA in v5.49.0.

## 2. Directus — `directus/directus`
_Snapshot freshness: newest visible open issue #27129 opened Apr 15, 2026 (cache ~mid-April). Open issues: 326._

**Notable open issues:**
- 🤖🐛 **#27039 — [MCP] files-tool update action fails:** `data` schema typed as array but the Directus API expects an object (labels: AI/MCP, Bug, Engine, High Impact). Apr 3. Direct MCP-integration defect.
- 🐛 **#27091 — "Save as copy" throws error** (Assets/Files, Bug, High Impact, **Regression**, Studio). Apr 10.
- 🐛 **#27042 — WYSIWYG not rendering when returning from edit then revisiting the record as a non-admin user (v11.16.1)** (Bug, High Impact, UX/DX). Apr 3.
- 🐛 **#27028 — WYSIWYG not accessible in macOS Safari when using a trackpad** (Bug, High Impact, Studio, UX/DX). Apr 2.
- 🐛 **#27003 — Aliased GraphQL relational objects within a fragment return null** (Bug, GraphQL, Regression, ⚠️ Enterprise). Mar 30.
- 🐛 **#27124 — `GET /permissions/me` returns 500 when a non-admin policy has `directus_flows:trigger` permission** (Needs Info). Apr 15.
- 🐛 **#27119 — Cannot register API-extension hook: "document is not defined"** (Ext SDK, Extensions). Apr 15.
- ✨ **#27016 — Unhelpful error on weak-password validation** (Improvement, Studio, UX/DX). Mar 31.

**Release context (search-derived, carried):** Directus **v12** shipped May 2026 with a **license change (BSL → MSCL** + Innovation Grant; free under $5M revenue AND 50 employees; auto-GPLv3 after 4 years). Adopters above thresholds must obtain a software key on upgrade.

## 3. Payload CMS — `payloadcms/payload`
_Snapshot freshness: newest visible open issue #16288 opened Apr 15, 2026 (cache ~mid-April). Open issues: 288._

**Notable open issues:**
- 🤖🐛 **#16214 — [MCP Plugin] create/update tools produce `{ type: 'null' }` for nullable relationship fields** (label: plugin: mcp). Apr 8.
- 🐛 **#16286 — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack.** Apr 15.
- 🐛 **#16288 — `suppressHydrationWarning` doesn't work as intended after Next upgrade to 16.2.\*** (area: core). Apr 15.
- 🐛 **#16283 — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → `invalid input value for enum … ""`** (db: postgres). Apr 15.
- 🐛 **#16256 — `vercelPostgresAdapter` fails on large queries (68KB+ SQL with 30+ lateral joins).** Apr 12.
- 🐛 **#16273 / #16262 — Lexical rich-text:** malfunctioning editing in custom block drawer (#16273); `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported (#16262).
- 🐛 **#16287 — Bulk upload into a Folder-enabled upload collection doesn't set the folder** (area: ui). Apr 15.
- ✨ **#16250 — Dashboard widgets:** unconditional default `collections` widget blocks customization; `Widget` type omits `imageURL` the UI supports. Apr 11.

**Release context (search-derived, carried):** latest ~v3.85.2. Payload 4.0 direction leads with MCP + TanStack + admin redesign.

## 4. Sanity — `sanity-io/sanity`
_Snapshot freshness: newest visible open issue #12870 opened May 24, 2026 (cache ~late May). Open issues: 75._

**Notable open issues:**
- 🐛 **#12870 — [BUG] Image upload silently stalls when the file has no extension — no error shown to user.** May 24.
- 🐛 **#12733 — Cannot create a new account on the sign-up page: server returns "Password is too weak" for a strong password** (label: identity, type: Bug). Apr 22.
- 🐛 **#12794 — Presentation tool writes `sanity.previewUrlSecret` to the wrong dataset in a multi-workspace hosted Studio** (SAPP). Apr 16.
- 🐛 **#12806 — Safari: Presentation tool "Unable to connect" — cross-origin iframe sandboxing errors.** Apr 5.
- 🐛 **#12620 — Field presence not cleared when focus leaves a field** (type: Bug). Apr 13.
- 🐛 **#12835 — Unable to revert to default ordering/layout after manual selection.** May 17.
- ✨ **#12834 — Feature: include document language (or field values) in edit-intent params for `canHandleIntent` routing** (type: Feature). May 15.
- ✨ **#12812 — Feature: preserve original image metadata / add IPTC metadata on photo upload** (CLDX, Feature). May 10.
- ✨ **#12787 — Feature: support multiple `typegen` configurations** (CLI, Feature). May 5.

**Release context (search-derived, carried):** Sanity Studio ~v6.4.0 (Jul 7).

## 5. Ghost — `TryGhost/Ghost`
_Snapshot freshness: newest visible open issue #27717 opened May 6, 2026 (cache ~early May). Open issues: 63._

**🔒 Security (search-derived):**
- **CVE-2026-29053 — RCE via malicious themes (NEW this run):** arbitrary JS execution on a Ghost instance through a crafted theme an admin installs; affects ~0.7.2–6.19.0; **patched in 6.19.1**.
- **CVE-2026-26980 — SQLi in Content API (CVSS 9.4, exploited in the wild):** 700+ sites compromised; **patched in 6.19.1**.
- Both fixed by upgrading to **≥6.19.1**.

**Notable open issues (confirmed from tracker):**
- 🔒✨ **#27445 — Security: add optional malware scanning for uploaded files (pompelmi)** (needs:triage). Apr 17.
- 🐛 **#26677 — Admin API always saves revisions even when `save_revision=false`** (needs:triage). Mar 3.
- 🐛 **#27415 — Share button doesn't work because `portal.min.js` isn't loaded when subscriptions are disabled.** Apr 15.
- 🐛 **#26607 — Editor opening staff settings/profile triggers forbidden API calls + unrelated permission toast.** Feb 26.
- 🐛 **#26399 — Unhandled `JSON.parse()` exceptions in Portal's `fetchQueryStrData()` crash the widget on malformed preview URLs.** Feb 14.
- ✨ **#27478 — Feature: set excerpt length to 2000 characters** (needs:triage). Apr 21.
- 📝 **#27717 — Document HelmForge chart as a third-party Kubernetes install option.** May 6.
- 🌐 **#23361 (pinned) — i18n mega-issue;** **#23924 (pinned) — 🔥 Breaking Changes for 6.0.**

## 6. KeystoneJS — `keystonejs/keystone`
_Snapshot freshness: newest visible open issue #9798 opened Apr 3, 2026 (cache ~early April). Open issues: 100._

**Notable open issues:**
- 🔒✨ **#9789 — Should Keystone enforce GraphQL query-depth limits by default?** (type: Feature) — security-hardening discussion. Mar 18.
- 🔒🐛 **#9785 — `statelessSessions` attempts to use unsupported `Authorization: Basic` header rather than the cookie** (discussion, documentation, help wanted). Mar 6.
- 🐛 **#9665 — Field can be editable when `graphql.omit.update` is set** (help wanted, type: Bug) — access-control gap. Jul 22, 2025.
- 🐛 **#9772 — "ID!" used in position expecting type "IDFilter" when loading a single entity.** Feb 3.
- 🐛 **#9779 — `npm run dev` fails with EPERM error on Windows.** Feb 20.
- 🐛 **#9765 — Keystone 6 Admin UI throws Unhandled Runtime Error when editing a Post on a fresh CLI install.** Jan 24.
- 🧰 **#9798 — Bump Next to >15.5.13** (dependencies). Apr 3.
- 🐛 **#9657 — JSON fields + SQLite have no Prisma default** (type: Bug). Jul 16, 2025.

_Note: many top open issues are from 2025 — a low-velocity tracker relative to the others._

## 7. TinaCMS — `tinacms/tinacms`
_Snapshot freshness: newest visible open issue #7169 opened Jul 7, 2026 — **current**. Open issues: 378._

**Notable open issues (freshest tracker this run):**
- ✨ **#7169 — Rich-text: render semantic `<thead>`/`<th>` for markdown tables in TinaMarkdown** (enhancement, rich-text). Jul 7.
- 🐛 **#7148 — Folder-based collection with `create:false` + `delete:false` is unnavigable — single-document auto-open fires inside folder views** (bug, pending triage). Jul 4.
- 🐛 **#7134 — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding the 1MB preview-overlay cap with no error.** Jul 1.
- 🐛 **#7116 — Save button stays enabled after a successful save until clicked again** (bug, v4, YakShaver). Jun 30.
- 🐛 **#7096 — Pressing Enter in the editor inserts a line break at the wrong position and corrupts bullet-list formatting** (Needs Refinement, YakShaver). Jun 25.
- ✨ **#7092 — Plugin system: Auth plugin — better-auth** (technical-debt, v4). Jun 23.
- ✨ **#7075 — Markdown: support markdown plugins** (rich-text). Jun 22.
- ✨🧰 **#7068 / #7067 — CLI/deploy:** split `tinacms build` (pure codegen) from a deploy-time publish gate (#7068); deploy schema-gate should wait for `schemaSha` convergence rather than a one-shot compare (#7067). Jun 18.
- 📝 **#7118 — Docs: deploying the TinaCMS Astro starter to Cloudflare Pages (static export).** Jun 30.
- 🧰 CI starter-template failures: **#7162** (basic starter fails install with yarn on Node 22), **#7109** (astro starter fails build with npm on Node 24).

## 8. Decap CMS — `decaporg/decap-cms`
_Snapshot freshness: newest visible open issue #7875 opened Jul 5, 2026 — **current**. Open issues: 559._

**Notable open issues:**
- 🔒 **#7875 — Path traversal in the `decap-server` proxy allows read/write/delete of files outside the configured repository root** (type: bug). Jul 5. Highest-signal open item.
- 🐛 **#7873 — Images not rendered in preview starting from Decap CMS v3.13.0** (type: bug) — regression on the current line. Jun 29.
- 🐛 **#7816 — Soft line breaks in the new rich-text widget** (type: bug). May 19.
- 🐛 **#7802 — Can't copy and paste into rich text** (area: richtext, bug). May 4.
- 🐛 **#7800 — Preview pane stops accepting scroll events after resizing the form/preview divider** (bug). May 2.
- 🐛 **#7867 — Impossible to log in with Forgejo — missing secret** (type: bug). Jun 25.
- 🐛 Runtime crashes: **#7871** (`Cannot read properties of undefined (reading 'path')`), **#7870** (`removeChild` NotFoundError), **#7869/#7868** (`Cannot destructure property 'url' of 'e.element.data'`).
- ✨ **#7823 — Support open authoring for GitLab** (type: feature). May 21.

**Release context (search-derived, carried):** latest ~v3.14.1; the Plate-based rich-text widget (shipped v3.12.0, beta) is generating several of the open bugs above.

## 9. Builder.io — `BuilderIO/builder`
_Snapshot freshness: newest visible open issue #4501 opened Apr 4, 2026 (cache ~early April). Open issues: 62._

**Notable open issues:**
- 🔒 **#4501 — Security: cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346).** Apr 4. Highest-signal open item.
- 🐛 **#4212 — Using `eval` for detecting server code throws a CSP error.** Dec 15, 2025.
- 🐛 **#4137 — `@builder.io/react` fails to install on Node.js 24+ due to C++20 compilation requirements.** Aug 30, 2025.
- 🐛 **#4219 — Vue 3 "[Vue warn]: Extraneous non-props attributes".** Dec 19, 2025.
- 🐛 **#4191 / #4165 — Qwik:** EnableEditor state merging breaks block reactivity (#4191); temporary code not yet reverted inside content component (#4165).
- ✨ **#4220 — Add validation to prevent duplicate component names during registration.** Jan 8.
- 🧰 **#4164 — Storybook 10 support.** Oct 20, 2025.

_Note: tracker skews to older/2025 items; Builder's product focus has shifted to the agentic "Builder 2.0" line (search-derived, carried)._

## 10. Medusa — `medusajs/medusa`
_Snapshot freshness: newest visible open issue #15406 opened May 14, 2026 (cache ~mid-May). Open issues: 111._

**Notable open issues (commerce-focused):**
- 🐛 **#15306 — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`)** (needs triaging, type: bug). May 6. Money-path correctness bug.
- 🐛 **#15360 — Race condition in cart promotions can create duplicate line-item adjustments** (requires-team, v2.0). May 11.
- 🐛 **#15399 — `/store/products` returns 500 for any `category_id`/`tag_id` filter when the `index_engine` feature flag is enabled** (v2.0). May 14.
- 🐛 **#15398 — `@medusajs/icons` peer-dep React ^19.2.5 conflicts with `@medusajs/dashboard`/`@medusajs/ui` (React ^18.3.1) → ERESOLVE in npm workspaces.** May 13.
- 🐛 **#15341 — Build silently excludes any file path containing the substring "test"** (`Compiler.backendIgnoreFiles`, good first issue). May 8.
- 🐛 **#15321 — `db:sync-links` generates invalid PostgreSQL `ALTER TABLE schema.old RENAME TO schema.new`** (help-wanted). May 7.
- 🐛 **#15343 — `getDatabaseURL` in `@medusajs/test-utils` breaks for passwords containing `#`, `@`, `:`.** May 8.
- 🐛 **#15353 — Error sorting orders by Total / Fulfillment status / Payment status** (good first issue, v2.0). May 10.
- 🐛 **#15300 — `medusa db:migrate` exit code** (v2.0). May 5.
- 📝 **#15406 — Local dev setup for contributors is confusing, undocumented, lacks hot reload for plugins.** May 14.

**Release context (search-derived, carried):** latest ~v2.17.1 (v2.17.0 had a worker-instance regression — skip to v2.17.1).

---

## Cross-cutting themes today

- **Security signal is concentrated at the edges:** an RCE + an SQLi both patched in Ghost 6.19.1; open path-traversal (Decap #7875) and open postMessage-RCE (Builder #4501) in the tracker; Strapi's open register-admin rate-limit/race (#26494). If you run any of these, verify you're on the patched line and watch these issues.
- **MCP is now a bug surface, not just a feature:** Directus #27039 and Payload #16214 are concrete MCP-integration defects — the agent/MCP layers each project shipped are being exercised in production.
- **Rich-text remains the hardest UI:** open rich-text/editor bugs across Tina (#7096, #7169), Decap (#7816, #7802), Payload (Lexical #16273/#16262), and Sanity — a recurring cost center for every CMS.
- **Data caveat:** snapshot freshness varied (Tina/Decap current to ~Jul 5–7; Directus/Payload/Keystone/Builder cached to ~Apr). "No new release" today should be read as "none surfaced given snapshot age," not a hard confirmation.

---

## Sources

Issue trackers (fetched directly this run):
- [strapi/strapi issues](https://github.com/strapi/strapi/issues) · [directus/directus issues](https://github.com/directus/directus/issues) · [payloadcms/payload issues](https://github.com/payloadcms/payload/issues) · [sanity-io/sanity issues](https://github.com/sanity-io/sanity/issues) · [TryGhost/Ghost issues](https://github.com/TryGhost/Ghost/issues)
- [keystonejs/keystone issues](https://github.com/keystonejs/keystone/issues) · [tinacms/tinacms issues](https://github.com/tinacms/tinacms/issues) · [decaporg/decap-cms issues](https://github.com/decaporg/decap-cms/issues) · [BuilderIO/builder issues](https://github.com/BuilderIO/builder/issues) · [medusajs/medusa issues](https://github.com/medusajs/medusa/issues)

Release/security context (WebSearch, labeled search-derived above):
- [Ghost CVE-2026-29053 (SentinelOne)](https://www.sentinelone.com/vulnerability-database/cve-2026-29053/) · [Ghost CVE-2026-26980 (SentinelOne)](https://www.sentinelone.com/vulnerability-database/cve-2026-26980/) · [Ghost CVE-2026-26980 exploitation (The Hacker News)](https://thehackernews.com/2026/05/ghost-cms-cve-2026-26980-exploited-to.html)
- [Strapi security disclosure (v5/v4 LTS)](https://strapi.io/blog/security-disclosure-of-vulnerabilities-cve-2025-64526-cve-2026-22599-cve-2026-22706-cve-2026-22707-and-cve-2026-27886) · [Strapi changelog](https://feedback.strapi.io/changelog) · [Directus changelog](https://directus.io/docs/releases/changelog)
