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
COPY extensions/knowledge/package.json extensions/knowledge/package.json
COPY extensions/work/package.json extensions/work/package.json
COPY apps/dev/package.json apps/dev/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/e2e/package.json apps/e2e/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY extensions/ extensions/
COPY apps/dev/ apps/dev/
COPY apps/web/ apps/web/

# Build sequentially to stay within 8GB server memory
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter='./packages/*' build
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter=@maskin/dev build
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter=@maskin/web build

COPY docker/agent-base/ docker/agent-base/

ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/dev/dist/index.js"]
