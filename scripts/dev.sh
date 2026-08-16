#!/usr/bin/env bash
set -e

# Load .env for DATABASE_URL
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# TTV instrumentation: fire `install_started` and stamp the state file the
# backend reads to compute `install_completed`/`workspace_first_ready`.
# Silent + fire-and-forget; can never fail the install.
node scripts/lib/install-telemetry.mjs start docker >/dev/null 2>&1 || true

# Ensure integration encryption key exists in .env before servers start.
node scripts/ensure-encryption-key.mjs
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "Starting Docker services (postgres, seaweedfs)..."
docker-compose up -d postgres seaweedfs

echo "Waiting for PostgreSQL to be ready..."
until docker-compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done
echo "PostgreSQL is ready."

echo "Running database migrations..."
pnpm db:migrate

echo "Starting dev servers..."
exec dotenv -- turbo dev --log-prefix=none
