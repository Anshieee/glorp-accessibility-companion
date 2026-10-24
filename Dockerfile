# syntax=docker/dockerfile:1
#
# Accessibility Companion — Cloud Run image (hosted hackathon demo, NOT production).
#
# Multi-stage:
#   0. node24:   official Node 24 binaries (root worker engines likely >=24).
#   1. build:    root deps (npm ci) + TypeScript build; web deps + vite build
#                (Vite 8 / TS 7 / React 19 need a current Node — >=22.12 works,
#                Node 24 covers it).
#   2. runtime:  production root deps only (npm ci --omit=dev), built outputs,
#                Chromium browsers from the Playwright base image, public
#                fixtures. Node 24 is overlaid here too (runtime needs it).
#
# BASE IMAGE PIN — ACTION REQUIRED before the first build:
#   The value below (v1.64.1) is `npm view playwright version` (latest at the
#   time of writing). Once the root package-lock.json exists, READ THE ACTUAL
#   resolved playwright/playwright-core version from the lock there and set
#   ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v<LOCK-VERSION>-noble.
#   The lock and image browsers must match exactly or Playwright fails loudly.
#   Never use an unversioned tag or a guess for the image.
#   Note: @playwright/browser tags are per-version, NOT month-based.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble

FROM node:24-bookworm AS node24

FROM ${PLAYWRIGHT_IMAGE} AS build
# Overlay Node 24 over the Playwright base (might otherwise be Node 22):
# /usr/local/bin precedes /usr/bin in PATH, so every `node`/`npx` resolves to 24.
# The image's bundled npm (safe, lockfile-clean installs) stays as-is and runs
# against the overlaid node.
COPY --from=node24 /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

# Build context is already whitelisted via .dockerignore (source only: root
# package manifests, src/, web/, test/fixtures, deploy plumbing). No .env,
# logs, reports, agent/private files, or node_modules can reach this layer.
COPY . .

# Root package: exact locked deps + TypeScript build -> /app/dist
# (root `build` script configurable — confirm once backend lands)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund \
 && npm run build

# Frontend (independent package): built -> /app/web/dist
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix web ci --no-audit --no-fund \
 && npm --prefix web run build

# Landing page (Next static export -> /app/landing-page/out/, served at `/`;
# demo console web/dist is preserved at `/console`). pnpm-locked; corepack
# ships pnpm with Node 24. No secrets: only the public base URL override
# (NEXT_PUBLIC_GLORP_API_URL) is read, same-origin when unset.
RUN corepack enable \
 && pnpm --dir landing-page install --frozen-lockfile --config.minimumReleaseAge=0 \
 && pnpm --dir landing-page build

# Cheap sanity checks: server build output, demo console entrypoint, and
# landing-page static export entrypoint all exist.
# (App tests are NOT run in the image build; the orchestrator owns test gates.)
RUN test -n "$(find dist -maxdepth 1 -type f)" \
 && test -f web/dist/index.html \
 && test -f landing-page/out/index.html

FROM ${PLAYWRIGHT_IMAGE} AS runtime
COPY --from=node24 /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Minimal runtime deps only; node_modules is far smaller without dev tools.
# IMPORTANT: any package required at runtime to launch Chromium (e.g.
# playwright / playwright-core, NOT @playwright/test) MUST be declared in root
# "dependencies" for this stage to work.
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/landing-page/out ./landing-page/out
# Public HTML fixtures are part of the demo surface for the scan engine.
COPY --chmod=755 test/fixtures ./test/fixtures
RUN chown -R app:app /app
# Non-root runtime. Chromium sandbox flags are the scan engine's
# responsibility (src/) — none are set here.
USER app
# Pre-build verification (by the backend worker / DevOps once sources exist):
#   docker run --rm <built-image> node -v       -> must be v24.x
#   docker run --rm <built-image> npx playwright --version
#     -> must equal the exact version pinned above / installed from the lockfile
EXPOSE 8080
# Root package must define a start script; it must honor the PORT env (8080 on
# Cloud Run). Confirm once the backend lands. Do not expose diagnostics publicly.
CMD ["npm", "run", "start"]
