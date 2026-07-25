# Headless CMS Daily Digest — 2026-07-10 (blog + issues refresh)

> Scheduled watch over 10 popular headless CMS projects. This run pulls signals from **each project's official blog** (fetched directly this run) **and** its **GitHub open-issue tracker** (fetched directly). The earlier 2026-07-10 pass leaned on WebSearch for release/CVE context but did **not** read the blogs; this refresh adds real, dated blog/release announcements for all 10 and reconciles several previously-uncertain version claims.
>
> **Legend:** 🐛 bug/fix · ✨ feature/enhancement · 🔒 security · 📝 docs · 🧰 tooling/CI · 🤖 AI/MCP · ⚠️ upgrade caution · 📰 blog/release post

---

## 🔁 Re-run verification — 2026-07-10 21:28 (+07)

A later scheduled pass re-fetched all 10 GitHub issue trackers directly. **No change since the 21:24 run** — every tracker returned the identical newest issues (same IDs, titles, and open dates as recorded below). Release/blog context was re-checked via search and is consistent with what's captured in each section. Freshest tracker items remain **TinaCMS #7169 (Jul 7)** and **Decap #7875 path-traversal (Jul 5)**. Nothing new to action; this stamp confirms the digest below is still current.

---

## Summary of the day

- **📰 The whole field is racing to be "agent-native."** Every actively-blogging project's newest posts are about AI/MCP/agents rather than classic CMS features: Payload previewing **4.0** (Admin UI redesign + TanStack + MCP), Strapi shipping a **built-in MCP server** (v5.47.0) and AI "self-healing docs," Directus **native MCP** + AI Assistant GA, Sanity's entire blog now agent-ops, Builder pivoting to agentic dev tooling, Medusa shipping agent tools + MCP.
- **🆕 Freshest blog items:** Medusa **Layout Composer** (Jul 1), Builder **"Building Without the Handoffs"** (Jun 29), Sanity **"Skills…written down for agents"** (Jun 22), Strapi **MCP-server plugin extension guide** (Jun 13), Sanity **Studio v6** (Jun 9), Payload **4.0 early look** (Jun 9).
- **✅ Version reconciliations (from blogs this run):**
  - **Directus v12 is real** — confirmed by the Apr 22 blog "Evolving Our License for Long-Term Sustainability (v12 license change)." The prior digest flagged "v12" as unverified; the blog resolves it (license/versioning change on the v11.17 → v12 line).
  - **Payload 4.0** is officially in preview (Jun 9 blog) — Admin UI redesign, TanStack Query/Router, first-class MCP.
  - **Sanity Studio v6** confirmed via the Jun 9 product blog (Vite 8, 2–9× faster builds, drops Node 20).
- **😴 Two blogs are stale:** **KeystoneJS** (newest post Aug 7 2024) and **TinaCMS** (newest post Nov 26 2025) — for these, the GitHub tracker is the only fresh signal.
- **🔒 Security carryover (unchanged from earlier 07-10 pass, search-derived):** Ghost CVE-2026-26980 (exploited in wild → 6.19.1) remains the most urgent operationally; Payload CVE-2026-25544 (9.8 SQLi → v3.73.0) and TinaCMS CVE-2026-28792 (9.7 dev-machine RCE → CLI 2.1.8) the highest-severity. No new CVEs surfaced today.

### Changes since last run (earlier 2026-07-10 pass → this refresh)
- 📰🆕 **Blog layer added for all 10 projects** — the prior pass had issue trackers + CVE search only. This run adds dated release/feature posts (see each section's "Blog" block).
- ✅ **"Directus v12" upgraded from [Unverified] → confirmed** via the Apr 22 license-change blog post.
- 🆕 **Payload 4.0 roadmap captured** (Jun 9 blog) — not present in prior digests.
- 🆕 **Medusa Layout Composer (Jul 1)** is the single newest announcement across all 10 blogs.
- 🔁 **Strapi MCP detail sharpened:** built-in MCP server shipped in **v5.47.0** (May 28 blog), plus a Jun 13 guide on extending it via plugins.
- ➖ **GitHub issue trackers unchanged** since the 15:08 run today (same IDs/titles/dates) — no new issues to report there.

---

## 1. Strapi — `strapi/strapi`

**📰 Blog (strapi.io/blog):**
- 📝🤖 **"How To Extend Strapi's MCP Server With Custom Tools via a Plugin"** — Jun 13, 2026. Register/build custom agent tools through a plugin.
- 📝🤖 **"Building Docs for the AI Era, Part 1: Self-Healing Docs"** — Jun 11, 2026. AI + GitHub Actions auto-detect doc gaps and keep docs aligned with code.
- 📝 **"Migrate from Contentful to Strapi Using a Claude Code Skill"** — Jun 4, 2026. Auto-generate content types, migrate assets, convert rich text.
- ✨🤖 **"The Strapi MCP server is out"** — May 28, 2026. **v5.47.0** ships a built-in MCP server exposing content types as agent-callable tools, scoped by admin-token permissions; free/self-hosted.
- 📝 Better Auth tutorial for **Strapi v5 + Next.js 16** (May 21); "Strapi for AI SaaS" backend guide (May 18).
- Banner references a Jan–Feb 2026 release roundup.

**🐛 Notable open issues (tracker, 396 open; newest visible #26524, Jun 2):**
- 🔒⚠️ **#26494 — No rate limiting on `register-admin` + race condition** (security, Priority: Urgent, critical, core:admin, v5). May 30.
- 🐛 **#26434 / #26396 — Content Manager crashes** ("undefined reading 'attributes'"/"'list'") navigating Single Types (Urgent, critical, core:content-manager, v5).
- 🐛 **#26487 — Direct/hard-refresh of collections-list URL → 500** (high, core:admin). May 29.
- 🐛 **#26387 — Replace-media updates metadata but keeps original file** (high, core:upload, confirmed). May 19.
- 🐛 **#26468 — Wildcard chars in filters not escaped** (medium, core:database). May 28.
- 🧰 **#26492 — Nightly npm release runs no tests** (high, tooling) — supply-chain risk. May 30.

## 2. Directus — `directus/directus`

**📰 Blog (directus.io/blog):**
- 📰⚠️ **"Evolving Our License for Long-Term Sustainability" (v12 license change)** — Apr 22, 2026. **Confirms a v12 line** and a licensing change; review before upgrading.
- ✨ **v11.17 — Background Imports, Netlify Deployments, Translations Generator** — Apr 10, 2026.
- ✨🤖 **v11.16 — Global Draft Versions, Multimodal AI, smarter deployments** — Mar 10, 2026.
- ✨🤖 **v11.15 — Native Collaborative Editing + AI Assistant GA + one-click deployments** — Feb 12, 2026.
- 🤖 **v11.13 — Native MCP support + content comparison** (Nov 7 2025) — the origin of Directus's "collaborative CMS + MCP" positioning.

**🐛 Notable open issues (326 open; newest visible #27129, Apr 15):**
- 🤖🐛 **#27039 — [MCP] files-tool `update` fails:** `data` typed as array but API expects an object. Apr 3.
- 🐛⚠️ **#27091 — "Save as copy" throws** (Assets/Files, High Impact, Regression, Studio). Apr 10.
- 🐛 **#27003 — Aliased GraphQL relational objects in a fragment return null** (Regression, Enterprise). Mar 30.
- 🐛 **#27124 — `GET /permissions/me` → 500 when a non-admin policy has `directus_flows:trigger`.** Apr 15.
- 🐛 **#27042 / #27028 — WYSIWYG** not rendering on revisit as non-admin (v11.16.1); inaccessible in macOS Safari w/ trackpad.
- 🧰⚠️ **#27094 — `@directus/api` on stale `tsdown`/`openid-client`** (auth-relevant). Apr 11.

## 3. Payload CMS — `payloadcms/payload`

**📰 Blog (payloadcms.com/blog):**
- 📰✨🤖 **"An early look at Payload 4.0: Admin UI Redesign, TanStack, MCP, and More"** — Jun 9, 2026. Major next-major preview.
- 🔒 **"Critical Security Notice Affecting React 19 and Next.js"** — Dec 4, 2025.
- ✨ **"Deploy Payload onto Cloudflare in a single click"** — Oct 3, 2025.
- 📰 **"Payload is joining Figma!"** — Jun 17, 2025 (site banner still active).

**🐛 Notable open issues (288 open; newest visible #16286–16288, Apr 15 — heavy Next.js 16.2.x theme):**
- 🤖🐛 **#16214 — [MCP Plugin] create/update tools emit `{ type: 'null' }` for nullable relationship fields.** Apr 8.
- 🐛⚠️ **#16286 — `plugin-multi-tenant` → 404 with Next.js 16.2.3 + Turbopack**; **#16288 — `suppressHydrationWarning` broken after Next 16.2.\*** upgrade. Apr 15.
- 🐛 **#16283 — Date field `timezone:true` writes empty string to `_tz` Postgres enum → invalid-enum error.** Apr 15.
- 🐛 **#16256 — `vercelPostgresAdapter` fails on large queries (68KB+ SQL, 30+ lateral joins).** Apr 12.
- 🐛 **#16273 / #16262 — Lexical rich-text** editing bugs (custom block drawer; unexported `INSERT_UPLOAD_WITH_DRAWER_COMMAND`).

## 4. Sanity — `sanity-io/sanity`

**📰 Blog (sanity.io/blog):**
- 📰 **"Agents leave receipts. We read 1.46 million of them"** — Jun 15, 2026. AI content-operations analysis.
- 🤖 **"Skills are how your company works, written down for agents"** — Jun 22, 2026.
- ✨⚠️ **"Sanity Studio v6: A focused upgrade"** — Jun 9, 2026. Vite 8, **2–9× faster builds**, better default search + custom auth, **drops end-of-life Node 20**.
- 📰 **"What's New — June 2026"** — Jun 8, 2026. Prompt-to-hosted-Studio, Content Agent on Slack Marketplace, more.

**🐛 Notable open issues (75 open — small backlog; newest visible #12870, May 24):**
- 🔒🐛 **#12794 — Presentation tool writes `sanity.previewUrlSecret` to the wrong dataset** in multi-workspace hosted Studio. Apr 16.
- 🐛 **#12733 — Signup rejects a strong password as "too weak"** (identity). Apr 22.
- 🐛 **#12870 — Image upload silently stalls when file has no extension** (no error shown). May 24.
- 🐛 **#12806 — Safari: Presentation tool "Unable to connect"** (cross-origin iframe sandboxing). Apr 5.
- ✨ **#12812 — Preserve/add IPTC metadata on photo upload**; **#12787 — multiple `typegen` configs** (CLI).

## 5. Ghost — `TryGhost/Ghost`

**📰 Blog/changelog:** The public `ghost.org/resources` library is evergreen guides (no dated release posts); the changelog lives at ghost.org/changelog. Site meta reports **Ghost 6.46** as the current generator this run. Dated changelog entries were not retrievable in this pass.

**🔒 Security (search-derived, carryover — most urgent operationally):**
- **CVE-2026-26980 — Content-API SQLi (CVSS 9.4), actively exploited** (~700+ sites hijacked for "ClickFix"); affects 3.24.0–6.19.0; **patched 6.19.1**.
- **CVE-2026-29053 — RCE via malicious themes**; patched **6.19.1**. Upgrade to ≥6.19.1.

**🐛 Notable open issues (63 open; newest visible #27717, May 6):**
- 🔒✨ **#27445 — Optional malware scanning for uploaded files (pompelmi)** (needs:triage). Apr 17.
- 🐛 **#26677 — Admin API always saves revisions even when `save_revision=false`.** Mar 3.
- 🐛 **#27415 — Share button broken because `portal.min.js` not loaded when subscriptions disabled.** Apr 15.
- 🤖 **#26644 — [aw] No-Op Runs** (agentic-workflows). Mar 2.
- 📌 Pinned: ⚠️ #23924 (Breaking Changes for 6.0), 🌐 #23361 (i18n mega-issue).

## 6. KeystoneJS — `keystonejs/keystone`

**📰 Blog (keystonejs.com/blog):** 😴 **Stale** — newest post is **"A year of releases in review" (Aug 7, 2024)**. No 2026 blog activity; rely on GitHub Releases for signal.

**🐛 Notable open issues (100 open; newest visible #9798, Apr 3 — low-velocity tracker):**
- 🔒✨ **#9789 — Enforce GraphQL query-depth limits by default?** (DoS hardening). Mar 18.
- 🧰⚠️ **#9798 — Bump Next to >15.5.13** (dependencies). Apr 3.
- 🐛🔒 **#9785 — `statelessSessions` uses unsupported `Authorization: Basic` header instead of the cookie.** Mar 6.
- 🐛🔒 **#9753 — Access-operation function called with no session during a successful login.** Dec 18, 2025.
- 🐛🔒 **#9665 — Field editable when `graphql.omit.update` is set** (access-control gap). Jul 22, 2025.

**Release context (search-derived):** latest **@keystone-6/core@6.5.2** (Mar 19, 2026); CVE-2026-33326 (`isFilterable` bypass via `cursor`) fixed in 6.5.2.

## 7. TinaCMS — `tinacms/tinacms`

**📰 Blog (tina.io/blog):** 😴 **Somewhat stale** — newest post **"Modernizing the Core for Security and Performance" (ESM migration), Nov 26, 2025**; then TinaDocs (Nov 17 2025), Markdown Editor upgrades (Sep 23 2025), React 19 support (May 11 2025). No 2026 blog posts — the tracker is the live signal.

**🐛 Notable open issues (378 open; newest visible #7169, Jul 7 — freshest tracker this run; issue creation restricted):**
- 🐛🔒 **#7134 — Reference fields fully hydrate on every keystroke in visual editing, silently exceeding the 1MB preview-overlay cap (no error).** Jul 1.
- 🐛 **#7148 — Folder collection with `create:false`+`delete:false` is unnavigable.** Jul 4.
- 🐛 **#7116 — Save button stays enabled after a successful save** (duplicate-save risk, v4). Jun 30.
- 🐛 **#7096 — Enter inserts a line break at wrong position, corrupts bullet lists.** Jun 25.
- 🐛🧰 **#7162 / #7109 — Starter templates fail** (basic/yarn/Node 22; astro/npm/Node 24).
- ✨ **#7169 — Rich-text: semantic `<thead>`/`<th>` for markdown tables**; **#7075 — support markdown plugins.**

**Release/security context (search-derived):** CVE-2026-28792 (9.7, dev-server CORS+path-traversal → CLI 2.1.8); CVE-2026-54074 (CLI RCE via Forestry migration → 2.4.3); CVE-2026-55661 (rich-text stored XSS → 3.9.3). Keep CLI ≥2.4.3, rich-text ≥3.9.3.

## 8. Decap CMS — `decaporg/decap-cms`

**📰 Blog (decapcms.org/blog):**
- 📰✨ **"Announcing Decap Turbo"** — May 5, 2026. New **SaaS upgrade** for teams: CMS performance, centralized auth, granular permissions; early access open.
- ✨⚠️ **"Richtext Widget Replaces the Markdown Widget"** — Apr 16, 2026. New richtext widget on Plate editor; **markdown widget deprecated** (still available, unmaintained).
- 🧰 Website migrated Gatsby → Hugo (Oct 6, 2025).

**🐛 Notable open issues (559 open; newest visible #7875, Jul 5 — current):**
- 🔒🐛 **#7875 — Path traversal in `decap-server` proxy** allows read/write/delete outside the configured repo root. Jul 5. Highest-signal; not yet a published CVE.
- 🐛⚠️ **#7873 — Images not rendered in preview starting from v3.13.0** (regression). Jun 29.
- 🐛 **#7871 / #7870 / #7869 / #7868 — React crashes** (`undefined 'path'`; `removeChild`; `destructure 'url'` ×2). Jun 28–29.
- 🐛 **#7867 — Can't log in with Forgejo (missing secret).** Jun 25.
- 🐛 **#7816 / #7802 / #7800 — Rich-text/UX** (soft line breaks; paste; preview-pane scroll after resize).

## 9. Builder.io — `BuilderIO/builder`

**📰 Blog (builder.io/blog):** Now almost entirely agentic-dev content.
- 📰 **"Building Without the Handoffs"** — Jun 29, 2026 (Headless CMS + Governance/Security).
- ✨ **"Introducing Clips: an open-source, agent-native Loom alternative"** — Jun 26, 2026.
- 🤖 **"Introducing /visual-plan: Scannable Claude Code plans"** — Jun 24, 2026.
- 📰 "Building in the Age of Collaborative Coding" (Jun 22), "How to Make AI Agents Follow Your Design System" (Jun 15).

**🐛 Notable open issues (62 open; newest visible #4501, Apr 4 — low-velocity tracker):**
- 🔒 **#4501 — Cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346).** Apr 4. Top security item; no formal advisory yet.
- 🔒🐛 **#4212 — `eval` for server-code detection throws a CSP error.** Dec 15, 2025.
- 🐛⚠️ **#4137 — `@builder.io/react` fails to install on Node.js 24+ (C++20 requirement).** Aug 30, 2025.
- 🐛 **#4191 / #4166 — Qwik:** EnableEditor state merging breaks block reactivity; stored state extremely wasteful.
- 🧰 **#4164 — Storybook 10 support.** Oct 20, 2025.

## 10. Medusa — `medusajs/medusa`

**📰 Blog (medusajs.com/blog):**
- 📰✨ **"Announcing new Layout Composer in Medusa Admin"** — Jul 1, 2026 (Product). **Newest blog item across all 10 projects this run.** Also note site's dedicated "Agent tools" nav (Medusa MCP, Cloud CLI, Agent Skills, dev agent).

**🐛 Notable open issues (111 open; newest visible #15406, May 14 — ⚠️ snapshot may lag ~2 months):**
- 🐛🔒 **#15306 — Refund workflow reports success after partial refund failures** (silent failure in `refundPaymentsStep`). May 6. Money-path bug — high impact.
- 🐛 **#15360 — Race condition in cart promotions creates duplicate line-item adjustments** (v2.0). May 11.
- 🐛 **#15399 — `/store/products` → 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled** (v2.0). May 14. Storefront-breaking.
- 🐛⚠️ **#15398 — `@medusajs/icons` peer-dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → ERESOLVE.** May 13.
- 🐛 **#15300 — `medusa db:migrate` exit code** (CI impact); **#15341 — build silently excludes any path containing "test".**

**Release/security context (search-derived):** latest **v2.16.0** bumps MikroORM → 6.6.14 (CVE-2026-44680; default apps unaffected). Open **#14993** reports 15 HIGH transitive CVEs on 2.13.1 (supply-chain concern for older installs).

---

## Cross-cutting themes today

- **📰 Agent-native is the entire narrative.** Across blogs, new features are MCP servers, AI assistants, agent skills, and agentic dev tooling — not traditional CMS capabilities. Directly relevant to LumiBase's own governed-agent / MCP surface (see CLAUDE.md).
- **🤖 Same MCP defect shape in two projects:** Directus #27039 and Payload #16214 both fail on update-operation JSON-schema generation for nullable/complex fields — a pattern worth checking in any MCP-enabled CMS, including LumiBase.
- **🐛 Rich-text remains the universal cost center:** open editor bugs in Tina, Decap, Payload, Sanity; Decap is mid-migration off its markdown widget to a Plate-based richtext widget.
- **⚠️ Modern-Node/React churn breaks installs everywhere:** Payload's Next.js 16.2.x cluster, Medusa's React 18/19 peer-dep conflict, Builder's Node 24 break, Keystone's Next bump, Sanity dropping Node 20 in Studio v6.
- **Data caveat:** Blog + GitHub issue data is live/confirmed this run. CVE/version claims are **search-derived** (carried from earlier pass) and labeled. Ghost changelog dates and Decap/Builder exact "latest version" remain **[Unverified]**.

---

## Sources

Blogs (fetched directly this run):
- [Strapi](https://strapi.io/blog) · [Directus](https://directus.io/blog) · [Payload](https://payloadcms.com/blog) · [Sanity](https://www.sanity.io/blog) · [Ghost resources](https://ghost.org/resources/) · [KeystoneJS](https://keystonejs.com/blog) · [TinaCMS](https://tina.io/blog) · [Decap](https://decapcms.org/blog/) · [Builder.io](https://www.builder.io/blog) · [Medusa](https://medusajs.com/blog)

Issue trackers (fetched directly this run):
- [strapi/strapi](https://github.com/strapi/strapi/issues) · [directus/directus](https://github.com/directus/directus/issues) · [payloadcms/payload](https://github.com/payloadcms/payload/issues) · [sanity-io/sanity](https://github.com/sanity-io/sanity/issues) · [TryGhost/Ghost](https://github.com/TryGhost/Ghost/issues) · [keystonejs/keystone](https://github.com/keystonejs/keystone/issues) · [tinacms/tinacms](https://github.com/tinacms/tinacms/issues) · [decaporg/decap-cms](https://github.com/decaporg/decap-cms/issues) · [BuilderIO/builder](https://github.com/BuilderIO/builder/issues) · [medusajs/medusa](https://github.com/medusajs/medusa/issues)

Release/security context (search-derived, carried from earlier 2026-07-10 pass) — see that pass for the full CVE reference list.
