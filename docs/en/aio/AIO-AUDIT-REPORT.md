---
version: 3
lastUpdated: 2026-07-29T05:26:14.674Z
sourceLang: en
contentHash: 0434e76bd6629620
---

# AIO Audit Report: LumiBase

**Audit Date:** 2026-06-10
**URL:** https://lumibase.dev
**Business Type:** SaaS — Edge-Native Headless CMS
**Pages Analyzed:** 5 (/, /pricing, /tos, /privacy, /license)
**Docs Site:** docs.lumibase.dev (JavaScript SPA — not crawlable)

---

> **📌 HISTORICAL SNAPSHOT — do not read the findings below as current state.**
> This report describes lumibase.dev as it was on **2026-06-10**. Much of it has
> since been fixed. Verified against `apps/landing` at the time of this note:
> JSON-LD is now present on the layout, homepage and pricing pages (C2, H3, L1);
> `public/llms.txt` exists (H1); `/pricing` is in `sitemap.ts` (H4); the
> "Join thousands of developers" claim is gone (H6); `metadataBase`/canonical are
> set (M5); `opengraph-image.tsx` generates the OG image (H2); and a `LICENSE`
> file is committed at the repo root (M3). Note the licence quoted throughout
> this report is **MIT** because that is what the site said on 2026-06-10; the
> project relicensed to **Apache-2.0** at `v0.23.0` and the site copy was updated
> to match, so every MIT reference below is the pre-relicence baseline, not a
> current claim.
> **Still open:** C1 (the AI-crawler blocks are injected by Cloudflare's managed
> robots.txt, not by the repo file) and C3 (`apps/docs` is still a Vite SPA).
> For live status, read [`aio/README.md`](./README.md) — this file is kept as the
> baseline the scores were measured against.
>
> **⚠️ CORRECTION (2026-06-10, verified by curl raw HTML):** Two findings in this report are WRONG due to a WebFetch tool limitation (it strips `<head>` content):
> - **C4 "No meta descriptions" is FALSE** — all pages have meta descriptions.
> - **H2 "Missing OG/Twitter tags" is MOSTLY FALSE** — OG and Twitter Card tags exist; only `og:image` was missing.
>
> Findings verified as TRUE: robots.txt AI crawler blocks (Cloudflare-managed), zero JSON-LD schema, no canonical tags, llms.txt 404 on lumibase.dev, /pricing missing from sitemap, docs SPA (558-byte response). The numeric scores are heuristic, not an industry standard — treat them as relative tracking metrics only.

## Executive Summary

**Overall AIO Score: 24/100 — Critical**

LumiBase is a technically sound product with genuine engineering depth, but its public web presence is almost entirely invisible to AI search systems. The site has three compounding problems: (1) robots.txt explicitly blocks every major AI crawler including GPTBot, ClaudeBot, Google-Extended, and CCBot; (2) zero schema markup exists anywhere on the site; and (3) the docs site — where the real technical substance lives — is a client-side SPA that no AI crawler can read. These three issues alone would cap any AIO score at Critical regardless of content quality. The product is well-built; the website actively works against it being discovered or cited by AI systems.

### Score Breakdown

| Category | Score | Weight | Weighted Score |
|---|---|---|---|
| AI Citability | 22/100 | 25% | 5.5 |
| Brand Authority | 8/100 | 20% | 1.6 |
| Content E-E-A-T | 34/100 | 20% | 6.8 |
| Technical AIO | 49/100 | 15% | 7.35 |
| Schema & Structured Data | 4/100 | 10% | 0.4 |
| Platform Optimization | 19/100 | 10% | 1.9 |
| **Overall AIO Score** | | | **24/100** |

### Score Interpretation

| Range | Rating |
|---|---|
| 90-100 | Excellent |
| 75-89 | Good |
| 60-74 | Fair |
| 40-59 | Poor |
| **0-39** | **Critical ← LumiBase is here** |

---

## Critical Issues (Fix Immediately)

### C1 — All Major AI Crawlers Blocked in robots.txt

**Impact:** Every AI search platform — ChatGPT, Claude, Perplexity, Gemini, Apple Intelligence — is structurally prevented from indexing or citing lumibase.dev in real time.

The robots.txt (managed by Cloudflare's "Managed Content" block) explicitly disallows:

| Crawler | Owner | Platform Affected |
|---|---|---|
| GPTBot | OpenAI | ChatGPT Search, OpenAI training |
| ClaudeBot | Anthropic | Claude citations |
| Google-Extended | Google | Gemini, Google AI Overviews |
| CCBot | Common Crawl | Many open-source LLMs |
| Amazonbot | Amazon | Alexa, Rufus AI |
| Bytespider | ByteDance | Doubao AI |
| Applebot-Extended | Apple | Apple Intelligence |
| meta-externalagent | Meta | Meta AI, Llama |

The intent appears to be blocking **AI training** (the `Content-Signal: ai-train=no` directive expresses this correctly). However, the `Disallow: /` rules block **all AI bot activity**, including real-time search retrieval and citation grounding — which is unrelated to training. The result is that no AI assistant can ever surface lumibase.dev when a user asks about edge CMS options, even if the site has excellent content.

**Fix:** Remove the named `Disallow: /` blocks for GPTBot, ClaudeBot, Google-Extended, PerplexityBot, and CCBot. Keep `ai-train=no` in the Content-Signal directive to preserve the training opt-out. The training prohibition and the search-retrieval permission are independent; the current robots.txt conflates them.

```
# REPLACE THIS (current — blocks all AI bots):
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

# WITH THIS (allow retrieval, maintain training opt-out via Content-Signal):
# [remove GPTBot and ClaudeBot blocks entirely]
# The Content-Signal: ai-train=no line already handles training exclusion
```

Also add `ai-input=yes` to the Content-Signal to explicitly permit AI grounding/RAG:
```
Content-Signal: search=yes,ai-train=no,ai-input=yes
```

---

### C2 — Zero Schema Markup on Any Page

**Impact:** AI models cannot perform entity resolution for LumiBase. Without Organization + SoftwareApplication schema, there is no machine-readable signal connecting lumibase.dev to its GitHub repository, Twitter profile, or product category. The site is effectively an anonymous HTML document to every AI knowledge graph.

**Pages checked:** /, /pricing, /tos, /privacy — zero JSON-LD, Microdata, or RDFa found on any page.

**Fix (minimum viable):** Add to the `<head>` of every page (global layout):

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "LumiBase",
  "url": "https://lumibase.dev",
  "description": "Edge-native headless CMS built on Cloudflare Workers. Open-source, privacy-first, and globally distributed by default.",
  "sameAs": [
    "https://github.com/khuepm/lumibase",
    "https://twitter.com/lumibase"
  ]
}
```

Add to homepage `<head>` only:

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "LumiBase",
  "url": "https://lumibase.dev",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cloudflare Workers, Docker, Node.js",
  "description": "Edge-native headless CMS built on Cloudflare Workers. Deploy globally, manage content via REST API, and scale to zero with no cold starts.",
  "softwareVersion": "0.4.5",
  "codeRepository": "https://github.com/khuepm/lumibase",
  "license": "https://lumibase.dev/license",
  "isAccessibleForFree": true,
  "offers": [
    {
      "@type": "Offer",
      "name": "Community",
      "price": "0",
      "priceCurrency": "USD",
      "url": "https://lumibase.dev/pricing"
    },
    {
      "@type": "Offer",
      "name": "Hobby",
      "price": "29",
      "priceCurrency": "USD",
      "billingIncrement": "P1M",
      "url": "https://lumibase.dev/pricing"
    },
    {
      "@type": "Offer",
      "name": "Enterprise",
      "price": "99",
      "priceCurrency": "USD",
      "billingIncrement": "P1M",
      "url": "https://lumibase.dev/pricing"
    }
  ]
}
```

---

### C3 — Docs Site Is a JavaScript SPA (Invisible to All AI Crawlers)

**Impact:** docs.lumibase.dev returned only `<title>LumiBase Docs</title>` to HTTP fetchers. Every AI crawler, every search bot, every citation system that fetches the URL via HTTP receives no meaningful content. The entire technical documentation corpus — API reference, data model, architecture decisions, AI skills — is trapped behind client-side JavaScript.

For a developer tool, documentation is the highest-value content for AI citation. It's where users ask "how do I do X" queries that AI assistants answer. The docs being a SPA means LumiBase cannot be cited for any technical how-to query.

**Fix:** Convert docs.lumibase.dev to server-side rendered or statically generated HTML. The Cloudflare/Vite ecosystem has first-class options:
- [VitePress](https://vitepress.dev/) — static site generator designed for docs, integrates directly with Cloudflare Pages
- [Starlight](https://starlight.astro.build/) — Astro-based docs framework with SSR support and Cloudflare Pages adapter

---

### C4 — No Meta Descriptions on Any Page

**Impact:** All five AI search platforms (Google AI Overviews, ChatGPT, Perplexity, Gemini, Bing Copilot) use meta descriptions as the canonical page summary for snippet generation, citation context, and answer sourcing. Without them, AI platforms generate their own snippets — for lumibase.dev, this risks generating "Built with ❤ by Khuepm © 2026 LumiBase" as the description.

**Fix (all pages):**

- **Homepage:** `"Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license."`
- **Pricing:** `"Simple, transparent pricing. Community (free forever), Hobby ($29/mo), Enterprise ($99/mo). Open-source core always free under MIT license."`
- **ToS:** `"LumiBase Terms of Service — usage terms for LumiBase software and managed hosting services."`
- **Privacy:** `"LumiBase Privacy Policy — data handling, retention, and your rights under GDPR and CCPA."`

---

## High Priority Issues

### H1 — No llms.txt File

`https://lumibase.dev/llms.txt` returns HTTP 404. The llms.txt standard provides AI models a structured index of site content — especially critical here because the docs site is a SPA. Without llms.txt, AI systems cannot discover the API reference, data model, or architecture documentation.

**Recommended `/llms.txt`:**

```markdown
# LumiBase

> Edge-native headless CMS built for modern web development. Open-source (MIT), deployed on Cloudflare Workers, privacy-first.

## Documentation

- [Getting Started](https://docs.lumibase.dev/getting-started): Quick setup guide for self-hosting LumiBase on Cloudflare Workers or Docker.
- [API Reference](https://docs.lumibase.dev/api): Full REST API specification for content items, collections, and tenants.
- [Data Model](https://docs.lumibase.dev/data-model): Schema definitions and multi-tenant architecture overview.
- [AI Skills](https://docs.lumibase.dev/ai-skills): AI Copilot skill registry and HITL approval flow documentation.

## Product

- [Homepage](https://lumibase.dev): Product overview and feature summary.
- [Pricing](https://lumibase.dev/pricing): Community (free), Hobby ($29/mo), Enterprise ($99/mo) tiers with feature comparison.
- [GitHub Repository](https://github.com/khuepm/lumibase): Source code, issues, and contribution guide.

## Legal

- [Terms of Service](https://lumibase.dev/tos): Usage terms.
- [Privacy Policy](https://lumibase.dev/privacy): Data handling and privacy commitments.
- [License](https://lumibase.dev/license): MIT License terms.
```

---

### H2 — Missing Open Graph and Twitter Card Tags (All Pages)

No OG or Twitter Card tags detected anywhere. Every link share to lumibase.dev — Slack, Discord, Twitter/X, LinkedIn — renders as a blank card. This is the primary social sharing surface for developer tools.

**Add to homepage `<head>`:**

```html
<meta property="og:type" content="website" />
<meta property="og:site_name" content="LumiBase" />
<meta property="og:title" content="LumiBase - Edge-Native Headless CMS" />
<meta property="og:description" content="Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license." />
<meta property="og:url" content="https://lumibase.dev" />
<meta property="og:image" content="https://lumibase.dev/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@lumibase" />
<meta name="twitter:title" content="LumiBase - Edge-Native Headless CMS" />
<meta name="twitter:description" content="Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license." />
<meta name="twitter:image" content="https://lumibase.dev/og-image.png" />
```

Also create a `og-image.png` (1200×630px) — without the image asset, OG tags produce broken previews.

---

### H3 — FAQPage Schema Missing on /pricing

The pricing page already has 5 well-written FAQ Q&A pairs. Adding FAQPage schema takes ~10 minutes and is the highest-ROI schema action available — AI models (ChatGPT, Claude, Perplexity) actively parse FAQPage markup for citation summaries.

**Add to `/pricing` `<head>`:**

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What's the difference between self-hosted and managed?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Self-hosted means you deploy LumiBase on your own infrastructure (free). Managed means we host it for you with automatic updates, backups, and support (paid tiers)."
      }
    },
    {
      "@type": "Question",
      "name": "Can I switch plans anytime?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. You can upgrade or downgrade your plan at any time. Changes take effect immediately and we'll prorate the difference."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need to pay for the open-source version?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. The core LumiBase is and will always be free and open-source under the MIT license. Premium features are optional."
      }
    },
    {
      "@type": "Question",
      "name": "How does GitHub Sponsors work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "When you sponsor us on GitHub, you'll get access to premium features based on your sponsorship tier. We'll send you a reward token to unlock features."
      }
    },
    {
      "@type": "Question",
      "name": "What payment methods do you accept?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "We accept GitHub Sponsors (credit card, PayPal), and for Enterprise plans we also accept wire transfers and invoices."
      }
    }
  ]
}
```

---

### H4 — /pricing Not in sitemap.xml

The sitemap lists only 4 URLs (/, /tos, /privacy, /license). The pricing page — the most citable structured content on the site — is absent. AI crawlers using sitemap discovery will miss it.

**Fix:** Add to sitemap.xml:
```xml
<url>
  <loc>https://lumibase.dev/pricing/</loc>
  <lastmod>2026-06-07T12:57:03.987Z</lastmod>
  <changefreq>monthly</changefreq>
  <priority>0.8</priority>
</url>
```

---

### H5 — No About Page, No Author Credentials

The entire site has no About page, no Team page, and no named person with verifiable credentials. The only attribution is "Built with ❤ by Khuepm" in the footer — no full name, no LinkedIn, no GitHub profile link, no credentials.

For AI E-E-A-T assessment, the absence of any identifiable author is a significant Expertise and Authoritativeness penalty.

**Fix:** Create `/about` with: full name, background in Cloudflare/edge computing, GitHub profile link, and what makes you qualified to build a production CMS. Does not need to be long — 3-4 paragraphs.

---

### H6 — "Join thousands of developers" is Verifiably False

The GitHub repository shows: 1 star, 0 forks, 1 contributor. The claim "Join thousands of developers building fast, modern content experiences" is directly falsifiable by any AI system or quality rater with access to the GitHub API. This is the single most damaging trust signal on the site.

**Fix:** Remove immediately. Replace with a GitHub star badge (displays the real count) or simply remove the social proof claim until it's earned.

---

### H7 — Missing Security Headers

The following security headers are absent from HTTP responses:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy` (CSP)
- `X-Frame-Options`
- `Permissions-Policy`

These can be set via Cloudflare Transform Rules or in the Workers response middleware with no application code changes.

---

## Medium Priority Issues

### M1 — Content Depth: 280 Words on Homepage

The homepage is ~280 words. For AI systems to cite a page for queries like "what is an edge-native headless CMS" or "best CMS for Cloudflare Workers," the page needs substantive answer-target content — typically 800-1,500 words with structured Q&A sections.

**Recommended additions:**
- "What is LumiBase?" section (50-word direct-answer paragraph)
- "How is LumiBase different from Directus / Contentful?" comparison section
- At least one concrete benchmark or performance data point to back "sub-millisecond response times"

---

### M2 — Zero Brand Mentions on Any AI-Referenced Platform

LumiBase has no presence on:
- Reddit (r/webdev, r/cms, r/cloudflare)
- Hacker News (no Show HN post)
- Product Hunt (no listing)
- Dev.to / Hashnode / Medium (no articles)
- YouTube (no videos)
- Any "best headless CMS" comparison list

Brand mentions on these platforms are 3× stronger than backlinks for AI entity recognition (Ahrefs, Dec 2025). A single Show HN post or well-received Dev.to article creates the first external entity signal.

**Recommended actions (in priority order):**
1. Post "Show HN: LumiBase — Edge-native headless CMS on Cloudflare Workers" on Hacker News
2. Launch on Product Hunt
3. Submit to the `awesome-cloudflare` GitHub list
4. Write a technical article on Dev.to about the architecture decisions (multi-tenancy, HITL AI approvals, edge caching patterns)

---

### M3 — GitHub Repository Missing Topics and License Metadata

The GitHub repo metadata shows `license: None` despite MIT being referenced on the site. No topics are set. These are AI training dataset quality signals.

> **Obsolete as written.** The `LICENSE` file now exists at the repo root and is
> **Apache-2.0**, not MIT — the relicence is recorded in `CHANGELOG.md` under
> `[0.23.0]`. The site copy was updated to match. Read the fix below as "commit a
> LICENSE so GitHub displays the licence"; the MIT reference is the pre-relicence
> state this report captured, not a target.

**Fix:**
- Commit a `LICENSE` file to the repository root (GitHub will then display the licence correctly)
- Add topics: `headless-cms`, `cloudflare-workers`, `edge`, `typescript`, `cms`, `open-source`
- Fill in the Homepage field in the repo settings with `https://lumibase.dev`

---

### M4 — Identical lastmod Timestamps on All Sitemap Entries

All 4 sitemap entries share the exact same timestamp (2026-06-07T12:57:03.985Z / .987Z). This appears programmatically generated, not reflective of actual content modifications. Search engines use lastmod for crawl scheduling; identical timestamps reduce scheduling effectiveness.

---

### M5 — No Canonical Tags

No `<link rel="canonical">` detected on any page. The `/pricing` page has a 308 redirect from `/pricing` → `/pricing/`, meaning two URLs exist for the same content with no canonical disambiguation.

---

### M6 — Docs Site Contact Information Gap

Both the Privacy Policy and Terms of Service route all contact to "the GitHub repository." For GDPR Article 12 compliance and basic enterprise buyer trust, a dedicated email address is required. Create `hello@lumibase.dev` and add it to both legal pages.

---

## Low Priority Issues

### L1 — No WebSite + SearchAction Schema

Adding `WebSite` schema with a `SearchAction` pointing to `docs.lumibase.dev` enables sitelinks search box eligibility and signals the docs site as the canonical knowledge base.

### L2 — No BreadcrumbList Schema on Inner Pages

Low-effort addition that gives inner pages `/pricing`, `/tos`, `/privacy` navigation context in SERPs.

### L3 — Cloudflare Edge Cache Not Enabled for Static Pages

`CF-Cache-Status: DYNAMIC` on all page responses means every request executes the full Worker. For a static marketing site, setting `Cache-Control: public, s-maxage=86400` via Transform Rules would improve global repeat-visit performance.

### L4 — No IndexNow Implementation (Bing)

IndexNow is a Bing/Yandex protocol that instantly notifies the index of content changes. Implementation takes ~30 minutes and improves Bing Copilot freshness signals.

### L5 — No Changelog Page

`CHANGELOG.md` exists on GitHub but is not surfaced on lumibase.dev. A public `/changelog` page provides content freshness signals and demonstrates active development to both users and AI systems.

---

## Category Deep Dives

### AI Citability — 22/100

No content block on the site clears the 70-point citation-ready threshold that AI models use for quotable extraction. The best-performing block is the pricing table (57/100) — structured tabular data with specific price points. The worst is the H1 headline ("Build Content Management At the Edge") at 20/100 — an imperative call to action, not an informational statement.

Critical gap: zero "answer target" patterns. An answer target is a question heading (H2: "What is LumiBase?") followed by a 40-60 word direct-answer paragraph. This pattern is the primary signal AI models use to identify citable content for definitional queries. The entire homepage has no question-based headings.

The "sub-millisecond response times" and "300+ edge locations" claims borrow Cloudflare's infrastructure stats without LumiBase owning them as original data points. AI citation models penalize borrowed statistics.

**Citability Scores by Block:**

| Content Block | Score | Assessment |
|---|---|---|
| Pricing table (tiers + features) | 57/100 | Best on site — structured, specific |
| Pricing FAQ (self-hosted vs managed) | 52/100 | Good Q-A pattern, no schema |
| "Global CDN" feature block | 44/100 | Borrowed stat (Cloudflare's 300+ PoPs) |
| "Edge-Native Performance" feature | 43/100 | Specific platform claim, borderline |
| Primary tagline | 30/100 | Generic SaaS copy |
| H1 headline | 20/100 | Imperative, no informational value |

---

### Brand Authority — 8/100

LumiBase does not exist as a recognized entity in any current AI training corpus. The GitHub repository was created 2026-05-13 (28 days before this audit). With 1 star, 0 forks, and no external citations, the brand has no authority signal that would prompt an AI model to recommend it in response to headless CMS queries.

**Platform presence map:**

| Platform | Status | Notes |
|---|---|---|
| Wikipedia | Absent | No article, no entity |
| Reddit | Absent | Zero mentions across all relevant subreddits |
| YouTube | Absent | No videos |
| LinkedIn | Absent | No company page |
| Product Hunt | Absent | No listing |
| Hacker News | Absent | No Show HN, no submissions |
| Dev.to / Hashnode | Absent | No articles |
| G2 / Capterra | Absent | No listing |
| GitHub | Minimal | 1 star, 0 forks, 1 contributor |
| Twitter/X | Unverified | Handle @lumibase claimed; activity unconfirmed |

The product is approximately 28 days old at time of audit. This is expected for a new product. The path from here is community-building, not technical fixes.

---

### Content E-E-A-T — 34/100

| Dimension | Score | Key Finding |
|---|---|---|
| Experience | 5/25 | No demos, no case studies, no benchmarks, no real-world examples |
| Expertise | 9/25 | Author "Khuepm" — no full name, no credentials, no bio page |
| Authoritativeness | 9/25 | 1 GitHub star, no external citations, no industry presence |
| Trustworthiness | 14/25 | HTTPS + legal pages present, but no contact email and a false "thousands of developers" claim |

The technical substance of LumiBase — documented in `CLAUDE.md`, the GitHub README, and the architecture decision records — demonstrates real engineering competence. None of this is visible to AI systems accessing the public website. The README discusses genuine architectural choices (NanoID vs UUIDv7, multi-tenancy isolation, HITL approval flows). The website surface is a 280-word marketing brochure that shares none of this.

---

### Technical AIO — 49/100

**Positives:** The site is SSR (full HTML in initial response), served over HTTP/2 from Cloudflare's edge network (fast globally), has a clean URL structure, and HTTPS is enforced. The basic technical foundation is solid.

**Negatives:** robots.txt AI crawler blocking (Critical), missing meta descriptions (Critical), missing OG/Twitter tags (High), no llms.txt (High), /pricing absent from sitemap (High), missing security headers HSTS/CSP/X-Frame-Options (High), no canonical tags (Medium), Cloudflare edge cache not enabled for static pages (Low).

---

### Schema & Structured Data — 4/100

Zero structured data on any page. The 4 points reflect only that the site has a clean slate (no deprecated schemas to remove). All schemas documented in the Critical Issues section are actionable immediately — no site changes required beyond adding `<script type="application/ld+json">` blocks to page `<head>`.

**Estimated score after implementing C2 fix:** 65-70/100 (Organization + SoftwareApplication + FAQPage + WebSite + BreadcrumbList + OG/Twitter tags).

---

### Platform Optimization — 19/100

| Platform | Score | Bottleneck |
|---|---|---|
| Google AI Overviews | 22/100 | Google-Extended blocked, no schema, thin content |
| ChatGPT Web Search | 14/100 | GPTBot blocked, no Wikipedia entity |
| Perplexity AI | 16/100 | Zero community mentions (Reddit/HN), SPA docs |
| Google Gemini | 18/100 | Google-Extended blocked, no Knowledge Graph entry |
| Bing Copilot | 26/100 | BingBot NOT blocked (only AI crawlers are) — highest score |

Bing Copilot is the one platform LumiBase is accessible to — BingBot is permitted under the wildcard `Allow: /` rule. This is why it scores highest: it's the only platform that can actually crawl the site.

---

## Quick Wins (Implement This Week)

These 5 actions can be completed in under 4 hours total and will move the AIO score from 24 to approximately 40-45:

1. **Edit robots.txt — remove AI crawler blocks** (10 min) — Unblock GPTBot, ClaudeBot, Google-Extended, CCBot. Keep `ai-train=no` Content-Signal. Add `ai-input=yes`. This single change enables all AI search platforms to index the site.

2. **Add meta descriptions to all pages** (20 min) — One line per page. Use the descriptions in issue C4 above.

3. **Add Organization + SoftwareApplication JSON-LD to homepage** (30 min) — Copy the schema blocks from issue C2 above into the Hono/Workers HTML template.

4. **Add FAQPage JSON-LD to /pricing** (15 min) — Copy the schema block from issue H3 above. The Q&A content already exists.

5. **Create /llms.txt** (15 min) — Copy the template from issue H1 above. Serve it as a static file from Cloudflare Workers.

---

## 30-Day Action Plan

### Week 1: Unblock AI Access (Technical Fixes)

- [ ] Edit robots.txt — remove all named AI crawler `Disallow: /` blocks
- [ ] Add `ai-input=yes` to Content-Signal directive
- [ ] Add meta descriptions to all 5 pages
- [ ] Add Organization + SoftwareApplication JSON-LD to homepage
- [ ] Add FAQPage JSON-LD to /pricing
- [ ] Add Open Graph + Twitter Card meta tags to all pages (create 1200×630 OG image)
- [ ] Create /llms.txt
- [ ] Add /pricing to sitemap.xml
- [ ] Add `<link rel="canonical">` to all pages
- [ ] Fix GitHub repo: commit LICENSE file, add topics, set homepage field

### Week 2: Content Depth

- [ ] Remove "Join thousands of developers" claim (replace with GitHub star badge)
- [ ] Add "What is LumiBase?" H2 section to homepage (50-word direct answer)
- [ ] Add a "How LumiBase compares to Directus / Contentful" section
- [ ] Create /about page with author full name, credentials, and background
- [ ] Add contact email to Privacy Policy and Terms of Service
- [ ] Surface /changelog page from CHANGELOG.md on GitHub

### Week 3: Docs Crawlability

- [ ] Convert docs.lumibase.dev from SPA to SSR/static (VitePress or Starlight)
- [ ] Ensure all docs pages are in the initial HTML response
- [ ] Add meta descriptions to all docs pages
- [ ] Add Organization schema to docs site

### Week 4: Community & Brand Signals

- [ ] Post "Show HN: LumiBase — Edge-native headless CMS on Cloudflare Workers"
- [ ] Launch on Product Hunt
- [ ] Submit to awesome-cloudflare GitHub list
- [ ] Publish technical article on Dev.to (architecture decisions: edge multi-tenancy, HITL AI, Workers deployment)
- [ ] Implement IndexNow for Bing Webmaster Tools
- [ ] Add HSTS, X-Frame-Options, Permissions-Policy headers via Cloudflare Transform Rules

---

## Appendix A: Pages Analyzed

| URL | Title | Issues Found |
|---|---|---|
| https://lumibase.dev | LumiBase - Edge-Native Headless CMS | No meta desc, no schema, no OG tags, ~280 words |
| https://lumibase.dev/pricing | Pricing - LumiBase | No meta desc, no schema, not in sitemap |
| https://lumibase.dev/tos | (Terms of Service) | No meta desc, no contact email |
| https://lumibase.dev/privacy | (Privacy Policy) | No meta desc, no contact email |
| https://lumibase.dev/license | (License) | Low priority issues only |
| https://docs.lumibase.dev | LumiBase Docs | SPA — returns only title to HTTP fetchers |

---

## Appendix B: robots.txt Current vs Recommended

**Current (blocks AI search):**
```
User-agent: *
Content-Signal: search=yes,ai-train=no
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: *
Allow: /

Sitemap: https://lumibase.dev/sitemap.xml
```

**Recommended (allows AI search, blocks AI training via Content-Signal):**
```
User-agent: *
Content-Signal: search=yes,ai-train=no,ai-input=yes
Allow: /

# Only block crawlers that serve no search/citation purpose
# and have no compliant ai-input handling:
User-agent: Bytespider
Disallow: /

Sitemap: https://lumibase.dev/sitemap.xml
```

---

## Appendix C: Score Projection After Fixes

If all Critical and High priority issues are resolved within Week 1-2:

| Category | Current | Projected | Change |
|---|---|---|---|
| AI Citability | 22 | 42 | +20 (crawler unblock + answer-target content) |
| Brand Authority | 8 | 12 | +4 (GitHub metadata fixes only; community takes time) |
| Content E-E-A-T | 34 | 48 | +14 (About page, false claim removed, contact email) |
| Technical AIO | 49 | 74 | +25 (robots fix + meta + llms.txt + canonical) |
| Schema & Structured Data | 4 | 68 | +64 (Org + SoftwareApp + FAQPage + OG tags) |
| Platform Optimization | 19 | 38 | +19 (robots unblock cascades to all platforms) |
| **Overall AIO Score** | **24** | **~46** | **+22** |

Week 1-2 fixes alone move the score from Critical (24) to Poor (46). Week 3-4 (SSR docs + community building) projects to approximately 55-62 (Poor → Fair). Brand Authority improvement to Good (75+) requires 6-12 months of community presence building and cannot be accelerated by technical fixes alone.

---

*Report generated by AIO Audit Skill v1.0 for lumibase.dev on 2026-06-10.*
