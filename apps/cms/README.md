## @lumibase/cms

Hono.js API for LumiBase, deployed to Cloudflare Workers.

### Bindings (configure in `wrangler.toml`)

| Binding | Purpose |
| --- | --- |
| `HYPERDRIVE` | Pooled PostgreSQL connection string used by Drizzle. |
| `CONFIG_CACHE` | KV namespace caching configs + permissions. |
| `MEDIA` | R2 bucket for media assets. |

### Endpoints

- `GET /health` — liveness probe.
- `GET /api/v1/deliver/page/:site_id/:slug` — Page Hydration API. Returns layout + section data in one payload (see `docs/architecture/page-hydration.md`).

### Development

```bash
pnpm install
pnpm --filter @lumibase/cms dev   # wrangler dev
```

Set up Hyperdrive first:

```bash
wrangler hyperdrive create lumibase-hyperdrive \
  --connection-string="postgres://user:pass@host:5432/lumibase"
```

Paste the returned id into the commented `[[hyperdrive]]` block in `wrangler.toml`.
