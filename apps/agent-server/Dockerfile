FROM ubuntu:24.04

# Install Node.js 20, system deps for microsandbox native addon
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates libdbus-1-3 && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config and package.json files for dependency install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json turbo.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY apps/agent-server/package.json apps/agent-server/package.json

RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/db/ packages/db/
COPY packages/shared/ packages/shared/
COPY packages/storage/ packages/storage/
COPY apps/agent-server/ apps/agent-server/

# Build packages then agent-server
RUN pnpm --filter='@maskin/db' --filter='@maskin/shared' --filter='@maskin/storage' build
RUN pnpm --filter=@maskin/agent-server build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/agent-server/dist/index.js"]
