# Headless CMS — Daily Digest

**Run date:** 2026-07-11 (Saturday) · **Sources:** GitHub Issues (all 10 repos) + official blogs (Strapi, Payload, Directus, Sanity, Medusa)

> **Method note (unverified data caveats):** GitHub issue lists were captured from each repo's default **open-issues** view (newest first). "Recent activity" here means the most recently *opened* open issues visible without authentication — not a strict last-24h delta, since the anonymous GitHub view does not expose an accurate updated-within-1-day filter. Blog entries are the latest posts listed on each vendor's blog index. Five vendor blogs (Ghost, KeystoneJS, TinaCMS, Decap, Builder.io) are client-rendered or were not fetchable this run; their sections rely on GitHub-issue signal only and are labeled `[blog not captured]`.

---

## TL;DR — cross-project themes

- **AI / MCP is the dominant product theme.** Strapi MCP server hit **GA** (Jun 29), Sanity shipped Content Agent + Agent API + Studio v6, Directus added OAuth 2.1 for MCP, Payload 4.0 preview features MCP, and both Directus and Payload have open MCP-tool bugs.
- **Security items surfaced across three repos:** a **critical** path-traversal in Decap's `decap-server` proxy (#7875), a Strapi `register-admin` rate-limit/race issue marked **Urgent/critical** (#26494), a Builder.io postMessage cross-origin code-execution report (#4501), and Strapi published a batch of CVE disclosures (May 13).
- **Framework-version churn is generating bugs:** Next.js 16.2.x (Payload), Node 22/24 (TinaCMS, Builder.io, Keystone), React 18↔19 peer-dep conflicts (Medusa).

---

## 1. Strapi
Blog: https://strapi.io/blog · Issues: https://github.com/strapi/strapi/issues (72.3k★, 396 open)

**Blog / releases**
- **The Strapi MCP server is now GA** (Jun 29) — stable surface to wire agents to Strapi content. https://strapi.io/blog/the-strapi-mcp-server-is-now-ga
- June Community Call recap (Jun 29); **release roundup Mar–Jun 2026** (Jun 18). https://strapi.io/blog/strapi-release-roundup-everything-that-changed-between-march-and-june-2026
- Security disclosure: CVE-2025-64526, CVE-2026-22599, CVE-2026-22706, CVE-2026-22707, CVE-2026-27886 (May 13). https://strapi.io/blog/security-disclosure-of-vulnerabilities-cve-2025-64526-cve-2026-22599-cve-2026-22706-cve-2026-22707-and-cve-2026-27886

**Notable open issues (bugs/security)**
- 🔴 **Security** `#26494` — no rate limiting on `register-admin` + race condition (Priority: Urgent, severity: critical). https://github.com/strapi/strapi/issues/26494
- 🔴 `#26434` — Content Manager crash "Cannot read properties of undefined (reading 'attributes')" navigating Single Types (Urgent/critical). https://github.com/strapi/strapi/issues/26434
- `#26387` — Replace-media updates metadata but keeps original file content (confirmed, high). https://github.com/strapi/strapi/issues/26387
- `#26524` — `firstPublishedAt`: entry falsely marked modified after first publish. https://github.com/strapi/strapi/issues/26524
- `#26492` / `#26490` — CI: nightly release publishes to npm without tests; missing DB healthchecks in test compose.

## 2. Directus
Blog: https://directus.io/blog · Issues: https://github.com/directus/directus/issues (34.8k★, 326 open)

**Blog / releases**
- **"A Backend for Everyone on Your Team"** (May 26) — native draft & publishing workflows, redesigned Studio, AI-assisted translations, JSON filtering, **OAuth 2.1 for MCP**.
- "AI is straining vulnerability disclosure for maintainers" (Jul 10); moving to a hardened Docker image (Jun 29); "Best Headless CMS in 2026" (Jun 16).

**Notable open issues (bugs)**
- `#27091` — "Save as copy" throws error (High Impact, **Regression**, Studio). https://github.com/directus/directus/issues/27091
- `#27039` — **[MCP]** files-tool update fails: schema typed as array but API expects object (High Impact). https://github.com/directus/directus/issues/27039
- `#27042` — WYSIWYG not rendering after returning to a record as non-admin user (v11.16.1, High Impact).
- `#27003` — Aliased GraphQL relational objects in a fragment return null (Regression, Enterprise).
- `#27124` — `GET /permissions/me` returns 500 when non-admin policy has `directus_flows:trigger`.

## 3. Payload CMS
Blog: https://payloadcms.com/blog · Issues: https://github.com/payloadcms/payload/issues (41.8k★, 288 open)

**Blog / releases**
- **An early look at Payload 4.0** (Jun 9) — Admin UI redesign, TanStack, **MCP**, and more. https://payloadcms.com/posts/blog/payload-40-admin-ui-redesign-tanstack-mcp-and-more
- Prior: Critical security notice affecting React 19 & Next.js (Dec 4, 2025); one-click Cloudflare deploy (Oct 3, 2025). (Payload is now part of Figma.)

**Notable open issues (bugs)**
- `#16286` — `plugin-multi-tenant` causes 404 with Next.js 16.2.3 + Turbopack. https://github.com/payloadcms/payload/issues/16286
- `#16288` — `suppressHydrationWarning` broken after Next upgrade to 16.2.x.
- `#16283` — Date field `timezone:true` writes empty string to Postgres `_tz` enum → invalid enum input.
- `#16273` / `#16262` — Lexical rich-text: malfunctioning editing in custom block drawer; `INSERT_UPLOAD_WITH_DRAWER_COMMAND` not publicly exported.
- `#16214` — **[MCP Plugin]** create/update tools produce `{ type: 'null' }` for nullable relationship fields.

## 4. Sanity
Blog: https://www.sanity.io/blog · Issues: https://github.com/sanity-io/sanity/issues (6.1k★, 75 open)

**Blog / releases**
- **Sanity Studio v6: A focused upgrade** (Jun 9) — builds 2–9× faster on Vite 8, better default search & custom auth, drops end-of-life Node 20. https://www.sanity.io/blog/sanity-studio-v6
- "What's New – June 2026" (Jun 8) — prompt-to-hosted-Studio in one chat, Content Agent on Slack Marketplace.
- Heavy agent/AI focus: "We don't write code anymore" (Jun 12), "Skills … written down for agents" (Jun 22).

**Notable open issues (bugs/features)**
- `#12870` — Image upload silently stalls when file has no extension (no error shown). https://github.com/sanity-io/sanity/issues/12870
- `#12835` — Cannot revert to default ordering/layout after manual selection.
- `#12794` — Presentation tool writes `previewUrlSecret` to wrong dataset in multi-workspace hosted Studio.
- ✨ Features: preserve/add IPTC metadata on upload (`#12812`); multiple `typegen` configs (`#12787`); document language in edit-intent params (`#12834`).

## 5. Ghost `[blog not captured]`
Resources: https://ghost.org/resources/ · Issues: https://github.com/TryGhost/Ghost/issues (52.8k★, 63 open)

**Notable open issues** (context: **Ghost 6.0** breaking-changes tracker `#23924`; i18n mega-issue `#23361`)
- `#26677` — 🐛 Admin API always saves revisions even when `save_revision=false`. https://github.com/TryGhost/Ghost/issues/26677
- `#27415` — Share button broken: `portal.min.js` not loaded when subscriptions disabled.
- `#27445` — Security: proposal to add optional malware scanning for uploaded files.
- `#26399` — Unhandled `JSON.parse()` in Portal crashes widget on malformed preview URLs.
- Features: excerpt length to 2000 chars (`#27478`); document HelmForge Kubernetes install option (`#27717`).

## 6. KeystoneJS `[blog not captured]`
Blog: https://keystonejs.com/blog · Issues: https://github.com/keystonejs/keystone/issues (9.9k★, 100 open)

**Notable open issues**
- `#9789` — Should Keystone enforce **GraphQL query-depth limits** by default? (Feature/security). https://github.com/keystonejs/keystone/issues/9789
- `#9798` — Bump Next to >15.5.13 (dependencies).
- `#9665` — Field editable when `graphql.omit.update` is set (Bug, help wanted).
- `#9785` — `statelessSessions` tries unsupported `Authorization: Basic` header instead of cookie.
- `#9657` — JSON fields + SQLite has no Prisma default (Bug).

## 7. TinaCMS `[blog not captured]`
Blog: https://tina.io/blog · Issues: https://github.com/tinacms/tinacms/issues (13.6k★, 378 open)

**Notable open issues** (active v4 development)
- `#7148` — Folder collection with `create:false`+`delete:false` is unnavigable (single-doc auto-open misfires). https://github.com/tinacms/tinacms/issues/7148
- `#7134` — Reference fields fully hydrate on every keystroke, silently exceeding 1MB preview-overlay cap with no error.
- `#7116` — Save button stays enabled after successful save (v4).
- `#7096` — Enter key inserts line break at wrong position, corrupts bullet-list formatting.
- ✨ Features: semantic `<thead>/<th>` for markdown tables (`#7169`); better-auth plugin (`#7092`); markdown-plugin support (`#7075`); split `tinacms build` codegen from deploy gate (`#7068`).

## 8. Decap CMS `[blog not captured]`
Blog: https://decapcms.org/blog/ · Issues: https://github.com/decaporg/decap-cms/issues (19.2k★, 559 open)

**Notable open issues**
- 🔴 **Security `#7875`** — Path traversal in `decap-server` proxy allows read/write/delete of files outside the repo root. https://github.com/decaporg/decap-cms/issues/7875
- `#7873` — Images not rendered in preview since v3.13.0.
- `#7867` — Impossible to log in with Forgejo (missing secret).
- `#7816` / `#7802` — New richtext widget: soft line breaks; can't copy-paste into rich text.
- Feature: support open authoring for GitLab (`#7823`).

## 9. Builder.io `[blog not captured]`
Blog: https://www.builder.io/blog · Issues: https://github.com/BuilderIO/builder/issues (8.8k★, 62 open)

**Notable open issues**
- 🔴 **Security `#4501`** — Cross-origin code execution via unvalidated `postMessage` in builder-block (CWE-346). https://github.com/BuilderIO/builder/issues/4501
- `#4137` — `@builder.io/react` fails to install on Node.js 24+ (C++20 compile requirement).
- `#4212` — Using `eval` to detect server code throws CSP error.
- `#4191` / `#4166` — Qwik: EnableEditor state merging breaks block reactivity; stored state very wasteful.
- Feature: prevent duplicate component names at registration (`#4220`); Storybook 10 support (`#4164`).

## 10. Medusa (commerce)
Blog: https://medusajs.com/blog · Issues: https://github.com/medusajs/medusa/issues (33k★, 111 open)

**Blog / releases**
- **New Layout Composer in Medusa Admin** (Jul 1). https://medusajs.com/blog/announcing-layout-composer/

**Notable open issues (bugs, v2.0)**
- `#15399` — `/store/products` returns 500 for any `category_id`/`tag_id` filter when `index_engine` flag enabled. https://github.com/medusajs/medusa/issues/15399
- `#15360` — Race condition in cart promotions can create duplicate line-item adjustments.
- `#15306` — Refund workflow can report success after partial refund failures (silent failure in `refundPaymentsStep`).
- `#15398` — `@medusajs/icons` peer-dep React ^19.2.5 conflicts with dashboard/ui (React ^18.3.1) → npm ERESOLVE.
- `#15321` — `db:sync-links` generates invalid Postgres schema-qualified `RENAME TO`.
- Good-first-issues: order sorting by total/fulfillment/payment status (`#15353`); build excludes any path containing "test" (`#15341`).

---

*Generated automatically by the scheduled "check-cms" task. Verify individual issue status by clicking through, as anonymous GitHub views may lag live state.*
