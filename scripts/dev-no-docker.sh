#!/usr/bin/env bash
# Same flow as dev.sh, but for environments with no Docker (e.g. agent
# sandbox sessions — see .claude/rules/known-pitfalls.md). Swaps
# `docker-compose up postgres seaweedfs` for bootstrap-local-devstack.sh,
# which vendors and runs both as plain unprivileged processes.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Bootstrapping local Postgres + SeaweedFS (no Docker)..."
source "$REPO_ROOT/scripts/bootstrap-local-devstack.sh"
# bootstrap-local-devstack.sh writes DATABASE_URL/S3_* to env.sh rather than
# exporting them directly, so callers that only need infra up (no full dev
# server) aren't forced to inherit them. Pull them into this shell now.
source "$MASKIN_DEVSTACK_DIR/env.sh"

# Load .env for DATABASE_URL
if [ -f .env ]; then
	set -a
	source .env
	set +a
fi

# Ensure integration encryption key exists in .env before servers start.
# --skip-db-default: bootstrap-local-devstack.sh above already exported the
# real DATABASE_URL for this session — don't let ensure-encryption-key.mjs
# silently overwrite it with the docker-compose default.
node scripts/ensure-encryption-key.mjs --skip-db-default
if [ -f .env ]; then
	set -a
	source .env
	set +a
fi

echo "Running database migrations..."
pnpm db:migrate

echo "Starting dev servers..."
exec dotenv -- turbo dev --log-prefix=none
