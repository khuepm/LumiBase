# Stage 1: Build
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Every workspace tsconfig extends this. The CMS bundles fine without it because
# wrangler and esbuild do not typecheck, but the Studio build runs `tsc -b` and
# without the base config it silently falls back to defaults — ES5 target and no
# `@types/node`, which surfaces as a wall of TS2307/TS2802 errors from packages
# that compile perfectly outside the image.
COPY tsconfig.base.json ./
# pnpm.patchedDependencies references files under patches/ — required by --frozen-lockfile
COPY patches/ ./patches/
COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/cms/ ./apps/cms/
# The Studio SPA ships inside this image so a Docker deployment has an admin UI
# at all. Until now nothing shipped it: no compose file referenced it and this
# stage copied only apps/cms, so `docker compose up` gave an API and `GET /setup`
# answered 404. `serve.ts` mounts whatever lands in /app/studio below.
COPY apps/studio/ ./apps/studio/
RUN pnpm install --frozen-lockfile
# Build Cloudflare Worker bundle (not used at runtime but keeps build parity)
RUN pnpm --filter @lumibase/cms build
# Build Node.js server entrypoint (serve.js) and migration runner (migrate.js)
RUN pnpm --filter @lumibase/cms build:node
# VITE_API_URL is deliberately left unset: the Studio and the CMS answer on the
# same origin here, so the SPA uses relative requests and no CORS entry is
# needed. Setting it would hard-code an origin into the bundle.
RUN pnpm --filter @lumibase/studio build

# Stage 2: Runtime
FROM node:22-slim AS runtime
RUN addgroup --system lumibase && adduser --system --ingroup lumibase lumibase
WORKDIR /app
COPY --from=builder /app/apps/cms/dist ./dist
# Drizzle migration SQL files must be present at ./drizzle relative to CWD
COPY --from=builder /app/packages/database/drizzle ./drizzle
# Studio bundle, resolved by serve.ts as ./studio relative to CWD. Override with
# LUMIBASE_STUDIO_DIST, or set LUMIBASE_SERVE_STUDIO=false to run API-only when
# the Studio is hosted separately (e.g. Cloudflare Pages) and two copies would
# risk version skew.
COPY --from=builder /app/apps/studio/dist ./studio
COPY docker/scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER lumibase
EXPOSE 1989
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:1989/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
