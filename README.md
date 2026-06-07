# LumiBase

<div align="center">

**⚡ Edge-Native, AI-Native Headless CMS for Agentic Business Software**

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

LumiBase is an Edge-native, AI-native Headless CMS built for high-performance multi-website deployments and agent-assisted business software generation. Inspired by Directus but designed for the edge computing era, LumiBase adds an Agent Harness Layer so AI agents receive goals, context, tools, permissions, approvals, evaluations, and artifact storage through a governed control plane.

### ✨ Key Features

- **Edge-First Architecture:** Runs entirely on Cloudflare Workers & Hyperdrive for sub-millisecond response times globally
- **True Multi-Tenancy:** Hard-coded `site_id` isolation for complete data separation
- **Page Hydration API:** Delivers layout and data in a single payload for optimal performance
- **GitOps Ready:** Export/import configurations for roles and schemas
- **Privacy-First:** Per-field encryption with AES-GCM for sensitive data
- **Developer Experience:** Type-safe SDKs, comprehensive documentation, and modern tooling
- **Agent Harness Layer:** Goals, runs, tool registry, memory, HITL approvals, evaluations, and versioned artifacts for AI agents

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
pnpm --filter @lumibase/studio dev   # Studio SPA on :5173
```

The Studio placeholder dashboard pings `/api/v1/utils/health` to verify the wire-up. Full documentation lives in [`docs/`](./docs/en/README.md); the task roadmap is in [`docs/en/roadmap/tasks.md`](./docs/en/roadmap/tasks.md). For production release operations, see the upgrade runbooks in [English](./docs/en/operations/upgrades.md) and [Vietnamese](./docs/vi/operations/upgrades.md).

## Release policy

Every release must pass a green GitHub Actions CI run before it can be published or deployed. The required CI gate runs on every pull request and every push to `main`, and includes dependency installation with the locked pnpm version, version policy validation, typechecking, tests, lint for the current stable allowlist, and the production build.

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
