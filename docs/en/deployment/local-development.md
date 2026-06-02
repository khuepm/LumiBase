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

The default local API port is `1989`. Local development can use the development auth bypass only when `LUMIBASE_DEV_AUTH="true"`.

LumiBase uses `1989` as the default CMS port as a tribute to the birth of the World Wide Web proposal in March 1989 and to the broader idea of walls coming down. For a headless CMS, that metaphor is literal: the backend and frontend are no longer locked together.

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
