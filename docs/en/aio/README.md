---
version: 1
lastUpdated: 2026-07-28T10:23:38.100Z
sourceLang: en
contentHash: 6566a4891f71eb1a
---

# AIO (AI Overviews Optimization) — LumiBase

Tracking document for AIO improvements to lumibase.dev and docs.lumibase.dev, plus the plan for a built-in AIO evaluation module.

---

## Version 1 — Quick Wins (DONE, 2026-06-10)

All changes in `apps/landing`:

| Fix | File | Status |
|---|---|---|
| Organization + WebSite JSON-LD (all pages) | `src/app/layout.tsx` | ✅ Done |
| SoftwareApplication JSON-LD (homepage) | `src/app/page.tsx` | ✅ Done |
| FAQPage + BreadcrumbList JSON-LD (pricing) | `src/app/pricing/page.tsx` | ✅ Done |
| `metadataBase` + canonical URLs (all 5 pages) | layout + each `page.tsx` | ✅ Done |
| og:image (1200×630, build-time generated) | `src/app/opengraph-image.tsx` | ✅ Done |
| `/llms.txt` for lumibase.dev | `public/llms.txt` | ✅ Done |
| Sitemap: added `/pricing/`, real lastmod dates | `src/app/sitemap.ts` | ✅ Done |
| Removed false "Join thousands of developers" claim | home + pricing pages | ✅ Done |
| Added "What is LumiBase?" answer-target section | `src/app/page.tsx` | ✅ Done |

### NOT fixable in this repo — requires manual action

#### 1. robots.txt AI crawler blocks (CRITICAL)

The repo's `apps/landing/public/robots.txt` is clean (`Allow: /` for all). The AI-crawler blocks seen on the live site (GPTBot, ClaudeBot, Google-Extended, CCBot, etc. all `Disallow: /`) are injected by **Cloudflare's managed robots.txt** feature.

**To fix:** Cloudflare Dashboard → select the `lumibase.dev` zone → **Settings** (or **Security → Bots**, depending on plan UI) → find **"Manage AI bots"** / **"robots.txt management"** → either:
- Turn off managed robots.txt entirely (repo file then serves as-is), or
- Change the policy from "Block on all pages" to "Only block for AI training" — this keeps `Content-Signal: ai-train=no` while allowing AI search/retrieval crawlers.

**Decision note:** Unblocking means AI systems (ChatGPT, Claude, Perplexity, Gemini) can read and cite the site. The `ai-train=no` content signal still expresses the training opt-out under EU Directive 2019/790 Art. 4 for compliant crawlers, but it is a preference signal, not an enforcement mechanism.

#### 2. GitHub repository metadata

- ~~Commit a `LICENSE` file to repo root~~ — **done**; the root `LICENSE` is tracked.
- ⚠️ **License identity mismatch (open).** The committed `LICENSE` is the **Apache
  License 2.0**, and all four published packages (`sdk`, `mcp-server`,
  `extension-sdk`, `create-lumibase`) declare `"license": "Apache-2.0"`. But the
  landing-site copy, the AIO audit report, and the Devpost draft all say **MIT**.
  One side is wrong and it is a legal claim, not a wording preference — decide
  which license is intended, then make the site copy, `package.json` fields, and
  `LICENSE` agree. AI systems read the license from the repo, so a mismatch also
  costs the trust signal this item was meant to fix.
- Add topics: `headless-cms`, `cloudflare-workers`, `edge`, `typescript`, `cms`, `open-source`.
- Set the Homepage field to `https://lumibase.dev`.

---

## Version 1.5 — Remaining audit items (TODO)

- [ ] Convert `apps/docs` (Vite SPA) to SSR/static HTML — docs.lumibase.dev currently returns a 558-byte shell to crawlers. Options: pre-render with `vite-plugin-ssr`/`vike`, or migrate to VitePress/Starlight which consume the same markdown in `/docs`.
- [ ] About page on lumibase.dev with author name + credentials.
- [ ] Contact email in Privacy Policy and ToS (currently routes to GitHub only — GDPR Art. 12 gap).
- [ ] Public `/changelog` page surfacing CHANGELOG.md.
- [ ] Fix "Last updated: {build date}" on tos/privacy pages — currently `new Date()` at build time, which fakes freshness. Use real content-change dates.
- [ ] Community signals: Show HN post, Product Hunt launch, awesome-cloudflare list submission, Dev.to article. (Brand Authority 8/100 — only fixable through community presence over months, not code.)

---

## Version 2 — Built-in AIO Evaluation Module (PLAN)

**Goal:** A AIO self-audit capability inside LumiBase so any project running LumiBase can score its own content for AI search visibility — without external tools.

### Why it fits LumiBase

LumiBase is a CMS — it owns the content, the rendering, and the deployment. That means it can evaluate AIO signals at the source (before publish) instead of crawling after the fact, which external tools must do.

### Proposed architecture (follows existing module conventions)

```
apps/cms/src/modules/aio/
  index.ts              ← module registration
  service.ts            ← GeoAuditService (business logic)
  routes.ts             ← GET /api/aio/audit, GET /api/aio/score/:itemId
  checks/
    citability.ts       ← passage-level scoring (answer blocks, Q&A density, statistics)
    schema.ts           ← JSON-LD presence/validity per content type
    meta.ts             ← title/description/canonical/OG completeness
    crawlers.ts         ← robots.txt + llms.txt validation for the tenant's domain
    freshness.ts        ← lastmod consistency, dated content
  scoring.ts            ← weighted composite score (configurable weights)

packages/ai-skills/src/skills/
  geo-audit.ts          ← AI Copilot skill: "audit this item/site for AIO" (read-only, no HITL needed)
  geo-fix.ts            ← AI Copilot skill: "generate missing schema/meta" (schema:write → HITL approval)
```

### Design rules (per project conventions)

1. Multi-tenant: every audit row carries `site_id`; results stored per-tenant.
2. IDs: `nanoid()` for `geo_audits` domain table; `uuidv7()` if an audit log table is added.
3. Runtime abstraction: fetch external URLs (robots.txt of the tenant's domain) through `c.get('runtime')` — no direct CF bindings.
4. Response format: `{ data: { score, categories, findings } }`.
5. Lessons from the external skill audit (2026-06-10):
   - Never report "missing" for something the fetcher cannot see — distinguish **verified-absent** from **not-observable** (the WebFetch `<head>`-stripping bug produced 2 false findings).
   - Scores are heuristics — store the rule version with every score so deltas are comparable.
   - Fact checks (schema present? canonical present?) belong in deterministic code; only citability/quality scoring needs an LLM.

### Scoring model (initial weights, configurable per site)

| Category | Weight | Implementation |
|---|---|---|
| Citability | 25% | Deterministic heuristics + optional LLM pass |
| Schema & structured data | 20% | Deterministic (JSON-LD parse + validate) |
| Meta completeness | 20% | Deterministic |
| Crawler access (robots/llms.txt) | 20% | Deterministic (HTTP checks) |
| Freshness | 15% | Deterministic (lastmod vs content updates) |

Brand Authority is **excluded** from the in-product score — it requires external platform scanning (Reddit/HN/Wikipedia), is rate-limited, and is not actionable from inside the CMS.

### Delivery phases

- **Phase A (MVP):** deterministic checks only — `GET /api/aio/audit` returns score + findings for the tenant's published site. No LLM, no new deps.
- **Phase B:** Studio UI panel (score badge per collection item, site-level dashboard).
- **Phase C:** AI Copilot skills (`geo-audit` read-only; `geo-fix` with HITL approval for schema writes).
- **Phase D:** scheduled audits via CDC/cron + delta tracking (reuse `geo-compare` concept).

---

*Last updated: 2026-06-10*
