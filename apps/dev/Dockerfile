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
COPY apps/evals/package.json apps/evals/package.json

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
ARG VITE_POSTHOG_KEY=""
ARG VITE_POSTHOG_HOST=""
ENV VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY
ENV VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST
# Grafana Faro. VITE_FARO_URL carries the app key and is public by design (it
# ships in the bundle, like a Sentry DSN). VITE_MASKIN_COMMIT_SHA becomes the
# app version, which is what distinguishes one release from another in Grafana.
# It is supplied by docker-compose.prod.yml from Coolify's SOURCE_COMMIT; left
# empty the bundle reports version "unknown". (What ties a stack trace to its
# uploaded source map is a different thing entirely — the bundle id the rollup
# plugin stamps under a global keyed by appName. See apps/web/vite.config.ts.)
ARG VITE_FARO_URL=""
ARG VITE_FARO_APP_KEY=""
ARG VITE_MASKIN_COMMIT_SHA=""
ENV VITE_FARO_URL=$VITE_FARO_URL
ENV VITE_FARO_APP_KEY=$VITE_FARO_APP_KEY
ENV VITE_MASKIN_COMMIT_SHA=$VITE_MASKIN_COMMIT_SHA
# Source-map upload. FARO_API_KEY is a real secret (Grafana Cloud access policy
# token with sourcemaps:write) and is build-time only — it is never VITE_-
# prefixed, so it cannot reach the bundle. When any of these four is unset the
# vite config skips the uploader *and* emits no .map files at all, so an
# unconfigured build never leaves readable maps in the statically-served dist/.
ARG FARO_SOURCEMAP_ENDPOINT=""
ARG FARO_APP_ID=""
ARG FARO_STACK_ID=""
ARG FARO_API_KEY=""
# These four are NOT promoted to ENV, unlike the VITE_ ones above: an ENV
# persists into the final image and into `docker history`, and FARO_API_KEY is
# a secret. They are injected onto the build RUN line below instead, so they
# exist only for the duration of that command. (The ARG values are still
# visible in `docker history` on the build host — if that matters, switch to
# `RUN --mount=type=secret`.)
# NOTE: VITE_SENTRY_DSN is deliberately absent here — see the PR description.
# The Sentry SPA build has never received a DSN at image build time, so the
# frontend half of Sentry has been inert in production. Fixing that is a
# separate change; it is called out so the Faro comparison is not read as
# Faro-vs-Sentry when Sentry was never reporting from the browser.

COPY apps/web/ apps/web/
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
	FARO_SOURCEMAP_ENDPOINT=$FARO_SOURCEMAP_ENDPOINT \
	FARO_APP_ID=$FARO_APP_ID \
	FARO_STACK_ID=$FARO_STACK_ID \
	FARO_API_KEY=$FARO_API_KEY \
	NODE_OPTIONS=--max-old-space-size=1536 pnpm exec turbo run build --filter=@maskin/web

COPY docker/agent-base/ docker/agent-base/
COPY docker/browser-sidecar/ docker/browser-sidecar/

ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "node packages/db/dist/migrate.js && pnpm --filter @maskin/dev exec tsx scripts/seed-marketplace.ts && node apps/dev/dist/index.js"]
