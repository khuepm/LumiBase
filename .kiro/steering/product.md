# LumiBase — Product Overview

## What is LumiBase?

LumiBase is an **Edge-native Headless CMS** — an open-source alternative to Directus, designed for the Cloudflare edge computing era.

## Core value proposition

| Problem | LumiBase solution |
|---------|------------------|
| Traditional CMSes are slow globally | Runs on Cloudflare Workers in 200+ PoPs |
| Multi-site management is complex | True multi-tenancy with `site_id` isolation at ORM level |
| Migrations break production | Config-as-Code: schema/permissions exportable as JSON/YAML |
| AI tools are dangerous in production | HITL (Human-in-the-Loop) for all destructive AI operations |
| Vendor lock-in to CF | Runtime abstraction layer: same code on CF Workers + Docker |

## Target users

1. **Developers** building multi-site content platforms (agencies, SaaS)
2. **Teams** who want Directus-like DX but with edge performance
3. **Enterprises** needing self-hosted + Cloudflare hybrid deployments
4. **AI-first teams** using agents to manage CMS content and schema

## Differentiators vs Directus

- Edge-native (Workers) — Directus is Node.js only
- HITL AI Copilot with approval workflow
- Runtime abstraction (CF ↔ Docker without code changes)
- Tag-based cache invalidation for instant CDN coherence
- NanoID PKs (not UUIDs) — better URL safety, no sequential enumeration

## Key URLs

- Repo: https://github.com/khuepm/lumibase
- Docs: https://docs.lumibase.dev
- Docs llms.txt: https://docs.lumibase.dev/llms.txt
- Agent Setup: https://docs.lumibase.dev/en/agent-setup/
