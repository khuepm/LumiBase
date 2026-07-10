# Headless CMS Daily Digest — 2026-07-08

> Scheduled watch over 10 popular headless CMS projects. Signals are drawn from each project's public **GitHub issue tracker** (open issues, newest first) and, where server-rendered content was available, their **blog / release** pages. Issue lists reflect the state fetched on this run; "opened" dates are shown so you can see how fresh each item is.
>
> **Legend:** 🐛 bug · ✨ feature / enhancement · 🔒 security · 📝 docs · 🧰 tooling / CI · 💬 discussion

---

## Summary of the day

- **Cross-project theme: AI / MCP is now mainstream.** Strapi shipped a built-in MCP server (v5.47.0) and is publishing guides on extending it; Payload's 4.0 preview leads with MCP + TanStack + an admin redesign; Directus and Payload both have open bugs specifically in their **MCP tools**; Medusa is marketing an MCP server and "agentic" tooling. Content OS / agent-facing APIs are the competitive front line.
- **Security items worth noting:** Strapi has an **Urgent** open security issue (no rate limiting + race condition on `register-admin`); Decap CMS has an open **path-traversal** report in its local proxy server; Builder.io has an open **postMessage cross-origin code execution** report (CWE-346); Ghost has a feature request for optional malware scanning of uploads.
- **Framework upgrade churn:** Multiple projects are chasing Next.js 16 / React 19 / Node 24 compatibility (Payload, Keystone, Medusa, Builder), a recurring source of new bugs.

---

## 1. Strapi — `strapi/strapi`

**Blog / releases (strapi.io/blog):**
- ✨ **Strapi MCP server shipped in v5.47.0** — exposes content types as agent-callable tools, scoped by admin-token permissions; free and self-hosted (May 28, 2026). Follow-up guide "How to extend Strapi's MCP server with custom tools via a plugin" (Jun 13, 2026).
- 📝 "Building Docs for the AI Era, Part 1: Self-Healing Docs" — using AI + GitHub Actions to auto-detect doc gaps (Jun 11, 2026).
- 📝 Migration + integration content: Contentful→Strapi via a Claude Code Skill (Jun 4); Better Auth setup for Strapi v5 + Next.js 16 (May 21).

**GitHub issues (open, recent):** 396 open.
- 🔒 **#26494 — No rate limiting on `register-admin` + race condition** (Priority: Urgent, severity: critical). Opened May 30.
- 🐛 #26524 — `firstPublishedAt`: entry falsely marked as modified after first publish when feature enabled (severity: medium). Jun 2.
- 🧰 #26492 — Nightly release workflow publishes to npm without running any tests (severity: high). May 30.
- 🧰 #26490 — `docker-compose.test.yml` missing healthchecks on postgres/mysql. May 30.
- 🐛 #26487 — Hard refresh / direct access of collections list URL → 500 (severity: high, core:admin). May 29.
- 🐛 #26468 — Wildcard characters in filters not escaped → incorrect literal matching (core:database). May 28.
- 🐛 #26434 / #26396 — `Cannot read properties of undefined` crashes in Content Manager (Priority: Urgent, critical). May 20–26.
- 🐛 #26387 — Replace-media updates metadata but keeps original file content (status: confirmed, severity: high). May 19.

## 2. Directus — `directus/directus`

**GitHub issues (open, recent):** 326 open.
- 🐛 #27129 — Back button broken for all item pages (Needs Info). Apr 15.
- 🐛 #27124 — `GET /permissions/me` returns 500 when a non-admin policy has `directus_flows:trigger`. Apr 15.
- 🐛 #27119 — Cannot register API-extension hook: `document is not defined` (Ext SDK / Extensions). Apr 15.
- 🐛 #27111 — Apple OAuth first/last name not populated on registration. Apr 14.
- 🧰 #27094 — `@directus/api` using an old version of `tsdown` / `openid-client`. Apr 11.
- 🐛 #27091 — "Save as copy" throws error (Regression, High Impact, Assets/Files). Apr 10.
- 🐛 #27039 — **[MCP] files tool** update action fails: data schema typed as array but API expects object (AI/MCP, High Impact). Apr 3.
- 🐛 #27042 / #27028 — WYSIWYG rendering/accessibility bugs (High Impact). Apr 2–3.
- ✨ #27016 — Improvement: unhelpful error on weak-password validation. Mar 31.
- 🐛 #27003 — Aliased GraphQL relational objects within a fragment return null (Regression, Enterprise). Mar 30.

## 3. Payload CMS — `payloadcms/payload`

**Blog / releases (payloadcms.com/blog):**
- ✨ **"An early look at Payload 4.0: Admin UI redesign, TanStack, MCP, and more"** (Jun 9, 2026) — headline direction for the next major.
- 🔒 "Critical Security Notice Affecting React 19 and Next.js" (Dec 4, 2025).
- ✨ "Deploy Payload onto Cloudflare in one click" (Oct 3, 2025). (Payload is now part of Figma.)

**GitHub issues (open, recent):** 288 open.
- 🐛 #16288 — `suppressHydrationWarning` broken after Next.js upgrade to 16.2.* (area: core). Apr 15.
- 🐛 #16287 — Bulk upload into a folder-enabled upload collection doesn't set the folder (area: ui). Apr 15.
- 🐛 #16286 — `@payloadcms/plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack. Apr 15.
- 🐛 #16283 — Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → enum error. Apr 15.
- 🐛 #16273 / #16262 — Lexical rich-text: broken editing in custom block drawer; `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported. Apr 13–14.
- 🐛 #16256 — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins). Apr 12.
- 🐛 #16214 — **[MCP Plugin]** create/update tools produce `{ type: 'null' }` for nullable relationship fields. Apr 8.

## 4. Sanity — `sanity-io/sanity`

**GitHub issues (open, recent):** 75 open (Studio repo).
- 🐛 #12870 — Image upload silently stalls when file has no extension; no error shown. May 24.
- 🧰 #12869 — Tests dashboard & auto-balancing Playwright shards. May 23.
- 🐛 #12835 — Unable to revert to default ordering/layout after manual selection. May 17.
- ✨ #12834 — Feature: include document language / field values in edit-intent params for `canHandleIntent` routing. May 15.
- ✨ #12812 — Feature: preserve original image metadata / add IPTC metadata on upload (CLDX). May 10.
- ✨ #12787 — Feature: support multiple `typegen` configurations (CLI). May 5.
- 🐛 #12733 — Cannot create account on signup: server rejects strong password as "too weak" (identity). Apr 22.
- 🐛 #12794 — Presentation tool writes `sanity.previewUrlSecret` to wrong dataset in multi-workspace hosted Studio. Apr 16.

## 5. Ghost — `TryGhost/Ghost`

**Notes:** ghost.org/resources is an evergreen guide library (no dated release feed served); product changes are tracked at ghost.org/changelog. Pinned issues signal the roadmap: **🔥 Breaking Changes for 6.0** (#23924) and **🌐 i18n mega-issue** (#23361).

**GitHub issues (open, recent):** 63 open.
- 📝 #27717 — Document HelmForge chart as a third-party Kubernetes install option. May 6.
- 🐛/✨ #27551 — Signup Card email placeholder is hardcoded ("Your email"); no i18n or per-card override. Apr 25.
- ✨ #27478 — Feature: set excerpt length to 2000 characters. Apr 21.
- 🔒 #27445 — Security: add optional malware scanning for uploaded files (pompelmi). Apr 17.
- 🐛 #27415 — Share button broken because `portal.min.js` isn't loaded when subscriptions are disabled. Apr 15.
- 🐛 #26677 — Admin API always saves revisions even when `save_revision=false`. Mar 3.
- 🐛 #26399 — Unhandled `JSON.parse()` exceptions in Portal crash the widget on malformed preview URLs. Feb 14.

## 6. KeystoneJS — `keystonejs/keystone`

**GitHub issues (open, recent):** 100 open.
- 🧰 #9798 — Bump Next to >15.5.13 (dependencies). Apr 3.
- ✨ #9789 — Feature: should Keystone enforce GraphQL query-depth limits by default? Mar 18.
- 🐛/📝 #9785 — `statelessSessions` tries to use unsupported `Authorization: Basic` header instead of the cookie. Mar 6.
- 🐛 #9779 — `npm run dev` fails with EPERM on Windows. Feb 20.
- 🐛 #9772 — Error loading single entity: `ID!` used where `IDFilter` expected. Feb 3.
- 🐛 #9765 — Admin UI throws Unhandled Runtime Error when editing a Post on a fresh CLI install. Jan 24.
- 🐛 #9665 — Field editable when `graphql.omit.update` is set (help wanted). Jul 22, 2025.

_Note: Keystone's newest open issues date to Q1 2026 — a comparatively quiet tracker._

## 7. TinaCMS — `tinacms/tinacms`

**GitHub issues (open, recent):** 378 open — the most active tracker this run, with items dated to Jul 7, 2026.
- ✨ #7169 — Rich-text: render semantic `<thead>`/`<th>` for markdown tables in `TinaMarkdown`. Jul 7.
- 🐛 #7162 — Starter template 'basic' fails during install with yarn on Node 22 (automated). Jul 6.
- 🐛 #7148 — Folder-based collection with `create:false` + `delete:false` is unnavigable. Jul 4.
- 🐛 #7134 — Reference fields fully hydrate on every keystroke during visual editing, silently exceeding the 1MB preview-overlay cap with no error. Jul 1.
- 📝 #7118 — Docs: deploying the Tina Astro starter to Cloudflare Pages. Jun 30.
- 🐛 #7116 — Save button stays enabled after a successful save (v4, YakShaver). Jun 30.
- ✨ #7092 — Plugin system: better-auth auth plugin (v4). Jun 23.
- ✨ #7075 / #7068 / #7067 — Markdown plugin support; split `tinacms build` (pure codegen) from a deploy-time publish gate; deploy schema gate should wait for `schemaSha` convergence. Jun 18–22.

_Signal: heavy v4 planning around auth plugins, rich-text/markdown extensibility, and build/deploy pipeline changes._

## 8. Decap CMS — `decaporg/decap-cms`

**GitHub issues (open, recent):** 559 open.
- 🔒 **#7875 — Path traversal in `decap-server` proxy** allows read/write/delete of files outside the configured repo root (type: bug). Jul 5.
- 🐛 #7873 — Images not rendered in preview starting from Decap CMS v3.13.0. Jun 29.
- 🐛 #7871 / #7870 / #7869 / #7868 — Runtime crashes: `Cannot read properties of undefined (reading 'path')`; `removeChild` NotFoundError; `Cannot destructure property 'url'` (×2). Jun 28–29.
- 🐛 #7867 — Cannot log in with Forgejo — missing secret. Jun 25.
- ✨ #7823 — Support open authoring for GitLab (type: feature). May 21.
- 🐛 #7816 / #7802 / #7800 — Rich-text widget: soft line breaks; can't copy/paste; preview pane stops accepting scroll after resizing divider. May 2–19.

## 9. Builder.io — `BuilderIO/builder`

**GitHub issues (open, recent):** 62 open.
- 🔒 **#4501 — Cross-origin code execution via unvalidated `postMessage` in builder-block** (CWE-346). Apr 4.
- ✨ #4220 — Add validation to prevent duplicate component names during registration. Jan 8, 2026.
- 🐛 #4219 — Vue 3: "Extraneous non-props attributes" warning. Dec 19, 2025.
- 🐛 #4212 — Using `eval` for server-code detection throws a CSP error. Dec 15, 2025.
- 🐛 #4191 / #4165 — Qwik: `EnableEditor` state merging breaks block reactivity; temporary code not reverted inside content component. Oct–Nov 2025.
- 🐛 #4137 — `@builder.io/react` fails to install on Node.js 24+ (C++20 build requirement). Aug 30, 2025.
- ✨ #4164 — Storybook 10 support. Oct 20, 2025.

_Note: Builder's open tracker skews older (late-2025 items still near the top)._

## 10. Medusa — `medusajs/medusa` (commerce)

**Blog / releases (medusajs.com/blog):**
- ✨ **"Announcing new Layout Composer in Medusa Admin"** (Jul 1, 2026) — admin layout customization. Medusa is also heavily marketing MCP server + "agentic" tooling (Cloud CLI, Agent Skills, preview environments, "fix with AI" dev agent).

**GitHub issues (open, recent):** 111 open.
- 📝 #15406 — Local dev setup for contributors is confusing/undocumented; no hot reload for plugins. May 14.
- 🐛 #15399 — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag is enabled (v2.0). May 14.
- 🐛 #15398 — `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → npm ERESOLVE. May 13.
- 🐛 #15371 — RTL layout issues in admin dashboard for Hebrew/Arabic/Farsi (help-wanted). May 11.
- 🐛 #15360 — Race condition in cart promotions can create duplicate line-item adjustments (v2.0). May 11.
- 🐛 #15343 — `getDatabaseURL` in test-utils breaks for passwords with special URL chars (`#`, `@`, `:`). May 8.
- 🐛 #15306 — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`). May 6.
- 🐛 #15300 — `medusa db:migrate` exit code incorrect (v2.0). May 5.

---

### Method & caveats
- GitHub issue lists were read from each repo's public `/issues` view (default ordering, open state). Counts (e.g. "396 open") are the tracker totals shown at fetch time.
- Blog coverage was captured where the site served static/server-rendered HTML: **Strapi, Payload, Medusa** returned dated post lists; **Ghost** served its evergreen resources hub (product changes live at `/changelog`). Directus, Sanity, Keystone, Tina, Decap, and Builder blog feeds were not fetched this run — their signal here is issue-tracker only. A future run could add their `/releases` or `/changelog` pages for feature notes.
- This is the **first run** of this digest, so there is no prior file to diff against; subsequent runs can compare against this dated file.
