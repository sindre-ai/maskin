#!/usr/bin/env bash
# Same flow as dev.sh, but for environments with no Docker (e.g. agent
# sandbox sessions — see .claude/rules/known-pitfalls.md). Swaps
# `docker-compose up postgres seaweedfs` for bootstrap-local-devstack.sh,
# which vendors and runs both as plain unprivileged processes.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Bootstrapping local Postgres + SeaweedFS (no Docker)..."
source "$REPO_ROOT/scripts/bootstrap-local-devstack.sh"

# Load .env first (e.g. for an existing INTEGRATION_ENCRYPTION_KEY), then
# source env.sh LAST so the devstack's DATABASE_URL/S3_* always win over
# whatever .env might already contain (a stale docker-compose default, or a
# leftover value from an earlier failed `pnpm dev` attempt in this sandbox).
if [ -f .env ]; then
	set -a
	source .env
	set +a
fi
source "$MASKIN_DEVSTACK_DIR/env.sh"

# Ensure integration encryption key exists in .env before servers start.
# --skip-db-default: the devstack's real DATABASE_URL is already exported
# for this session — don't let ensure-encryption-key.mjs write the
# docker-compose default over it.
node scripts/ensure-encryption-key.mjs --skip-db-default
if [ -f .env ]; then
	set -a
	source .env
	set +a
fi
source "$MASKIN_DEVSTACK_DIR/env.sh"

echo "Running database migrations..."
pnpm db:migrate

echo "Starting dev servers..."
exec dotenv -- turbo dev --log-prefix=none
