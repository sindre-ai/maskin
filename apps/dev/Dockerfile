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
COPY apps/dev/package.json apps/dev/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/e2e/package.json apps/e2e/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/dev/ apps/dev/
COPY apps/web/ apps/web/

RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm build --concurrency=1

COPY docker/agent-base/ docker/agent-base/

ENV NODE_ENV=production
ENV STATIC_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/dev/dist/index.js"]
