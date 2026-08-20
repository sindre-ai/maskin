# syntax=docker/dockerfile:1
FROM node:20-alpine
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json turbo.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/realtime/package.json packages/realtime/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/module-sdk/package.json packages/module-sdk/package.json
COPY packages/risk-classifier/package.json packages/risk-classifier/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY extensions/crm/package.json extensions/crm/package.json
COPY extensions/knowledge/package.json extensions/knowledge/package.json
COPY extensions/notetaker/package.json extensions/notetaker/package.json
COPY extensions/work/package.json extensions/work/package.json
COPY apps/dev/package.json apps/dev/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/e2e/package.json apps/e2e/package.json

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Cache mount persists pnpm's content-addressable store across builds on the
# same host, independent of whether the layer above hit Docker's own cache —
# avoids re-downloading unchanged deps whenever the lockfile changes.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
	pnpm config set store-dir /pnpm/store && \
	pnpm install --frozen-lockfile

# Each target's COPY+RUN pair is kept adjacent (instead of batching all COPYs
# up front) so an apps/dev-only or apps/web-only change doesn't force Docker
# to treat earlier, unrelated targets as invalidated. Building via `turbo run`
# (not `pnpm --filter=X build`, which calls each package's script directly and
# bypasses turbo entirely) is what breaks the cascade for cases Docker's own
# layer chain can't avoid (e.g. an apps/dev change forcing the apps/web layer
# to "execute"): turbo checks its persisted per-package task hashes against
# the --mount=type=cache turbo dir and replays cached output in seconds
# instead of re-running an unaffected build.
COPY packages/ packages/
COPY extensions/ extensions/
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
	NODE_OPTIONS=--max-old-space-size=1536 pnpm exec turbo run build --filter='./packages/*'

COPY apps/dev/ apps/dev/
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
	NODE_OPTIONS=--max-old-space-size=1536 pnpm exec turbo run build --filter=@maskin/dev

# Vite reads `import.meta.env.VITE_*` from `process.env` at build time, but a
# Docker ARG alone is not exposed to the shell environment of a RUN command —
# it's only substitutable via `$VAR`. Promote to ENV so the @maskin/web build
# actually bakes the values into the SPA bundle. Empty defaults keep local
# `docker build` (without --build-arg) working.
#
# SENTRY_RELEASE (Node-side runtime) is grouped here — not after the COPY step —
# so all SHA-varying ARGs live in one layer. Placing it later would invalidate
# the cache of every downstream layer on every commit, forcing an unnecessary
# rebuild of the last-mile ENV/EXPOSE steps.
ARG VITE_POSTHOG_KEY=""
ARG VITE_POSTHOG_HOST=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_RELEASE=""
ARG SENTRY_RELEASE=""
ENV VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY
ENV VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE
ENV SENTRY_RELEASE=$SENTRY_RELEASE

COPY apps/web/ apps/web/
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
	NODE_OPTIONS=--max-old-space-size=1536 pnpm exec turbo run build --filter=@maskin/web

COPY docker/agent-base/ docker/agent-base/
COPY docker/browser-sidecar/ docker/browser-sidecar/

ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "node packages/db/dist/migrate.js && pnpm --filter @maskin/dev exec tsx scripts/seed-marketplace.ts && node apps/dev/dist/index.js"]
