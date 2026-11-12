# Competitor feature inventory (July 2026 watch) → LumiBase epics

Source: 45 daily digests in `cms-daily-updates/`, `cms-daily-digest/`, `cms-watch/`,
`headless-cms-daily-2026-07-11.md`, `cms-daily-digest-2026-07-11.md` (10 CMS tracked:
Strapi, Directus, Payload, Sanity, Ghost, KeystoneJS, TinaCMS, Decap, Builder.io, Medusa).
Read in full on 2026-11-09; deduplicated. Markers follow the digests: **V** = vendor blog /
issue fetched live, **U** = digest marked `[Unverified]`, **I** = capability inferred from a bug
or feature request. LumiBase status checked against the tree at v1.0.1.

Status legend: ✅ have · 🟡 partial · ❌ missing · ➖ not applicable (licensing, vendor-internal
tooling, commerce core).

## 1. Full feature list by category

### 1.1 AI / Agents

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| A1 | Built-in MCP server exposing content as tools, scoped by token permissions (GA) | Strapi, Directus, Payload, Sanity, Medusa | V | ✅ governed `/api/v1/mcp` + stdio server | — |
| A2 | OAuth 2.1 for MCP clients | Directus | V | ❌ | #346 (exists) |
| A3 | Extend MCP with custom tools from plugins (`defineTool/defineResource/definePrompt`) | Strapi | V/U | ❌ extensions cannot register MCP tools | E5-A07 |
| A4 | MCP create/update tool schemas generated from collections (nullable relations defect class) | Payload, Directus | I | 🟡 105 tools, no schema-fidelity suite | E5-A08 |
| A5 | In-Studio AI Assistant GA, multimodal (images/PDF), multi-provider, "Ask User" clarification tool | Directus | V/U | 🟡 Copilot is text-only, no clarification tool | E5-A01, A02 |
| A6 | Content Agent reachable from Dashboard, Slack, API (@-mention) | Sanity | V | ❌ | E5-A03 |
| A7 | Prompt-to-hosted-Studio in one chat; agents that know your users | Sanity | V | ❌ | E5-A03 (scope note) |
| A8 | Skills platform: company practices written down for agents, `skills install` CLI | Sanity, Medusa, Strapi (Claude Code skill) | V/U | 🟡 skill registry is code-defined, not site-authored | E5-A04 |
| A9 | Agent receipts / provenance analytics (1.46M receipts) | Sanity | V | 🟡 trust ledger + audit exist, no analytics view | E5-A05 |
| A10 | AI-assisted translations; translations generator (~10 s full locale scaffold) | Directus | V/U | 🟡 MT providers + TM exist, no one-shot generator | E5-A06 |
| A11 | Migration via AI skill (Contentful → Strapi: types, assets, rich text) | Strapi | V | ❌ | E7-I03 |
| A12 | Self-healing docs (AI + CI detect doc gaps) | Strapi | V | 🟡 `docs:i18n:verify` checks claims | E11-X05 |
| A13 | AI message bubble in admin; "Fix with AI" dev agent | Medusa | I/V | ➖ dev tooling | — |
| A14 | Agentic coding platform (Builder 2.0 / Fusion), Clips, `/visual-plan`, design-system-aware agents | Builder.io | V/U | ➖ not CMS scope; design-system guidance → E11-X07 | — |
| A15 | Repo agentic workflows (`[aw]` runs) | Ghost | V | ➖ internal | — |
| A16 | "Vibe blogging" with Copilot | TinaCMS | V | ➖ | — |

### 1.2 Editorial workflow & collaboration

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| W1 | Native collaborative editing (multi-user, live) | Directus | V | ❌ (realtime WS exists) | E2-C01 |
| W2 | Real-time field presence indicators | Sanity | I | ❌ | E2-C01 |
| W3 | Content comparison / diff view | Directus | V | 🟡 version compare API, no revision diff UI | E2-C02 |
| W4 | Global Draft Versions: auto-draft per item, stage → preview → promote | Directus | V | ✅ content versions + releases | — |
| W5 | Native draft & publish workflows | Directus, Strapi | V | ✅ editorial gate | — |
| W6 | `firstPublishedAt` + "modified since publish" state | Strapi | I | ❌ | E2-C03 |
| W7 | `publicationFilter`: draft + published cohort in one query (REST/GraphQL, nested populate) | Strapi | U | ❌ | E2-C04 |
| W8 | Save as copy / duplicate item | Directus, Payload | I | ❌ | E2-C05 |
| W9 | Orderable (drag-sort) list views | Payload | I | ❌ | E2-C06 |
| W10 | Customisable dashboard widgets, "edit dashboard" mode | Payload | I | 🟡 Insights dashboards fixed | E2-C07 |
| W11 | Tabs interface for forms | Directus, Payload | U/I | ❌ | E10-M05 |
| W12 | Content Releases with validation errors jumping to field | Sanity | U | 🟡 releases exist, no field-jump | E2-C08 |
| W13 | Post revisions with `save_revision` opt-out flag | Ghost | I | 🟡 revisions always saved | E2-C09 |
| W14 | Per-list default ordering/layout memory | Sanity | I | ✅ presets/bookmarks | — |
| W15 | Back-to-collection breadcrumb; global collections open directly in form | TinaCMS | U | 🟡 | E2-C10 |
| W16 | Quick admin access for staff | Ghost | U | ✅ staff roles | — |
| W17 | Open authoring (fork-based external contributions) | Decap | V | ❌ | #362 child G-02 |
| W18 | Edit-intent routing (`canHandleIntent`) incl. document language | Sanity | V | ❌ | E11-X08 |
| W19 | Request-error overhaul ("Try again" instead of crash) | Sanity | U | 🟡 | E2-C10 |

### 1.3 Rich text & visual editing

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| R1 | Block-based rich text editor (Lexical) with custom block drawers, inline upload command | Payload | I | ❌ Studio has no rich-text editor (Monaco only) | E3-R01..R03 |
| R2 | Plate-based richtext widget replacing markdown widget | Decap | V | ❌ | E3 |
| R3 | Markdown plugins, semantic `<thead>/<th>` tables, `headingLevels` toolbar override | TinaCMS | V/U | ❌ | E3-R04, R05 |
| R4 | WYSIWYG interface | Directus | I | ❌ | E3 |
| R5 | Portable Text block editing | Sanity | U | ❌ | E3-R01 |
| R6 | Rich-text URL sanitisation | TinaCMS | U | n/a until editor | E3-R06 |
| R7 | Presentation tool / visual editing with per-dataset `previewUrlSecret`, cross-origin iframe | Sanity | I | ❌ content-preview spec unapproved | E1-V01, V02 |
| R8 | Visual editing with live reference hydration, 1 MB overlay cap | TinaCMS | I | ❌ | E1-V03 |
| R9 | Live preview pane, resizable divider, image preview | Decap | I | ❌ | E1-V02 |
| R10 | Visual editor iframe `postMessage` bridge (CWE-346 lesson) | Builder.io, TinaCMS | V/U | ❌ | E1-V03, V05 |
| R11 | Drag-and-drop page composition with A/B testing + personalisation (Publish) | Builder.io | U | 🟡 pages.layoutConfig, no builder | E1-V06, E12 |
| R12 | Admin Layout Composer | Medusa | V | ❌ | E2-C07 |
| R13 | Design-to-code (Figma → components), Payload inside Figma | Builder.io, Payload | V | ❌ | E11-X07 |

### 1.4 Content modeling

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| M1 | Geospatial point field + Map layout (PostGIS) | Directus, Sanity | I/U | ❌ | E10-M01 |
| M2 | Date field with `timezone: true`; timezone-aware display | Payload, Directus | I/U | ❌ | E10-M02 |
| M3 | Dynamic zones / polymorphic block lists | Strapi | I | 🟡 block templates, unclear polymorphism | E10-M03 |
| M4 | Hierarchy / folder-based collections with `create:false`/`delete:false`; single-doc auto-open | Payload 4.0, TinaCMS | U/I | 🟡 file folders only | E10-M04 |
| M5 | Single Types vs Collection Types | Strapi | I | ✅ | — |
| M6 | Multi-tenant plugin | Payload | I | ✅ native | — |
| M7 | Localized + required fields | Payload | U | ✅ | — |
| M8 | Non-clearable radio option | Sanity | V | ❌ | E10-M06 |
| M9 | Configurable excerpt length | Ghost | V | ❌ | E10-M06 |
| M10 | JSON field + SQLite default | Keystone | I | ➖ Postgres only | — |
| M11 | Document field | Keystone | U | → E3 | — |
| M12 | Relation lifecycle fixes on publish/discard (self-referential, hidden inverse) | Strapi | U | ✅ fk-dependent-records | — |
| M13 | Global Product Options | Medusa | U | ➖ commerce | E12 |

### 1.5 Media / assets

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| D1 | Folder-enabled upload collections + bulk upload | Payload | I | 🟡 folders table, no bulk UI | E4-D01, D02 |
| D2 | Replace media in place (keep id, swap file) | Strapi | I | ❌ | E4-D03 |
| D3 | TUS resumable uploads | Directus | U | ❌ | E4-D04 |
| D4 | Preserve original image metadata / IPTC | Sanity | V | ❌ | E4-D05 |
| D5 | Media library rename | TinaCMS | U | ❌ | E4-D06 |
| D6 | Branch-aware media | TinaCMS | U | ❌ | #362 child |
| D7 | Optional malware scanning for uploads | Ghost | V | ❌ (F2 future scope) | E4-D07 |
| D8 | `initiallySelectedAssets` in media picker | Strapi | U | ❌ | E4-D08 |
| D9 | DAM enhancements (Payload 4.0) | Payload | U | 🟡 image-transform DSL | E4 |
| D10 | Upload MIME validation bypass (CVE) | Strapi | U | ✅ policy; audit | E8-S11 |

### 1.6 API / integration / data

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| P1 | Optional OpenAPI spec route, config-gated | Strapi | U | 🟡 static `docs/openapi.yaml` | E9-H05 |
| P2 | JSON filtering / `json()` extractor | Directus | V | 🟡 json-field-search (cast deferred) | E7-I04 |
| P3 | Background imports (timeout, concurrency, progress) | Directus | V | 🟡 data-import sync | E7-I01 |
| P4 | Locale-aware CSV/JSON import/export with hooks | Payload | U | 🟡 | E7-I02 |
| P5 | Data export incl. alias fields | Directus | U | — | E7-I02 |
| P6 | Scheduled Functions | Sanity | V | ✅ flows scheduler | — |
| P7 | GROQ-powered access control | Sanity | V | ✅ policies | — |
| P8 | GraphQL fragments/aliases on relations | Directus | I | ✅ yoga | — |
| P9 | Content API `filter`/`order` params | Ghost | I | ✅ | — |
| P10 | Filter wildcard escaping; relational filter sanitisation | Strapi | I | ❓ audit | E8-S09 |
| P11 | Git backends: Forgejo, GitLab PKCE; separate content repo | Decap, TinaCMS | V | 🟡 GitHub/GitLab one-way | #362 children G-01, G-03 |
| P12 | Forms with SvelteKit remote functions | Directus | V | ❌ Svelte SDK | E11-X01 |
| P13 | Multi-framework SDKs (React, Vue 3, Qwik, Nuxt, Storybook) | Builder.io | I | 🟡 JS SDK + Next starter | E11-X01, X04 |
| P14 | Edge-runtime cache option on client | TinaCMS | U | ✅ delivery edge cache | — |
| P15 | Typegen multiple configs | Sanity | V | 🟡 single config | E11-X02 |
| P16 | Webhook-confirmed async payments | Medusa | U | ➖ | E12 |

### 1.7 Publishing, memberships, newsletter

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| N1 | Member tiers (free/paid/comped), Portal widget, subscriptions toggle | Ghost | I | 🟡 subscriber realm only | E6-N01, N02 |
| N2 | Email newsletters to members; per-member toggles | Ghost | I | ❌ (transactional email only) | E6-N03 |
| N3 | Automated multi-step email sequences (welcome flows) | Ghost | U | ❌ | E6-N04 |
| N4 | Signup card embed with i18n/per-card override | Ghost | V | ❌ | E6-N05 |
| N5 | Custom sending domain, all-CNAME, 2048-bit DKIM auto-rotation | Ghost | U | ❌ | E6-N06 |
| N6 | Self-updating saved member views/segments | Ghost | U | ❌ | E6-N07 |
| N7 | Social Web (ActivityPub) handle | Ghost | U | ❌ | E6-N08 |
| N8 | Reader comments | Ghost | I | ❌ | E6-N09 |
| N9 | Security history for members | Ghost | U | 🟡 audit | E8-S01 |

### 1.8 Security

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| S1 | Active device-session management in admin | Strapi | U | ❌ | E8-S01 |
| S2 | Security defaults baked into create-app templates | Strapi | U | 🟡 | E8-S02 |
| S3 | Admin registration endpoint rate limit + race | Strapi | V | 🟡 setup brake; verify first-admin | E8-S03 |
| S4 | Password-strength validation with helpful errors | Directus, Sanity | V/I | ❓ | E8-S04 |
| S5 | Hardened Docker image | Directus | V | 🟡 | E8-S05 |
| S6 | Passkeys / WebAuthn native | — (Tina better-auth) | V | 🟡 via Logto only | E8-S06 |
| S7 | Social login (Apple, Google) + account linking | Directus, Medusa | I/U | ❌ for subscribers | E8-S07 |
| S8 | Coordinated CVE disclosure programme; AI-report triage stance | Strapi, Directus | V | 🟡 SECURITY.md? | E8-S08 |
| S9 | GraphQL depth limit by default | Keystone | V | ✅ depth + cost | — |
| S10 | Field-level GraphQL omit / isFilterable bypass fixes | Keystone | I/U | ✅ field policies; audit | E8-S09 |
| S11 | Password reset revokes refresh sessions (CVE) | Strapi | U | ❓ audit | E8-S01 |
| S12 | Hardened postMessage, CSP | TinaCMS, Builder | U/I | → E1-V05 | — |
| S13 | Path traversal in local proxy (lesson) | Decap | V | ✅ no local proxy; SSRF guard | — |
| S14 | Stateless cookie sessions | Keystone | I | ✅ | — |
| S15 | Centralised auth + granular permissions SaaS (Decap Turbo) | Decap | V | ✅ | — |

### 1.9 Deployment, infra, performance

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| H1 | One-click deploy (Cloudflare / Deploy module) | Payload, Directus | V | 🟡 create-lumibase + deploy triggers | E9-H01 |
| H2 | Role-based deployments | Directus | V | 🟡 | E9-H03 |
| H3 | Netlify / Vercel publish from Studio | Directus | V | ✅ deployment-integrations | — |
| H4 | Kubernetes Helm chart | Ghost (request) | V | ❌ | E9-H02 |
| H5 | Astro starter; Cloudflare Pages static export | TinaCMS | V | 🟡 Next starter only | E9-H04 |
| H6 | Studio build speed (Vite 8), bundle trimming (date-fns) | Sanity, TinaCMS | V/U | ❓ | E11-X06 |
| H7 | Admin perf: progressive widgets, batched permission checks | Strapi | U | ❓ | E11-X06 |
| H8 | Worker-instance mode; index engine for store queries | Medusa | U | ✅ queues/materialize | — |
| H9 | Pluggable DB adapters (Vercel Postgres) | Payload | I | ✅ Hyperdrive/Neon | — |
| H10 | Framework-migration friction (Next 16, React 19, Node 24) | all | V | 🟡 dependency policy | E11-X09 |

### 1.10 Analytics

| # | Feature | Vendor(s) | M | LumiBase | Epic |
|---|---|---|---|---|---|
| T1 | Dashboard widgets | Payload | I | 🟡 | E2-C07 |
| T2 | Saved member views | Ghost | U | → E6-N07 | — |
| T3 | A/B testing + personalisation | Builder.io | U | ❌ | E12-B01 |
| T4 | Agent receipts analytics | Sanity | V | → E5-A05 | — |

### 1.11 Commerce (Medusa) — adjacent

| # | Feature | M | LumiBase | Epic |
|---|---|---|---|---|
| K1 | Cart promotions, refunds, async payments, price tiers, order sorting, global options | U/I | ➖ core commerce out of scope | E12 adapters only |

### 1.12 Not actionable as features (recorded for completeness)
Directus v12 MSCL licence + software keys + free tier; Strapi Billing portal; Payload→Figma
acquisition; Ghost Digital Public Good; Decap Turbo paid tier; vendor CI tooling (Renovate
dashboards, Playwright shards, nightly npm); issue-intake restrictions; RTL admin (→ E11-X10).

## 2. Cross-cutting themes the digests call out
1. Agent-native / MCP is table stakes; MCP tool-schema fidelity is a fresh defect class.
2. Skills, receipts, provenance for agents (Sanity) — LumiBase's governed-harness edge, under-surfaced.
3. Editorial maturity: global drafts, collaborative editing, diff, releases.
4. Visual editing / rich text is the universal cost centre and attack surface (postMessage, preview secrets).
5. Security pressure: admin rate limits, upload scanning, CVE programmes, hardened images.
6. Deployment convenience: one-click, Helm, Astro/Cloudflare Pages.
7. Memberships + newsletters (Ghost) remain the only mature audience stack among the ten.

## 3. Epic plan (new GitHub epics)

| Epic | Title | Children |
|---|---|---|
| E1 (#667) | Visual editing & live preview | V01–V06 |
| E2 (#668) | Collaborative editing & editorial UX parity | C01–C10 |
| E3 (#669) | Block-based rich text editor | R01–R06 |
| E4 (#670) | Digital asset management parity | D01–D08 |
| E5 (#671) | AI assistant, agent skills & MCP extensibility | A01–A08 |
| E6 (#672) | Memberships, newsletters & audience | N01–N09 |
| E7 (#673) | Data import/export, migration & JSON querying | I01–I04 |
| E8 (#674) | Security hardening parity | S01–S11 |
| E9 (#675) | Deployment & hosting convenience | H01–H05 |
| E10 (#676) | Content modeling parity | M01–M06 |
| E11 (#677) | SDKs, DevEx & Studio platform | X01–X10 |
| E12 (#678) | Personalisation, A/B testing & commerce adapters (post-v1) | B01–B03 |
| #362 | GitOps (existing) — children #765 G-01 separate content repo, #766 G-02 open authoring, #767 G-03 Forgejo/Gitea provider | |

Already covered by existing epics (not re-created): MCP OAuth 2.1 / resources / prompts / SSE
(#344–#347, #361); GitOps write-back (#348–#351); realtime fan-out (#353–#354); public-realm
GraphQL (#356); marketplace (#643).
