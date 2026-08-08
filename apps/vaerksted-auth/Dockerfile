FROM node:20-alpine
RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json turbo.json ./
# Only the packages apps/vaerksted-auth actually depends on — per design doc
# §4, this service has zero code-level dependency on Maskin's own DB package
# or any other packages/* it doesn't import. Do NOT add packages/db here.
COPY packages/vaerksted-crypto/package.json packages/vaerksted-crypto/package.json
COPY apps/vaerksted-auth/package.json apps/vaerksted-auth/package.json

RUN pnpm install --frozen-lockfile

COPY packages/vaerksted-crypto/ packages/vaerksted-crypto/
COPY apps/vaerksted-auth/ apps/vaerksted-auth/

RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @maskin/vaerksted-crypto build
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @maskin/vaerksted-auth build

ENV NODE_ENV=production
EXPOSE 3001
WORKDIR /app/apps/vaerksted-auth
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
