# Headless CMS Daily Digest — 2026-07-11

> Automated competitive-intel scan of 10 headless CMS projects (blog/release posts + open GitHub issues).
> **Note on dates:** GitHub items below are the *newest open issues* on each repo at scan time; their "opened" dates range from a few days to several months old (older ones are still open/unresolved). All items are quoted directly from the source pages listed under **Sources**. No content here is inferred — where a source did not render dated news, that is stated explicitly.

---

## Executive summary — what's moving

- **AI / MCP is the dominant theme across every vendor.** Strapi shipped its MCP server to GA; Sanity, Directus, Payload, Medusa and Builder are all shipping agent/MCP tooling and AI-first messaging.
- **Security disclosures worth tracking:** Strapi (5 CVEs, May 2026), Payload (React 19 / Next.js critical notice), Decap (path-traversal in `decap-server` proxy), Builder (postMessage cross-origin code execution).
- **Major version work in flight:** Payload 4.0 (early look), Sanity Studio v6 (shipped), TinaCMS v4 (planning), Ghost 6.0 (breaking-changes tracking issue).
- **Two projects look quiet:** KeystoneJS blog last updated Aug 2024 (issues still active); Ghost's public "resources" page is evergreen guides, not dated news.

---

## 1. Strapi

**Blog / releases**
- **The Strapi MCP server is now GA** (Jun 29, 2026) — a stable surface to wire agents to Strapi content; follows the initial MCP release (May 28, 2026) and a guide on extending the MCP server with custom tools via a plugin (Jun 13).
- **Strapi release roundup: everything that changed between March and June 2026** (Jun 18) — consolidated changelog.
- **Security disclosure: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886** (May 13, 2026).

**Notable open GitHub issues (Strapi 5)**
- `#26494` **Security:** no rate limiting on `register-admin` + race condition — labeled *Priority: Urgent / severity: critical* (May 30).
- `#26492` CI: nightly release workflow publishes to npm without running any tests (May 30).
- `#26434` Content Manager crash — "Cannot read properties of undefined (reading 'attributes')" when navigating Single Types — *critical* (May 26).
- `#26387` Replace-media updates metadata but keeps original file — *high, confirmed* (May 19).
- `#26524` `firstPublishedAt`: entry falsely marked modified after first publish (Jun 2).

## 2. Directus

**Blog / releases**
- **A Backend for Everyone on Your Team** (May 26, 2026) — native draft & publishing workflows, redesigned Studio, AI-assisted translations, JSON filtering, and **OAuth 2.1 for MCP**.
- **AI is straining vulnerability disclosure for maintainers** (Jul 10, 2026).
- **Moving to a hardened Docker image — what that means** (Jun 29, 2026).
- Also: "Headless CMS with AI Capabilities: What to Look For" (Jun 26), "Best Headless CMS in 2026" (Jun 16).

**Notable open GitHub issues**
- `#27039` **[MCP]** files tool `update` action fails — data schema typed as array but API expects object — *High Impact* (Apr 3).
- `#27091` Save-as-copy throws error — *High Impact, Regression, Studio* (Apr 10).
- `#27124` `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger` (Apr 15).
- `#27003` Aliased GraphQL relational objects within a fragment return null — *Regression, Enterprise* (Mar 30).

## 3. Payload CMS

**Blog / releases**
- **An early look at Payload 4.0** (Jun 9, 2026) — Admin UI redesign, TanStack, MCP, and more.
- **Critical Security Notice Affecting React 19 and Next.js** (Dec 4, 2025).
- Context: Payload is now part of Figma (announced Jun 2025).

**Notable open GitHub issues**
- `#16286` `plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack (Apr 15).
- `#16283` Date field `timezone: true` writes empty string to `_tz` enum column in Postgres → `invalid input value for enum` (Apr 15).
- `#16214` **[MCP Plugin]** create/update tools produce `{ type: 'null' }` for nullable relationship fields (Apr 8).
- `#16256` `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins) (Apr 12).

## 4. Sanity

**Blog / releases**
- **Sanity Studio v6: A focused upgrade** (Jun 9, 2026) — builds 2–9× faster on Vite 8, search/custom-auth improvements, drops end-of-life Node 20.
- Monthly **"What's New"** cadence (June, May, April 2026) — hosted Studio from one chat, Content Agent on Slack Marketplace, GROQ-powered access control, Scheduled Functions.
- Heavy engineering/AI-ops essay stream ("We don't write code anymore", "Agents leave receipts", agent Context/API guides).

**Notable open GitHub issues**
- `#12870` Image upload silently stalls when file has no extension — no error shown (May 24).
- `#12733` Cannot create account — signup rejects strong password as "too weak" (Apr 22).
- `#12834` Feature request: include document language/field values in edit-intent params for `canHandleIntent` routing (May 15).
- `#12812` Feature request: preserve original image metadata / add IPTC metadata on upload (May 10).

## 5. Ghost

**Blog / resources**
- `ghost.org/resources` is an **evergreen guide library** (Building / Publishing / Growth / Business) — not dated release news. Site generator reports **Ghost 6.51**. Dated product news lives on the changelog (not retrievable this run).

**Notable open GitHub issues**
- `#23924` 🔥 **Breaking Changes for 6.0** (tracking issue, opened Jun 2025).
- `#23361` 🌐 i18n mega-issue (May 2025).
- `#27445` Security: add optional malware scanning for uploaded files (Apr 17, 2026).
- `#26677` Admin API always saves revisions even when `save_revision=false` (Mar 3).
- `#27415` Share button broken because `portal.min.js` not loaded when subscriptions disabled (Apr 15).

## 6. KeystoneJS

**Blog / releases**
- Blog appears **stale** — latest post is "A year of releases in review" (Aug 7, 2024). Active development is tracked via GitHub Releases instead.

**Notable open GitHub issues**
- `#9798` Bump Next to >15.5.13 — *dependencies* (Apr 3, 2026).
- `#9789` Feature: should Keystone enforce GraphQL query-depth limits by default? (Mar 18).
- `#9785` `statelessSessions` uses unsupported `Authorization: Basic` header rather than cookie (Mar 6).
- `#9665` Field editable when `graphql.omit.update` is set — *Bug, help wanted* (Jul 2025).

## 7. TinaCMS

**Blog / releases**
- **Separate Content Repos are here for TinaCloud** (Jun 12, 2026).
- **Astro is becoming the default starter for TinaCMS** (May 28, 2026).
- **What we're planning for TinaCMS v4** (May 13, 2026).

**Notable open GitHub issues**
- `#7169` ✨ Rich-text: render semantic `<thead>/<th>` for markdown tables in TinaMarkdown (Jul 7).
- `#7148` Folder-based collection with `create:false + delete:false` is unnavigable (Jul 4).
- `#7134` Reference fields fully hydrate on every keystroke during visual editing, exceeding 1MB preview-overlay cap silently (Jul 1).
- `#7092` ✨ Plugin System — Auth Plugin (better-auth), targeted for v4 (Jun 23).
- `#7068` / `#7067` CLI: split `tinacms build` (pure codegen) from deploy-time publish gate; schema-gate convergence (Jun 18).

## 8. Decap CMS (formerly Netlify CMS)

**Blog / releases**
- **Announcing Decap Turbo** (May 5, 2026) — new SaaS upgrade for teams: CMS performance, centralized auth, granular permissions (early access).
- **Richtext Widget Replaces the Markdown Widget** (Apr 16, 2026) — new richtext widget built on the Plate editor; markdown widget deprecated (still available, no longer actively maintained).

**Notable open GitHub issues**
- `#7875` **Security:** path traversal in `decap-server` proxy allows read/write/delete of files outside the configured repo root (Jul 5) — *bug*.
- `#7873` Images not rendered in preview starting from Decap CMS v3.13.0 (Jun 29) — *bug*.
- `#7823` Feature: support open authoring for GitLab (May 21).
- `#7816` Soft line breaks in new richtext widget (May 19).

## 9. Builder.io

**Blog / releases** (largely AI/agentic thought-leadership + product)
- **Introducing Clips: an open-source, agent-native Loom alternative** (Jun 26, 2026).
- **Introducing `/visual-plan`: scannable Claude Code plans** (Jun 24, 2026).
- "Building Without the Handoffs" (Jun 29) — Headless CMS / Governance & Security.

**Notable open GitHub issues**
- `#4501` **Security:** cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346) (Apr 4, 2026).
- `#4212` Using `eval` for detecting server code throws CSP error (Dec 2025).
- `#4220` Feature: add validation to prevent duplicate component names during registration (Jan 2026).
- `#4164` Storybook 10 support (Oct 2025).

## 10. Medusa (commerce)

**Blog / releases**
- **Announcing new Layout Composer in Medusa Admin** (Jul 1, 2026) — the blog is client-rendered, so only the featured post rendered this run; changelog holds the fuller list.

**Notable open GitHub issues (v2.0)**
- `#15399` `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled (May 14).
- `#15360` Race condition in cart promotions can create duplicate line-item adjustments (May 11).
- `#15306` Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`) (May 6).
- `#15398` `@medusajs/icons` peer dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE (May 13).
- `#15371` RTL layout issues in admin dashboard for Hebrew/Arabic/Farsi — *help-wanted* (May 11).

---

## Cross-project patterns for LumiBase to note

- **MCP is now table stakes.** Strapi (GA), Directus (OAuth 2.1 for MCP), Payload (4.0), Sanity (MCP server + Agent API), Medusa (MCP), Builder (agent-native) all ship it. MCP-tool bugs (Directus `#27039`, Payload `#16214`) are a fresh, recurring defect class.
- **Publishing/draft workflows** are being added natively (Directus) — aligns with LumiBase's intent-driven/HITL model.
- **Security surface:** admin auth/rate-limiting (Strapi), proxy path traversal (Decap), postMessage RCE (Builder), framework CVEs (Payload/Strapi). Relevant to LumiBase's `AISecureHarness` and RLS posture.
- **Edge/runtime:** Payload one-click Cloudflare deploy and Vite-8 build speedups (Sanity) echo LumiBase's Edge-first / dual-deployment stance.

---

## Sources

- Strapi — [Blog](https://strapi.io/blog) · [Issues](https://github.com/strapi/strapi/issues)
- Directus — [Blog](https://directus.io/blog) · [Issues](https://github.com/directus/directus/issues)
- Payload — [Blog](https://payloadcms.com/blog) · [Issues](https://github.com/payloadcms/payload/issues)
- Sanity — [Blog](https://www.sanity.io/blog) · [Issues](https://github.com/sanity-io/sanity/issues)
- Ghost — [Resources](https://ghost.org/resources/) · [Issues](https://github.com/TryGhost/Ghost/issues)
- KeystoneJS — [Blog](https://keystonejs.com/blog) · [Issues](https://github.com/keystonejs/keystone/issues)
- TinaCMS — [Blog](https://tina.io/blog) · [Issues](https://github.com/tinacms/tinacms/issues)
- Decap CMS — [Blog](https://decapcms.org/blog/) · [Issues](https://github.com/decaporg/decap-cms/issues)
- Builder.io — [Blog](https://www.builder.io/blog) · [Issues](https://github.com/BuilderIO/builder/issues)
- Medusa — [Blog](https://medusajs.com/blog) · [Issues](https://github.com/medusajs/medusa/issues)

*Generated automatically on 2026-07-11.*
