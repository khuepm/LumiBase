# AI Skills Documentation for LumiBase Development

This document contains the structured AI prompts and skills used to guide AI-assisted development of LumiBase. Copy these sections into your AI assistant's system prompt or use them as reference when working with AI coding assistants.

---

## 1. Project Blueprint: LumiBase Core Identity

**Objective:** Help AI understand the essence and vision of the project.

* **Project Name:** Lumibase.
* **Philosophy:** "Directus-inspired, Edge-native, Production-ready".
* **Problem Solved:** Overcome Directus weaknesses in Multi-tenancy, ID collision, poor cache management, and CI/CD difficulties.
* **Core Architecture:** Headless CMS supporting dynamic data management combined with UI configuration (Page-builder mindset) returned in a single API call.

---

## 2. Technical Stack Definition (The "Hard" Skills)

**Objective:** Strictly define the technologies AI is allowed to use.

* **Runtime:** Node.js (Edge-compatible, prefer Hono.js or ElysiaJS).
* **Database:** PostgreSQL (Hybrid RDBMS + JSONB).
* **Infrastructure:** Cloudflare Stack (Workers, R2, Hyperdrive, KV).
* **Authentication:** Logto (OIDC, Multi-tenancy).
* **Communications:** Resend (Email), Webhooks (Event-driven).
* **Frontend Reference:** Next.js (App Router, SSR), TailwindCSS, Shadcn UI.

---

## 3. AI Skills / System Prompts

Copy the following sections into your AI assistant's system prompt or project README to ensure AI always follows these guidelines:

### Skill 1: Database & Migration Architect

> **Task:** Design schema and data synchronization mechanisms.
> * **ID Rules:** Absolutely no Serial/Auto-increment. Use NanoID (short, URL-friendly) or UUIDv7.
> * **Multi-tenancy:** Every table must have `site_id` for absolute Row-Level data separation.
> * **Config-as-Code:** Build module to export/import configuration (Roles, Permissions, Collections) to YAML/JSON files to support GitOps.

### Skill 2: Edge & Caching Specialist

> **Task:** Optimize performance on Cloudflare.
> * **Cache Tagging:** Implement cache invalidation by Tag in Redis/Cloudflare KV. When a record updates, invalidate all related cache-keys.
> * **File Security:** Build middleware to check File Signature (Magic Numbers) before upload to Cloudflare R2, do not trust file extensions from client.

### Skill 3: Unified Data Hydration Logic

> **Task:** Handle "1-roundtrip" data flow.
> * **Logic:** Design API `/deliver/{page_slug}` that aggregates Page Config (from `pages` table) and Data (from related `collections`) into a single JSON.
> * **SEO-Ready:** Ensure returned JSON structure has enough information for Next.js SSR to render complete HTML without additional API calls.

### Skill 4: UI/UX Component Bridge

> **Task:** Connect CMS with TailwindCSS/Next.js.
> * **Pattern:** Use Class Variance Authority (CVA) to map CMS "Intents" to actual Tailwind classes.
> * **Rich Content:** Use `html-react-parser` to handle dynamic HTML from CMS, ensuring conversion of `<a>` tags to Next.js `<Link>` and `<img>` tags to Next.js `<Image>`.

---

## 4. Packaging for AI

To enable AI to actually start "coding", organize your project directory as follows:

1. **`/docs/specs`**: Contains detailed Markdown files for each feature (Auth, File, Caching).
2. **`/docs/prompts`**: Contains the "Skills" listed above.
3. **`/schema`**: Contains initial SQL files or Prisma/Drizzle definition files.
4. **`.cursorrules` (If using Cursor):** Paste the entire "Technical Stack" and "Skills" here. AI will automatically follow these every time you write code.

---

## 5. Usage with AI Coding Assistants

When working with AI coding assistants (Cursor, GitHub Copilot, Claude, etc.), provide the following context:

```
You are working on LumiBase, an Edge-native Headless CMS. Follow these strict guidelines:

- Use NanoID or UUIDv7 for all IDs (no auto-increment)
- Every table must have site_id for multi-tenancy
- Build for Cloudflare Workers edge deployment
- Use Hono.js for backend APIs
- Implement cache tagging for invalidation
- Use Class Variance Authority for Tailwind mapping
- Design single-roundtrip APIs for optimal performance
- Follow the Technical Stack defined in docs/ai-skills.md

Refer to docs/ai-skills.md for detailed skill definitions and patterns.
```

---

## 6. Sponsorship Benefits

This AI Skills documentation is part of the exclusive content provided to GitHub Sponsors at the Hobby tier ($29/month) and above. Sponsors receive:

- Complete AI Skills documentation with detailed prompts
- Practical marketing strategies for developer tools
- Product launch playbooks
- Community building frameworks
- Content marketing templates
- Growth hacking techniques

[Become a Sponsor](https://github.com/sponsors/khuepm) to unlock these resources and accelerate your development with AI assistance.
