# Cloudflare Pages CI Deployment Setup

The `pages-deploy.yml` (and `deploy-cms.yml`, `release.yml`) workflows deploy to
Cloudflare on every `vX.Y.Z` tag. They **silently skip** the deploy step when the
required secrets are missing:

```
##[notice] Skipping Cloudflare Pages deployment because
CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not configured.
```

The job still reports **success** (the deploy steps are guarded by
`if: can_deploy == true`), so a green check does **not** prove a deployment
happened. This was the cause of the v0.4.7 release appearing to deploy while
production stayed on the previous build.

## Required GitHub repository secrets

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `792c8e28da56d9568474df5fcf00cfc7` |
| `CLOUDFLARE_API_TOKEN` | A scoped API token (create below) |

## 1. Create the Cloudflare API token

Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Custom token**.

Permissions needed (covers Pages + the CMS Worker deploy):

| Type | Resource | Access |
|---|---|---|
| Account | Cloudflare Pages | Edit |
| Account | Workers Scripts | Edit |
| Account | Workers KV Storage | Edit |
| User | Memberships | Read |

Account Resources: include the account that owns `lumibase.dev` /
`docs.lumibase.dev` (account id `792c8e28…`).

Copy the generated token (shown once).

## 2. Add the secrets to GitHub

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --body "792c8e28da56d9568474df5fcf00cfc7"
gh secret set CLOUDFLARE_API_TOKEN  # paste the token when prompted
```

Or via GitHub UI: **Settings → Secrets and variables → Actions → New repository secret**.

## 3. Re-run a deployment

Either push a new tag, or re-run the existing workflow against the tag:

```bash
gh workflow run pages-deploy.yml -f tag=v0.4.7
```

## 4. Verify production (not the preview URL)

The workflow currently verifies the `*.pages.dev` deployment URL, which always
responds even for preview deployments. Always confirm the **custom domain**:

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  "https://docs.lumibase.dev/en/docs/data-model/?cb=$(date +%s)"   # expect 200 ~200000
curl -s -o /dev/null -w "%{http_code}\n" "https://lumibase.dev/llms.txt?cb=$(date +%s)"  # expect 200
```

## Manual fallback (no CI)

With local `wrangler` authenticated to the owning account:

```bash
# docs (SSG output in dist/)
pnpm docs:build
cd apps/docs && npx wrangler pages deploy dist --project-name lumibase-docs --branch main

# landing (static export in out/)
pnpm landing:build
npx wrangler pages deploy apps/landing/out --project-name lumibase-landing --branch main
```

`--branch main` is required — `main` is the production branch for both projects.
Omitting it creates a preview deployment that does not update the custom domain.

## Suggested workflow hardening (future)

- Make the deploy **fail loudly** when secrets are absent instead of skipping
  silently (drop the `can_deploy` guard, or fail the job with a clear message).
- Change the verify step to curl the **custom domain**, not the `pages.dev` URL.
