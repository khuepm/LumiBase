# Local Development

Install dependencies from the repository root:

```bash
pnpm install
```

## CMS Worker

Run the Cloudflare Worker locally with Wrangler:

```bash
pnpm --filter @lumibase/cms dev
```

The default local API port is `8787`. Local development can use the development auth bypass only when `LUMIBASE_DEV_AUTH="true"`.

## Docs Site

Run the docs viewer:

```bash
pnpm --filter @lumibase/docs dev
```

Build the static docs site before deploy:

```bash
pnpm --filter @lumibase/docs build
```

## Validation

Run focused checks before opening a PR or deploying:

```bash
pnpm --filter @lumibase/docs build
pnpm --filter @lumibase/cms build
pnpm --filter @lumibase/cms test
```
