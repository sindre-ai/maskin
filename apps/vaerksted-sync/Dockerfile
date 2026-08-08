FROM node:20-alpine
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json turbo.json ./
# Only the packages apps/vaerksted-sync actually depends on — per design doc
# §4, this service has zero code-level dependency on Maskin's own DB package,
# apps/vaerksted-auth's internals, or any other packages/* it doesn't
# import. Do NOT add packages/db or apps/vaerksted-auth here.
COPY packages/vaerksted-crypto/package.json packages/vaerksted-crypto/package.json
COPY apps/vaerksted-sync/package.json apps/vaerksted-sync/package.json

RUN pnpm install --frozen-lockfile

COPY packages/vaerksted-crypto/ packages/vaerksted-crypto/
COPY apps/vaerksted-sync/ apps/vaerksted-sync/

RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @maskin/vaerksted-crypto build
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @maskin/vaerksted-sync build

ENV NODE_ENV=production
EXPOSE 3002
WORKDIR /app/apps/vaerksted-sync
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
