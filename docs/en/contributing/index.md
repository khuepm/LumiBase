# Contributing to LumiBase

Thank you for your interest in contributing to LumiBase! This guide covers how to set up your development environment, code style conventions, testing requirements, and the PR process.

## Table of contents

- [Development setup](./index.md#development-setup)
- [Code style](./code-style.md)
- [Testing guide](./testing.md)
- [Writing extensions](./extension-dev.md)
- [Versioning policy](./versioning-policy.md)
- [Submitting a PR](#submitting-a-pr)

---

## Development setup

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 LTS | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Docker + Docker Compose | Latest | [docker.com](https://docker.com) |
| Git | ≥ 2.40 | System package manager |

### Clone and install

```bash
git clone https://github.com/lumibase/lumibase.git
cd lumibase
pnpm install
```

### Configure environment

```bash
cp .env.example .env
# Edit .env with your local values (see docs/en/deployment/environment-variables.md)
```

Minimum required for local dev:
```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/lumibase
LOGTO_ENDPOINT=http://localhost:3001
LOGTO_APP_ID=your-local-logto-app-id
LUMIBASE_RUNTIME=docker
```

### Start infrastructure

```bash
# Start PostgreSQL + Redis + MeiliSearch + Logto
docker compose -f docker/docker-compose.yml up -d
```

### Run database migrations

```bash
pnpm -F @lumibase/database db:migrate
```

### Start development servers

```bash
pnpm dev
```

This starts all apps in watch mode:
- **CMS API** — `http://localhost:1989`
- **Studio** — `http://localhost:2026`
- **Docs viewer** — `http://localhost:5174`

---

## Project conventions

### Branch naming

```
feat/short-description          # New feature
fix/short-description           # Bug fix
docs/short-description          # Documentation only
refactor/short-description      # Refactoring
chore/short-description         # Tooling, deps, CI
```

### Commit messages (Conventional Commits)

```
feat(cms): add bulk item delete endpoint
fix(studio): prevent infinite re-render in field editor
docs(api): expand filter operator reference
chore(deps): update drizzle-orm to 0.32.0
test(ai-harness): add property tests for capability check
```

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`

### Dependency overrides & patches

Security pins and source patches for transitive dependencies live under the `pnpm` key in
the root `package.json` (`overrides` and `patchedDependencies`). Every entry **must** be
documented in [Dependency Overrides & Patches](../security/dependency-overrides.md) with
its rationale and the condition for removal. If you add, change, or remove an override or
patch, update that registry in the same PR.

### PR checklist

Before opening a PR, verify:

- [ ] `pnpm typecheck` passes in all affected packages
- [ ] `pnpm test` passes (or new tests added for changed behavior)
- [ ] `pnpm lint` passes
- [ ] Docs updated if the change affects public APIs, configuration, or behavior
- [ ] Release notes include a `Migrations` section for every release, even if it says `None`
- [ ] Database migrations are backward-compatible for at least one release window: add nullable/defaults first, backfill separately, and defer destructive drops to a later cleanup release
- [ ] PR title follows Conventional Commits format
- [ ] `docs/en/data-model.md` updated if schema changed
- [ ] `docs/en/security/dependency-overrides.md` updated if a `pnpm` override or patch changed
- [ ] ADR added if a significant architectural decision was made

---

## Submitting a PR

1. Fork the repository and create a feature branch
2. Make your changes following the conventions above
3. Push to your fork and open a PR against `main`
4. Fill in the PR template — describe the change, link to related issues, and add screenshots for UI changes
5. A maintainer will review within 48 hours

### PR size guidelines

- **Small PRs** (< 200 lines changed) — preferred; easier to review
- **Large PRs** — split into logical commits; add a detailed PR description explaining the overall change

### AI-assisted PRs

If you used an AI agent to generate code, please:
- Review and understand every line before submitting
- Ensure tests pass and aren't trivially passing
- Note AI assistance in the PR description (optional but appreciated)

---

## Getting help

- **GitHub Discussions** — for design questions and feature proposals
- **GitHub Issues** — for bug reports
- **Discord** — for real-time chat with maintainers (link in README)
