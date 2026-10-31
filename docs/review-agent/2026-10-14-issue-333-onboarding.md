# Issue #333 — onboarding reconciliation and review

Date: 2026-10-14 (Asia/Ho_Chi_Minh). Canonical issue: https://github.com/khuepm/LumiBase/issues/333. Parent: #331.

## Scope and findings

The worktree's two historical documentation commits predate the real Next.js starter. Current main already contains the starter/platform/consumer decision table, runtime-versus-CLI dependency guidance, SDK command examples, and linked CLI/tutorial pages. Resolving the merge keeps those newer pages instead of restoring the obsolete claim that every scaffold is a minimal Hono application.

The remaining local-development guide had reproducible source mismatches:

- Referenced a nonexistent root `.env.example` and did not export variables for migration/Node processes.
- Used PostgreSQL credentials and a MeiliSearch variable/key inconsistent with Compose and the runtime adapter.
- Started all Compose services, including CMS, before starting another CMS on port 1989.
- Sent readers to the API port for a Studio setup page and gave an ineffective Vite port argument form.
- Described unconfigured Wrangler bindings as available by default.

Both EN and VI now describe an explicit host Node CMS + infrastructure-only Compose path, a gitignored host environment file, a separate Studio process, and the alternate Wrangler path. No production code, schema, permissions, seeds, crawler policy, or credentials were changed. The credentials shown are existing local development defaults.

## Reviewer-run evidence

- Compared commands and variables against root/package scripts, `docker/docker-compose.yml`, Docker runtime configuration, `apps/cms/src/serve.ts`, Studio routing, and Wrangler configuration.
- Frozen-lockfile install completed without changing manifests/lockfile.
- EN/VI pair stamping with `--verified`: 8 code references verified; pair parity: zero problems.
- `pnpm docs:build`: builds and prerenders the documentation; no deployment performed.
- `docker compose -f docker/docker-compose.yml config --services`: all named infrastructure services exist. No containers or migrations were started against a shared database.
- Full pre-commit guards/tests and remote CI results are recorded on the PR.

## Deployed documentation observation

On 2026-10-14, curl requests returned HTTP 200 for all of:

- https://docs.lumibase.dev/en/docs/getting-started/
- https://docs.lumibase.dev/vi/docs/getting-started/
- https://docs.lumibase.dev/en/docs/deployment/local-development/
- https://docs.lumibase.dev/vi/docs/deployment/local-development/
- https://docs.lumibase.dev/robots.txt
- https://docs.lumibase.dev/sitemap.xml

Guide responses contain rendered headings/content in initial HTML and self-canonical links. The sitemap lists the guide routes. Public robots rules allow `/`. Requests using Googlebot, bingbot and OAI-SearchBot user-agent strings also returned 200 for the English getting-started guide. This is HTTP evidence from this machine, not proof of verified crawler IP access or actual search indexing; authenticated Cloudflare configuration was not inspected. A Python urllib probe returned 403, so client-dependent filtering remains possible. No AI-training crawler restrictions were altered.

The live pages are the existing deployment, not proof that this PR has shipped. End-to-end setup on a fresh database and publication of the revised local guide are not claimed.
