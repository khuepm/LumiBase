---
version: 2
lastUpdated: 2026-07-28T10:23:38.159Z
sourceLang: en
contentHash: 6324a8666929b9d6
codeVerified: 2026-07-28T10:23:38.159Z
codeVerifiedHash: 6324a8666929b9d6
codeVerifiedClaims: 4
---

# Build with Gemini XPRIZE — Devpost Submission Draft (LumiBase)

> Draft prepared 2026-06-13. Category: **Small Business Services**.
> ⚠️ Items marked `[TODO]` need real evidence from the founder before final submission (judges verify repo, logs, revenue).

---

## Project name

LumiBase — The Content Operating System

## Elevator pitch (≤200 chars)

AI agents run your content operations — writing, translating, SEO, cleanup — against declarative SLOs, with earned autonomy and full provenance. Humans set intent; agents do the work.

## Category

Small Business Services

## Built with (tags)

gemini, google-cloud, typescript, hono, cloudflare-workers, postgresql, drizzle-orm, turborepo, react, docker, zod

## Links

- GitHub repo: https://github.com/khuepm/lumibase (share with testing@devpost.com and judging@hacker.fund) `[TODO: add collaborators]`
- Docs: https://docs.lumibase.dev
- Demo video (3 min): `[TODO: record — must show AI live in production executing key decisions]`

---

## Written narrative (500–1000 words)

### How AI runs this business, day to day

LumiBase is a Content Operating System: a runtime where AI agents *operate* content for small businesses while humans set intent, taste, and accountability. A traditional CMS is a tool a human clicks through. LumiBase inverts that. A customer declares the desired state of their content as an SLO — "every published product has at least one image, a 50–200 word description, and Vietnamese + English translations" — and a control loop of governed agents converges the content toward it, continuously.

Day to day, AI does the operational labor of a content team. A reconciler scans every site against its SLOs and detects drift: products missing translations, stale blog posts, broken links, items without images. Each drift becomes a goal. A planner agent decomposes goals into sub-goals and delegates to a newsroom of narrow-scoped role agents — Writer, Translator, Taxonomist, SEO agent — each holding only the capabilities its role needs. A Reviewer agent fact-checks low-risk output; high-risk output escalates to a human. Gemini powers the reasoning core of this harness: goal decomposition, content generation, and the LLM-judge evaluators that enforce each tenant's editorial constitution.

AI is not a feature bolted onto the product; it is also how we build and run the company. The codebase ships agent-setup contracts (CLAUDE.md, AGENTS.md, .cursorrules, a machine-readable prompt.md) so coding agents implement features under the same non-negotiable rules human contributors follow. Support, onboarding flows, changelog drafting, and documentation are produced agent-first and reviewed by a human.

### What humans do versus what AI does

Humans hold three jobs the system is explicitly designed around. They set **intent**: SLOs, goals, budgets. They encode **taste**: each tenant writes a versioned, hashed "constitution" — brand voice, legal boundaries, quality bars — as rule-DSL and LLM-judge evaluators; an artifact that fails the constitution never publishes, at any autonomy level. And they keep **accountability**: every agent action is revertable, every revision records which agent, run, and model produced it, what sources it used, which constitution hash it was judged against, and who approved it.

Everything else — data entry, translation, tagging, SEO fixes, description writing, content cleanup — is agent labor. Crucially, autonomy is earned, not granted. Each (site, agent, capability) tuple sits on a five-level trust ladder: Shadow → Propose → Co-sign → Veto-window → Autopilot. Promotion is data-driven (N consecutive passing runs, approval rate above threshold, zero incidents); demotion is automatic on any incident. At the veto-window level, agents execute into staging and commit after a timeout unless a human vetoes — humans move from pre-approval to exception handling, which is what makes one person able to govern thousands of agent actions a day. A four-scope kill switch is always available.

### Jobs and economic opportunity beyond the founding team

LumiBase targets the small businesses that can least afford content operations: the local retailer who needs a bilingual product catalog, the agency serving ten such retailers, the solo founder who cannot hire an editor, a translator, and an SEO specialist. By replacing operational content labor, it lets these businesses compete with the content quality of much larger players.

It also creates new, higher-value work. The "editor" role shifts to **constitution author** — a person who encodes editorial judgment once and leverages it across every agent action thereafter, a 1→N multiplier instead of 1→1 editing. Agencies on LumiBase can serve more clients per head and sell governance (constitutions, SLO design, exception review) as a recurring service. Because the core is MIT-licensed and the skill registry is exposed as a standard MCP server, third-party developers can build and sell agents, skills, and extensions on top of the platform — an ecosystem of small AI-native service businesses. `[TODO: add actual numbers — pilot customers, agencies onboarded, marketplace contributors]`

### The story of building this way

LumiBase began as an edge-native headless CMS. Partway through, we confronted an honest question: if agents are about to do most content work, why build another UI for humans to click? We refactored the product around the answer (v0.5.0): the primary API became `POST /agent/goals` rather than `POST /items`; the UI became Mission Control — exception inbox, trust ledger, kill switch — rather than an editing surface. Every new feature must answer "how does an agent call it?" before "how does the UI show it?"

Building a business this way means the founding team stays tiny while the operating capacity scales with compute. The hard problems turned out not to be generation quality but governance: how to let agents act without letting them act *wrongly*, and how to make silence-means-consent safe. The trust ledger, the constitution gate, and provenance-first revisions are our answers — and they are also why a small business can trust an AI-operated system with its public voice.

`[Word count target: 500–1000. Current ≈ 760]`

---

## Revenue evidence

`[TODO — must be real:]`
- Pricing: open-source MIT core (free) · Hobby $29/mo managed hosting · Enterprise $99/mo (SSO, dedicated support)
- ⚠️ `[TODO]` **Verify the license before submitting.** This draft says MIT in two
  places, but the repo ships Apache-2.0 (root `LICENSE` + every published
  `package.json`). Judges verify the repo, so submitting the wrong license is a
  factual error against evidence they will check.
- Stripe dashboard export / bank statement / simple P&L (template: https://docs.google.com/spreadsheets/d/1pAJrEMo7_QID6V62sA4C8XwGBHkxDTVX3wtYNE2fulI/edit)
- Corporate ID if available

## Expenses (hackathon period)

`[TODO — must be disclosed even if zero:]`
- Marketing & customer acquisition spend: $___
- Infrastructure (Cloudflare, Google Cloud/Gemini API): $___
- Other: $___

## Product evidence (AI running in production)

`[TODO — export from live system:]`
- Agent execution logs (`agent_runs`, `agent_goals`, `agent_evaluations` tables)
- Gemini API usage records (Google Cloud console billing/quota screenshots)
- Studio Mission Control screenshots: exception inbox, trust ledger, reconciler runs
- Provenance API responses (`?provenance=true`)

## Customer evidence

`[TODO — real customers only:]`
- Name / email / phone of real customers
- Testimonials or feedback

---

## Devpost "About the project" sections (if form uses standard fields)

**Inspiration:** Content teams at small businesses drown in operational labor — translation, tagging, SEO, cleanup — that AI can now do, but no CMS was built for agents to *operate* safely.

**What it does:** Declares content state as SLOs; governed AI agents continuously reconcile content toward them, with earned autonomy (L0–L4), a tenant constitution gating every publish, and full provenance on every revision.

**How we built it:** Turborepo monorepo; Hono on Cloudflare Workers (edge delivery) with a Docker/Node adapter; PostgreSQL + Drizzle; Zod contracts shared across CMS, Studio, and SDKs; Gemini as the agent reasoning + LLM-judge layer; skill registry exposed as an MCP server.

**Challenges:** Designing governance that scales — binary HITL doesn't; we built the trust ladder and veto-window (silence-means-consent with absolute rollback).

**Accomplishments:** v0.5.0 Content OS refactor: reconciliation loop, trust ledger, constitution publish-gate, multi-agent newsroom, provenance-first revisions.

**What we learned:** The hard problem is not generation, it's accountability. Autonomy must be earned per capability, and every byte needs a lineage.

**What's next:** Agent marketplace on the MCP surface, more Gemini-powered role agents, managed-hosting growth for SMB customers.
