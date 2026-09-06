# LumiBase

<div align="center">
<img width="1024" height="434" alt="Image" src="https://github.com/user-attachments/assets/a11def9c-f238-4a6d-9816-7f7c4f718ea9" />

  **⚡ The Content Operating System — Edge-Native, AI-Native, Agent-Operated**

[![GitHub Stars](https://img.shields.io/github/stars/khuepm/lumibase?style=social)](https://github.com/khuepm/lumibase)
<!-- [![GitHub Sponsors](https://img.shields.io/github/sponsors/khuepm)](https://github.com/sponsors/khuepm) -->
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/khuepm/lumibase/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/khuepm/LumiBase/badge)](https://scorecard.dev/viewer/?uri=github.com/khuepm/LumiBase)

[Documentation](https://docs.lumibase.dev) • [Agent Setup](https://docs.lumibase.dev/en/agent-setup/) • [Community](https://github.com/khuepm/lumibase/discussions)

</div>

---

## 🤖 AI Agent Setup

LumiBase is built to work natively with AI coding agents. Get your agent up to speed instantly:

```bash
# For any AI agent — paste this into your first message:
Read https://docs.lumibase.dev/en/agent-setup/prompt.md and follow the setup instructions.
```

| Agent | Config file | Guide |
|-------|------------|-------|
| Claude Code | `CLAUDE.md` (this repo) | [claude-code.md](./docs/en/agent-setup/claude-code.md) |
| Cursor | `.cursorrules` (this repo) | [cursor.md](./docs/en/agent-setup/cursor.md) |
| GitHub Copilot | `.github/copilot-instructions.md` | [github-copilot.md](./docs/en/agent-setup/github-copilot.md) |
| OpenAI Codex | `AGENTS.md` (this repo) | [codex.md](./docs/en/agent-setup/codex.md) |
| Windsurf | See guide | [windsurf.md](./docs/en/agent-setup/windsurf.md) |

**LLM-friendly docs index:** [`docs/llms.txt`](./docs/llms.txt)

---

## 🎯 What is LumiBase?

**LumiBase is a Content Operating System (Content OS)** — a runtime where AI agents *operate* content while humans set intent, taste, and accountability. A traditional CMS is a tool humans use to manipulate content. LumiBase inverts that: you declare the *desired state* of your content, and a control loop of governed agents converges toward it — continuously, with full provenance and human-held veto.

Built Edge-native on Cloudflare Workers for high-performance multi-website delivery, LumiBase pairs that delivery layer with an Agent Harness and an earned-autonomy trust model so automation is something agents *earn*, not something granted. Read the full thesis in [`docs/en/ai-native-vision.md`](./docs/en/ai-native-vision.md).

> **CMS → Content OS:** the unit of work shifts from *operations* (create item, edit field, publish) to *intent* (a declarative goal + constraints + budget); the operator shifts from editor-in-the-UI to *agent-in-a-harness with a human reviewing exceptions*; and content state shifts from *static* (correct at last edit) to *live* (continuously reconciled toward its SLO).

### ✨ Key Features

- **Intent-driven operation:** declare content SLOs (e.g. "every published `product` has ≥1 image, a 50–200 word description, and `vi`+`en` translations"); agents converge content toward them
- **Reconciliation control loop:** continuous drift detection + a reconciler that raises goals on drift and fixes them within a write budget
- **Earned-autonomy trust ledger (L0–L4):** per (site, agent, capability) autonomy from Shadow → Propose → Co-sign → **Veto-window** → Autopilot, with data-driven promotion, auto-demotion on incidents, and a four-scope kill switch
- **Tenant Constitution:** versioned, hashed publish-gate evaluators (rule DSL + LLM-judge); artifacts that fail the constitution never publish, at any autonomy level
- **Provenance-first revisions:** every revision records the agent/run/model, references, constitution hash, evaluation, and approver — exposed on the Delivery API via `?provenance=true`
- **Multi-agent newsroom:** a role library with planner delegation, narrow per-role capability grants, and agent-as-reviewer gated approvals with a self-review ban
- **Studio Mission Control:** exception inbox, trust ledger, kill-switch UI, and per-field pin badges
- **Agent Harness:** goals, context, capabilities, approvals, evaluations, and artifact commits — the governed surface every agent acts through
- **Edge-first + true multi-tenancy:** Cloudflare Workers + Hyperdrive delivery, hard `site_id` isolation, a page-hydration API that returns layout and data in one payload, per-field AES-GCM encryption, and type-safe SDKs
- **GitOps ready:** `cms config:export` puts roles and schemas in version control, so configuration moves between environments as code

## Folder Structure (Turborepo)

```text
lumibase/
├── apps/
│   ├── cms/                # Hono.js backend (Cloudflare Workers)
│   ├── studio/             # No-code admin SPA (React + Vite)
│   ├── docs/               # Vite docs viewer (Cloudflare Pages)
│   ├── landing/            # Next.js marketing site
│   ├── marketplace/        # Next.js marketplace site
│   └── consumer/           # Next.js delivery API demo
├── packages/
│   ├── database/           # Drizzle ORM schema + migrations
│   ├── contracts/          # @lumibase/contracts — Zod schemas, policy/field DSL
│   ├── sdk/                # @lumibase/sdk — JS SDK (REST + WS) + typegen core
│   ├── ui/                 # Shared shadcn components + CVA tokens
│   ├── extension-sdk/      # @lumibase/extension-sdk — extension authoring helpers
│   ├── mcp-server/         # @lumibase/mcp-server — stdio MCP (lumibase-mcp)
│   └── create-lumibase/    # create-lumibase scaffolder
├── docs/                   # Architecture + feature specs + roadmap
├── architecture.md         # Root summary (update on structural changes)
├── .cursorrules            # AI agent instructions
└── package.json
```

## Quick start

Three different things get called "installing LumiBase". Pick the one you actually want.

### 1. A starter app to build on

Scaffolds a minimal **Hono + Drizzle** project with a demo `posts` resource — LumiBase conventions, not the platform. No Studio, no Collections API.

```bash
npm create lumibase@latest my-project
```

Guide: [`docs/en/getting-started.md`](./docs/en/getting-started.md) · package: [`create-lumibase`](https://www.npmjs.com/package/create-lumibase)

### 2. The full Content OS platform

Brings up the CMS plus everything it needs — PostgreSQL, Redis, MinIO, MeiliSearch, imgproxy — with development credentials already wired into the compose file.

```bash
git clone https://github.com/khuepm/lumibase.git && cd lumibase
docker compose -f docker/docker-compose.yml up -d
curl http://localhost:1989/health
```

This gives you the **API** on `:1989`. The Studio is a separate static SPA: it is not in the compose files and not in the CMS image, and the CMS serves no HTML — `GET /setup` returns `404 NOT_FOUND`. To get an admin UI, either run the Studio yourself (option 3 below, or any static host pointed at `apps/studio/dist` with `VITE_API_URL` set to the CMS origin), or complete first-run setup over the API with `POST /api/v1/setup/complete`. See [Deployment overview](./docs/en/deployment/overview.md#studio-api-connectivity).

For a real deployment use the published image (`ghcr.io/khuepm/lumibase-cms`) with the production override and your own secrets — that path has decisions this one skips (TLS to the database, `ENCRYPTION_KEY`, CORS origins):

```bash
cp docker/.env.example docker/.env      # JWT_SECRET, DATABASE_URL, DATABASE_SSL_MODE…
LUMIBASE_VERSION=1.0.0-rc.1 docker compose \
  -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

Runbook: [Deployment overview](./docs/en/deployment/overview.md) · [Deployment checklist](./docs/en/DEPLOYMENT-CHECKLIST.md)

### 3. A development checkout (contributors)

```bash
git clone https://github.com/khuepm/lumibase.git && cd lumibase
pnpm install
cp .env.example .env                    # set JWT_SECRET; defaults match the compose stack
set -a && source .env && set +a         # nothing auto-loads .env, including db:migrate

# infrastructure only — leave the `cms` service out so it does not take :1989
docker compose -f docker/docker-compose.yml up -d \
  postgres redis minio minio-init meilisearch imgproxy
pnpm db:migrate

pnpm cms:dev                            # Hono API on :1989
pnpm studio:dev                         # Studio SPA on :2026 (proxies /api → :1989)
```

Requires Node ≥ 22 and pnpm 9.12.0 (pinned via `packageManager`). Full guide: [Local development](./docs/en/deployment/local-development.md).

**Prerequisites for 2 and 3:** Docker + Docker Compose. Everything else the stack needs comes from the compose file.

Full documentation lives in [`docs/`](./docs/en/README.md); the task roadmap is in [`docs/en/roadmap/tasks.md`](./docs/en/roadmap/tasks.md). For production release operations, see the upgrade runbooks in [English](./docs/en/operations/upgrades.md) and [Vietnamese](./docs/vi/operations/upgrades.md).

## Release policy

Every release must pass a green GitHub Actions CI run before it can be published or deployed. The required CI gate runs on every pull request and every push to `main`, and includes dependency installation with the locked pnpm version, version policy validation, typechecking, tests, lint for the current stable allowlist, and the production build.

Current release: `v1.0.0-rc.1` (`2026-09-03`) — **first release candidate for the stable 1.0 contract**. Introduces the unified [`lumibase`](https://www.npmjs.com/package/lumibase) package (JS/TS client + the `lumibase` CLI: `types`, `doctor`, `init`) while [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) and [`create-lumibase`](https://www.npmjs.com/package/create-lumibase) keep working unchanged. Follows the `0.26.0` migration path; no new migrations.

Every release before this one is summarised in [`CHANGELOG.md`](./CHANGELOG.md), including the **`v0.5.0` Content OS foundation** — intents/SLOs, control-loop reconciliation, the L0–L4 trust ledger, the veto window, the four-scope kill switch, the tenant constitution, provenance-first revisions, the multi-agent newsroom, and Studio Mission Control. That foundation remains the baseline every later release builds upon, not replaces.

```bash
LUMIBASE_VERSION=1.0.0-rc.1 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

See [`CHANGELOG.md`](./CHANGELOG.md) for upgrade steps, rollback notes, compatibility details, and backup guidance.

### Versioning

From `v1.0.0`, LumiBase follows strict [Semantic Versioning](https://semver.org/): breaking changes to the public surface (REST/GraphQL API, `@lumibase/sdk` exports, response envelopes, header and env-var contracts, CLI/setup flags) require a major bump; features are additive in minors; deprecations run for at least one minor before removal. Security fixes cover the current and previous major for 6 months. Full rules: [`docs/en/contributing/versioning-policy.md`](./docs/en/contributing/versioning-policy.md). To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

### Why port 1989?

LumiBase uses `1989` as its default CMS API port as a small tribute to the Web's origin story: in March 1989, Tim Berners-Lee wrote the proposal that became the World Wide Web. The same year also evokes walls coming down, which fits a headless CMS built to separate backend content infrastructure from frontend presentation.

---

<!--
## 🎁 Sponsorship Benefits

Support LumiBase development and get **exclusive AI Skills documentation** to accelerate your application development and marketing success!

### 🚀 Hobby Tier - $29/month

**Perfect for developers who want to build production-ready applications faster.**

**📚 Exclusive AI Skills Documentation:**
- **Database & Migration Architect**: Master schema design with NanoID/UUIDv7, multi-tenancy patterns, and GitOps configuration management
- **Edge & Caching Specialist**: Learn Cloudflare optimization, cache tagging strategies, and file security best practices
- **Unified Data Hydration Logic**: Build single-roundtrip APIs that deliver complete page data for optimal SEO
- **UI/UX Component Bridge**: Master TailwindCSS integration with CVA patterns and dynamic content rendering

**🎯 Practical Marketing Strategies:**
- **Product Launch Playbooks**: Step-by-step guides for launching developer tools and SaaS products
- **Community Building Frameworks**: Strategies to grow and engage your developer community
- **Content Marketing Templates**: Ready-to-use templates for technical blog posts, tutorials, and case studies
- **Growth Hacking Techniques**: Proven methods to acquire users and drive adoption for your products

**✨ Additional Perks:**
- Priority email support
- Early access to new features
- GitHub Sponsors badge
- Vote on feature roadmap
- Custom integrations assistance

### 💎 Enterprise Tier - $99/month

**For teams building mission-critical applications.**

Includes everything in Hobby tier plus:
- Dedicated support channel with SLA guarantees
- Custom SSO integration (SAML, LDAP)
- On-premise deployment support
- Training & onboarding sessions
- Custom contracts and invoicing

[🎯 Become a Sponsor](https://github.com/sponsors/khuepm) and unlock these exclusive resources!
-->

## 📚 AI Skills Documentation

For detailed AI-assisted development guidance, including database architecture patterns, edge optimization strategies, and UI/UX integration patterns, see [`docs/en/ai-skills.md`](./docs/en/ai-skills.md). This comprehensive guide provides the prompts and patterns used to accelerate LumiBase development with AI assistance.

---

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

---

## 📄 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](LICENSE) file for details. `v0.22.0` was the final release under the MIT License; the relicense to Apache 2.0 took effect in `v0.23.0`.

---

## 🙏 Acknowledgments

- Inspired by [Directus](https://directus.io/)
- Built with [Cloudflare](https://cloudflare.com/)
- UI components from [shadcn/ui](https://ui.shadcn.com/)

---

<div align="center">

**⭐ If you find this project helpful, please consider giving it a star!**

Made with ❤️ by [Khuepm](https://github.com/khuepm)

</div>
