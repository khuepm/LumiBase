# Headless CMS Daily Digest — 2026-07-12

> Automated competitive-watch digest across 10 headless CMS projects (blogs + GitHub open issues).
> Sources fetched: GitHub issue lists (open, newest-first) and each project's blog/changelog landing page.
> Note: GitHub's default issue view lists **open** issues by creation date, not last-activity, so "recent" here means recently opened issues still open. Blog dates reflect the landing page at fetch time.

> **Run log**
> - `07:08` — digest generated (content below).
> - `08:05` — re-check: re-fetched all 10 GitHub issue trackers + Strapi blog. **No change** — newest open issue per repo and latest blog posts are identical to the 07:08 snapshot. No new issues opened, no new posts published in the interval.

## TL;DR — cross-cutting themes

- **AI / MCP is now table stakes.** Strapi shipped its **MCP server to GA** (Jun 29), Sanity is pushing "Content Agent" + Agent API/MCP hard, Directus added **OAuth 2.1 for MCP**, Medusa ships a Medusa MCP + dev agent, Payload 4.0 preview lists MCP, and TinaCMS is adding AI/"vibe" tooling. MCP-related **bugs** are now appearing in issue trackers (Directus #27039, Payload #16214).
- **Major version churn.** Payload **4.0** (Admin redesign + TanStack + MCP) previewed; Sanity **Studio v6** shipped (Vite 8, 2–9× faster builds, drops Node 20); Ghost **6.0** breaking-changes tracking; TinaCMS **v4** planning; Medusa on **2.0**.
- **Security is prominent.** Strapi disclosed **5 CVEs** (May 13) and has an urgent open security issue (no rate limiting on register-admin, #26494); Decap has a **path traversal** report in decap-server (#7875); Builder has a cross-origin postMessage RCE report (#4501); Payload issued a React 19/Next.js critical notice.
- **Framework-version pressure.** Next.js 16.2.x upgrades are breaking Payload (#16288, #16286); Node 22/24 breakage across Tina (#7162, #7109) and Builder (#4137); Keystone chasing Next 15.5.13 (#9798).

---

## 1. Strapi
**Blog:** https://strapi.io/blog · **Issues:** https://github.com/strapi/strapi/issues (396 open · 72.3k★)

### Blog / releases
- **The Strapi MCP server is now GA** (Jun 29) — stable surface to wire agents to Strapi content. https://strapi.io/blog/the-strapi-mcp-server-is-now-ga
- **June Community Call recap** (Jun 29) — updates + MCP GA. https://strapi.io/blog/strapi-june-community-call-recap-updates-news-strapi-mcp-in-ga
- **Release roundup: everything that changed Mar–Jun 2026** (Jun 18). https://strapi.io/blog/strapi-release-roundup-everything-that-changed-between-march-and-june-2026
- **Extend Strapi's MCP server with custom tools via a plugin** (Jun 13, tutorial).
- **Migrate from Contentful to Strapi using a Claude Code Skill** (Jun 4, tutorial).
- **Security disclosure — CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886** (May 13). https://strapi.io/blog/security-disclosure-of-vulnerabilities-cve-2025-64526-cve-2026-22599-cve-2026-22706-cve-2026-22707-and-cve-2026-27886

### Notable open issues
- 🔴 **Security:** No rate limiting on `register-admin` + race condition — Priority: Urgent, severity critical. [#26494](https://github.com/strapi/strapi/issues/26494)
- 🔴 **Content Manager crash:** "Cannot read properties of undefined (reading 'attributes')" when switching Single Types via sidebar — Urgent/critical. [#26434](https://github.com/strapi/strapi/issues/26434)
- 🔴 "Cannot read properties of undefined (reading 'list')" — Urgent/critical, v5. [#26396](https://github.com/strapi/strapi/issues/26396)
- **firstPublishedAt:** entry falsely marked modified after first publish. [#26524](https://github.com/strapi/strapi/issues/26524)
- **CI/tooling:** Nightly release workflow publishes to npm without running tests (high). [#26492](https://github.com/strapi/strapi/issues/26492)
- **DB:** Wildcard characters in filters not escaped → incorrect literal matching. [#26468](https://github.com/strapi/strapi/issues/26468)
- **Upload:** Replace media updates metadata but keeps original file (confirmed, high). [#26387](https://github.com/strapi/strapi/issues/26387)
- Hard refresh / direct access of collections list URL → 500 (high, admin). [#26487](https://github.com/strapi/strapi/issues/26487)

## 2. Directus
**Blog:** https://directus.io/blog · **Issues:** https://github.com/directus/directus/issues (326 open · 34.8k★)

### Blog / releases
- **A Backend for Everyone on Your Team** (May 26) — native **draft & publishing workflows**, redesigned Studio, **AI-assisted translations**, JSON filtering, and **OAuth 2.1 for MCP**. (flagship product post)
- "AI is straining vulnerability disclosure for maintainers" (Jul 10, Rijk van Zanten).
- "We're moving to a hardened Docker image — here's what that means" (Jun 29).
- "Headless CMS with AI Capabilities: What to Look For" (Jun 26).
- "Best Headless CMS in 2026" (Jun 16); "Building Forms with Directus and SvelteKit Remote Functions" (Jun 16).

### Notable open issues
- 🔴 **MCP:** files tool `update` action fails — data schema typed as array but API expects object (High Impact). [#27039](https://github.com/directus/directus/issues/27039)
- **Permissions:** `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger`. [#27124](https://github.com/directus/directus/issues/27124)
- **Regression:** "Save as copy" throws error (Assets/Files, High Impact). [#27091](https://github.com/directus/directus/issues/27091)
- **Extensions:** API extension hook fails — `document is not defined`. [#27119](https://github.com/directus/directus/issues/27119)
- WYSIWYG not rendering after returning from edit as non-admin (v11.16.1, High Impact). [#27042](https://github.com/directus/directus/issues/27042)
- GraphQL: aliased relational objects within a fragment return null (regression, Enterprise). [#27003](https://github.com/directus/directus/issues/27003)
- Map layout: PostGIS `geometry.Point` geospatial field produces error. [#27062](https://github.com/directus/directus/issues/27062)

## 3. Payload CMS
**Blog:** https://payloadcms.com/blog · **Issues:** https://github.com/payloadcms/payload/issues (288 open · 41.8k★)

### Blog / releases
- **An early look at Payload 4.0** (Jun 9) — Admin UI redesign, **TanStack**, **MCP**, and more. https://payloadcms.com/posts/blog/payload-40-admin-ui-redesign-tanstack-mcp-and-more
- **Payload is joining Figma!** (banner + Jun 17, 2025 post).
- Critical Security Notice affecting React 19 & Next.js (Dec 4, 2025).
- Deploy Payload onto Cloudflare in one click (Oct 3, 2025).

### Notable open issues
- 🔴 **Next.js 16.2.x fallout:** `suppressHydrationWarning` broken after upgrade. [#16288](https://github.com/payloadcms/payload/issues/16288)
- **multi-tenant plugin** causes 404 with Next.js 16.2.3 + Turbopack. [#16286](https://github.com/payloadcms/payload/issues/16286)
- **Postgres:** Date field `timezone: true` writes empty string to `_tz` enum → invalid enum input. [#16283](https://github.com/payloadcms/payload/issues/16283)
- **MCP plugin:** create/update tools produce `{ type: 'null' }` for nullable relationship fields. [#16214](https://github.com/payloadcms/payload/issues/16214)
- Bulk upload into folder-enabled collection doesn't set the folder. [#16287](https://github.com/payloadcms/payload/issues/16287)
- richtext-lexical: malfunctioning editing in custom block drawer (#16273); `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not exported (#16262).
- vercelPostgresAdapter fails on large queries (68KB+ SQL, 30+ lateral joins). [#16256](https://github.com/payloadcms/payload/issues/16256)

## 4. Sanity
**Blog:** https://www.sanity.io/blog · **Issues:** https://github.com/sanity-io/sanity/issues (75 open · 6.1k★)

### Blog / releases
- **Sanity Studio v6: A focused upgrade** (Jun 9) — **Vite 8**, builds **2–9× faster**, default-search + custom-auth improvements, **drops end-of-life Node 20**. https://www.sanity.io/blog/sanity-studio-v6
- **What's New – June 2026** (Jun 8) — prompt-to-hosted-Studio in one chat, agents that know your users, Content Agent on Slack Marketplace.
- "Agents leave receipts. We read 1.46 million of them" (Jun 15, AI content-ops analysis).
- Strong AI-ops content push: "Skills…written down for agents" (Jun 22), "We don't write code anymore" (Jun 12), Content Agent → Slack (Mar 12).

### Notable open issues
- **Image upload silently stalls** when file has no extension — no error shown. [#12870](https://github.com/sanity-io/sanity/issues/12870)
- Unable to revert to default ordering/layout after manual selection. [#12835](https://github.com/sanity-io/sanity/issues/12835)
- **Feature:** include document language/field values in edit-intent params for `canHandleIntent` routing. [#12834](https://github.com/sanity-io/sanity/issues/12834)
- **Feature:** support multiple `typegen` configurations (CLI). [#12787](https://github.com/sanity-io/sanity/issues/12787)
- Presentation tool writes `previewUrlSecret` to wrong dataset in multi-workspace hosted Studio. [#12794](https://github.com/sanity-io/sanity/issues/12794)
- Safari: Presentation tool "Unable to connect" — cross-origin iframe sandboxing. [#12806](https://github.com/sanity-io/sanity/issues/12806)

## 5. Ghost
**Blog/Resources:** https://ghost.org/resources · **Changelog:** https://ghost.org/changelog · **Issues:** https://github.com/TryGhost/Ghost/issues (63 open · 52.8k★)

### Notes
- Resources landing page is evergreen guides (not dated news); product updates live at the changelog. Generator reports **Ghost 6.51**.
- Pinned tracking issues: **🔥 Breaking Changes for 6.0** ([#23924](https://github.com/TryGhost/Ghost/issues/23924)) and **🌐 i18n mega-issue** ([#23361](https://github.com/TryGhost/Ghost/issues/23361)).

### Notable open issues
- **API:** Admin API always saves revisions even when `save_revision=false`. [#26677](https://github.com/TryGhost/Ghost/issues/26677)
- Document HelmForge chart as a third-party Kubernetes install option. [#27717](https://github.com/TryGhost/Ghost/issues/27717)
- Signup Card email placeholder hardcoded ("Your email") — no i18n/override. [#27551](https://github.com/TryGhost/Ghost/issues/27551)
- **Feature:** set excerpt length to 2000 chars. [#27478](https://github.com/TryGhost/Ghost/issues/27478)
- **Security:** add optional malware scanning for uploaded files. [#27445](https://github.com/TryGhost/Ghost/issues/27445)
- Portal: share button broken (portal.min.js not loaded) when subscriptions disabled (#27415); unhandled JSON.parse crash on malformed preview URLs (#26399).

## 6. KeystoneJS
**Blog:** https://keystonejs.com/blog · **Issues:** https://github.com/keystonejs/keystone/issues (100 open · 9.9k★)

### Notes
- Low recent activity; issues skew older. Long-running: **Node 20 (LTS) support** ([#8987](https://github.com/keystonejs/keystone/issues/8987)).

### Notable open issues
- **Dependencies:** Bump Next to >15.5.13. [#9798](https://github.com/keystonejs/keystone/issues/9798)
- **Security/feature:** Should Keystone enforce GraphQL query-depth limits by default? [#9789](https://github.com/keystonejs/keystone/issues/9789)
- `statelessSessions` attempts `Authorization: Basic` header instead of cookie. [#9785](https://github.com/keystonejs/keystone/issues/9785)
- Field editable when `graphql.omit.update` is set (bug, help wanted). [#9665](https://github.com/keystonejs/keystone/issues/9665)
- Admin UI runtime error editing Post on fresh CLI install. [#9765](https://github.com/keystonejs/keystone/issues/9765)
- `npm run dev` fails with EPERM on Windows. [#9779](https://github.com/keystonejs/keystone/issues/9779)

## 7. TinaCMS
**Blog:** https://tina.io/blog · **Issues:** https://github.com/tinacms/tinacms/issues (378 open · 13.6k★)

### Blog / releases
- **Separate Content Repos are here for TinaCloud** (Jun 12). /blog/tinacloud-separate-content-repos
- **Astro is becoming the default starter for TinaCMS** (May 28).
- **What we're planning for TinaCMS v4** (May 13). /blog/tinacms-v4-is-coming
- AI/vibe tooling: "Vibe blogging with GitHub Copilot & TinaCMS" (Mar 20), "Vibe Coding Tina Custom Components" (Feb 16).

### Notable open issues
- **Perf/visual editing:** reference fields fully hydrate on every keystroke, silently exceeding 1MB preview-overlay cap with no error. [#7134](https://github.com/tinacms/tinacms/issues/7134)
- Folder-based collection with `create:false + delete:false` is unnavigable (single-doc auto-open fires in folder views). [#7148](https://github.com/tinacms/tinacms/issues/7148)
- Editor: pressing Enter inserts line break at wrong position, corrupts bullet lists. [#7096](https://github.com/tinacms/tinacms/issues/7096)
- **Feature (v4):** Auth Plugin — `better-auth`. [#7092](https://github.com/tinacms/tinacms/issues/7092)
- **CLI/spec:** split `tinacms build` (pure codegen) from deploy-time publish gate (#7068); deploy schema gate should wait for `schemaSha` convergence (#7067).
- Rich-text: render semantic `<thead>/<th>` for markdown tables (#7169); support markdown plugins (#7075).
- Starter build failures on Node 22 (#7162) and Node 24 (#7109).

## 8. Decap CMS (formerly Netlify CMS)
**Blog:** https://decapcms.org/blog · **Issues:** https://github.com/decaporg/decap-cms/issues (559 open · 19.2k★)

### Blog / releases
- **Announcing Decap Turbo** (May 5) — new SaaS upgrade for teams: CMS performance, centralized auth, granular permissions (early access). https://decapcms.org/blog/announcing-decap-turbo/
- **Richtext Widget Replaces the Markdown Widget** (Apr 16) — new richtext widget built on **Plate editor**; markdown widget deprecated (still available, unmaintained). https://decapcms.org/blog/richtext-widget-replaces-markdown-widget/

### Notable open issues
- 🔴 **Security:** Path traversal in decap-server proxy allows read/write/delete outside repo root. [#7875](https://github.com/decaporg/decap-cms/issues/7875)
- **Regression:** Images not rendered in preview since v3.13.0. [#7873](https://github.com/decaporg/decap-cms/issues/7873)
- New richtext widget bugs: soft line breaks (#7816), can't copy/paste into rich text (#7802), preview pane stops accepting scroll after divider resize (#7800).
- Several `TypeError` crashes: `Cannot read properties of undefined (reading 'path')` (#7871); destructure `url` of `e.element.data` undefined (#7869/#7868).
- Forgejo login impossible — missing secret. [#7867](https://github.com/decaporg/decap-cms/issues/7867)
- **Feature:** open authoring for GitLab. [#7823](https://github.com/decaporg/decap-cms/issues/7823)

## 9. Builder.io
**Blog:** https://www.builder.io/blog · **Issues:** https://github.com/BuilderIO/builder/issues (62 open · 8.8k★)

### Notes
- Lower open-source repo activity; issues skew older.

### Notable open issues
- 🔴 **Security:** Cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346). [#4501](https://github.com/BuilderIO/builder/issues/4501)
- `eval` for detecting server code throws CSP error. [#4212](https://github.com/BuilderIO/builder/issues/4212)
- `@builder.io/react` fails to install on Node.js 24+ (C++20 build requirement). [#4137](https://github.com/BuilderIO/builder/issues/4137)
- Add validation to prevent duplicate component names on registration. [#4220](https://github.com/BuilderIO/builder/issues/4220)
- Qwik: EnableEditor state merging breaks block reactivity (#4191); temp code not reverted in content component (#4165).
- Storybook 10 support (#4164); Vue 3 extraneous non-props attribute warnings (#4219).

## 10. Medusa (commerce)
**Blog:** https://medusajs.com/blog · **Changelog:** https://medusajs.com/changelog · **Issues:** https://github.com/medusajs/medusa/issues (111 open · 33k★)

### Blog / releases
- **Announcing new Layout Composer in Medusa Admin** (Jul 1, Product). https://medusajs.com/blog/announcing-layout-composer/
- Heavy agent-tooling positioning: Medusa MCP, Agentic guide, Agent Skills, Cloud "fix with AI" dev agent (docs nav).

### Notable open issues (v2.0)
- 🔴 **Data integrity:** Race condition in cart promotions can create duplicate line-item adjustments. [#15360](https://github.com/medusajs/medusa/issues/15360)
- 🔴 **Payments:** Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`). [#15306](https://github.com/medusajs/medusa/issues/15306)
- `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled. [#15399](https://github.com/medusajs/medusa/issues/15399)
- **Dep conflict:** `@medusajs/icons` peer dep React ^19.2.5 vs dashboard/ui React ^18.3.1 → ERESOLVE. [#15398](https://github.com/medusajs/medusa/issues/15398)
- `db:sync-links` generates invalid Postgres schema-qualified `RENAME TO`. [#15321](https://github.com/medusajs/medusa/issues/15321)
- Build silently excludes any path containing substring `test`. [#15341](https://github.com/medusajs/medusa/issues/15341)
- RTL layout issues in admin for Hebrew/Arabic/Farsi (#15371); sort orders by Total/Fulfillment/Payment status errors (#15353).

---

## Relevance to LumiBase
- Every competitor is racing to an **MCP/agent** story — aligns with LumiBase's "AI-native, governed agents" positioning. MCP tool-schema bugs (Directus #27039, Payload #16214) are a concrete quality bar to beat.
- **Draft/publish workflows + provenance** (Directus flagship, Ghost revision-save bug #26677) reinforce LumiBase's intent-driven/provenance model.
- **Edge/Cloudflare deploy** (Payload one-click) and **multi-tenancy** (Payload plugin) are recurring themes matching LumiBase's dual-deployment + multi-tenant-by-default design.
- Framework-version breakage (Next 16.2, Node 22/24) is a shared pain point worth watching for LumiBase's own dependency policy.

<run-summary>First run of the CMS daily digest: pulled recent open GitHub issues and blog/changelog highlights for all 10 headless CMS projects. Dominant themes this window are MCP/agent GA pushes (Strapi, Sanity, Directus, Payload 4.0), major version releases (Sanity Studio v6, Payload 4.0 preview, Decap Turbo), and several security items (Strapi 5 CVEs + urgent register-admin issue, Decap path traversal, Builder postMessage RCE). No prior digest existed, so nothing to diff against.</run-summary>
