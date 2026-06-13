# Stage 1: Build
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/cms/ ./apps/cms/
RUN pnpm install --frozen-lockfile
# Build Cloudflare Worker bundle (not used at runtime but keeps build parity)
RUN pnpm --filter @lumibase/cms build
# Build Node.js server entrypoint (serve.js) and migration runner (migrate.js)
RUN pnpm --filter @lumibase/cms build:node

# Stage 2: Runtime
FROM node:22-slim AS runtime
RUN addgroup --system lumibase && adduser --system --ingroup lumibase lumibase
WORKDIR /app
COPY --from=builder /app/apps/cms/dist ./dist
# Drizzle migration SQL files must be present at ./drizzle relative to CWD
COPY --from=builder /app/packages/database/drizzle ./drizzle
COPY docker/scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER lumibase
EXPOSE 1989
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:1989/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
