#!/usr/bin/env bash
set -e

# Load .env for DATABASE_URL
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Ensure integration encryption key exists in .env before servers start.
# --skip-db-default: this stack has no local Docker Postgres to fall back to,
# so a missing DATABASE_URL (e.g. a Supabase connection string) must fail fast
# instead of silently writing the localhost default.
node scripts/ensure-encryption-key.mjs --skip-db-default
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "Running database migrations..."
pnpm db:migrate

echo "Starting dev servers..."
export MASKIN_DEV_EXTERNAL=1
exec dotenv -- turbo dev --log-prefix=none
