# Stage 1: Build
#
# Both base images are pinned by digest (#734): a tag can be re-pointed, a
# digest cannot, so a rebuild of the same commit gets the same base. The tag
# stays for readers and for Dependabot, which bumps tag and digest together
# (.github/dependabot.yml). Digests are of the multi-arch index, so amd64 and
# arm64 builds both resolve from them.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS builder
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
# Build metadata for `/api/v1/system/version` and the Studio footer. The build
# context has no .git, so the commit must come in as a build arg; the version
# is read from the root package.json. Unset args fall back to "unknown" /
# "development" (scripts/with-build-metadata.mjs).
ARG LUMIBASE_GIT_SHA
ARG LUMIBASE_RELEASE_CHANNEL
# Build Cloudflare Worker bundle (not used at runtime but keeps build parity)
RUN pnpm --filter @lumibase/cms build
# Build Node.js server entrypoint (serve.js) and migration runner (migrate.js)
RUN pnpm --filter @lumibase/cms build:node
# VITE_API_URL is deliberately left unset: the Studio and the CMS answer on the
# same origin here, so the SPA uses relative requests and no CORS entry is
# needed. Setting it would hard-code an origin into the bundle.
RUN pnpm --filter @lumibase/studio build

# Stage 2: Runtime — distroless, non-root, read-only-root compatible (#734)
#
# gcr.io/distroless/nodejs22-debian13 carries Node and its runtime libraries
# and nothing else: no shell, no package manager, no curl. That removes most of
# the OS packages a scanner would ever flag, and most of what an attacker would
# use after getting code execution. Consequences, all handled below:
#
# - No shell, so the entrypoint and the HEALTHCHECK are Node scripts
#   (docker/scripts/*.mjs) and every instruction uses the exec (JSON) form.
# - `:nonroot` runs as UID/GID 65532. The application files are owned by root
#   and are not writable by that user, so the process cannot modify its own
#   code even when the root filesystem is not mounted read-only.
# - The server writes nothing to the filesystem (media goes to S3, state to
#   PostgreSQL/Redis), so `docker run --read-only` works. /tmp is the only
#   path worth mounting as tmpfs, for third-party code that asks os.tmpdir().
#   See docs/en/deployment/docker.md "Hardened image".
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:34985bab6fd6981259f18ab7555995a911ca3bee4b0d38bacdc63932df1dc6cb AS runtime
ARG LUMIBASE_GIT_SHA
LABEL org.opencontainers.image.title="lumibase-cms" \
      org.opencontainers.image.description="LumiBase CMS API + Studio (Node/Docker runtime)" \
      org.opencontainers.image.source="https://github.com/khuepm/lumibase" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${LUMIBASE_GIT_SHA}"
WORKDIR /app
COPY --from=builder /app/apps/cms/dist ./dist
# Drizzle migration SQL files must be present at ./drizzle relative to CWD
COPY --from=builder /app/packages/database/drizzle ./drizzle
# Studio bundle, resolved by serve.ts as ./studio relative to CWD. Override with
# LUMIBASE_STUDIO_DIST, or set LUMIBASE_SERVE_STUDIO=false to run API-only when
# the Studio is hosted separately (e.g. Cloudflare Pages) and two copies would
# risk version skew.
COPY --from=builder /app/apps/studio/dist ./studio
COPY docker/scripts/entrypoint.mjs docker/scripts/entrypoint-lib.mjs docker/scripts/healthcheck.mjs ./bin/
# Numeric, so `runAsNonRoot` admission checks (Kubernetes, Nomad) can verify it
# without resolving a user name.
USER 65532:65532
EXPOSE 1989
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/bin/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node", "/app/bin/entrypoint.mjs"]
