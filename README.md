# LumiBase

<div align="center">
<img width="1024" height="434" alt="Image" src="https://github.com/user-attachments/assets/a11def9c-f238-4a6d-9816-7f7c4f718ea9" />

  **⚡ The Content Operating System — Edge-Native, AI-Native, Agent-Operated**

[![GitHub Stars](https://img.shields.io/github/stars/khuepm/lumibase?style=social)](https://github.com/khuepm/lumibase)
<!-- [![GitHub Sponsors](https://img.shields.io/github/sponsors/khuepm)](https://github.com/sponsors/khuepm) -->
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/khuepm/lumibase/blob/main/LICENSE)

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
- **Edge-first + true multi-tenancy:** Cloudflare Workers delivery, hard `site_id` isolation, page-hydration API, per-field AES-GCM encryption, and type-safe SDKs

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
│   ├── shared/             # Types, zod schemas, policy DSL, field DSL
│   ├── sdk/                # JS SDK (REST + WS) + typegen core
│   ├── ui/                 # Shared shadcn components + CVA tokens
│   └── extension-sdk/      # Types/helpers for building extensions
├── docs/                   # Architecture + feature specs + roadmap
├── architecture.md         # Root summary (update on structural changes)
├── .cursorrules            # AI agent instructions
└── package.json
```

## Quick start

```bash
pnpm install
pnpm --filter @lumibase/cms dev      # Hono API on :1989
pnpm --filter @lumibase/studio dev   # Studio SPA on :2026 (proxies /api → :1989)
```

The Studio placeholder dashboard pings `/api/v1/utils/health` to verify the wire-up. Full documentation lives in [`docs/`](./docs/en/README.md); the task roadmap is in [`docs/en/roadmap/tasks.md`](./docs/en/roadmap/tasks.md). For production release operations, see the upgrade runbooks in [English](./docs/en/operations/upgrades.md) and [Vietnamese](./docs/vi/operations/upgrades.md).

## Release policy

Every release must pass a green GitHub Actions CI run before it can be published or deployed. The required CI gate runs on every pull request and every push to `main`, and includes dependency installation with the locked pnpm version, version policy validation, typechecking, tests, lint for the current stable allowlist, and the production build.

Current release: `v0.21.0` (`2026-07-08`) — **self-service auth realms & Cloudflare Pages pipeline repair**. Adds subscriber registration with email verification, password recovery, rotating refresh tokens (migrations `0005`/`0006`), per-realm session TTLs, audience-pinned tokens, and SDK silent auto-refresh (PR #130); and fixes the Pages deploys that had been failing since `v0.18.0` by decoupling the `apps/marketplace` submodule from the pnpm workspace (built standalone, PAT-authenticated) and correcting the docs deploy verification. It builds on **`v0.20.0`** (backend + SDK gap-closing across 7 specs & high-load/cache readiness), **`v0.19.0`** (CWE Top 100 closeout, Visual Flow Builder triggers & marketplace community features), **`v0.18.0`** (custom domains & translation memory), **`v0.17.0`** (`lumibase_` table namespace & Content Releases), **`v0.16.0`** (code-first configuration & auto-deploy from Flows), **`v0.15.0`** (realtime audience plane & cosmic design system), **`v0.14.0`** (push notifications & MCP path-traversal hardening), **`v0.13.0`** (deployment integrations & cross-collection search), **`v0.12.0`** (privacy & compliance suite, Directus-style interfaces & tenant isolation hardening), **`v0.11.0`** (Insights, content versioning & tenant-scoped search), **`v0.10.0`** (MCP everywhere), **`v0.9.0`** (regulated/sensitive content readiness), and the **`v0.5.0` Content OS foundation** — which remain the baseline this release builds upon, not replaces.

```bash
LUMIBASE_VERSION=0.21.0 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

See [`CHANGELOG.md`](./CHANGELOG.md) for upgrade steps, rollback notes, compatibility details, and backup guidance.

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

## Core Features

1. **Edge-First:** Runs entirely on Cloudflare Workers & Hyperdrive.
2. **True Multi-Tenancy:** Hard-coded `site_id` isolation.
3. **Page Hydration API:** Delivers layout and data in a single payload.
4. **GitOps Ready:** `cms config:export` for roles and schemas.
5. **Agent Harness:** Govern AI agents with goals, context, capabilities, approvals, evaluations, and artifact commits.

---

## 📚 AI Skills Documentation

For detailed AI-assisted development guidance, including database architecture patterns, edge optimization strategies, and UI/UX integration patterns, see [`docs/ai-skills.md`](./docs/ai-skills.md). This comprehensive guide provides the prompts and patterns used to accelerate LumiBase development with AI assistance.

---

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

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
