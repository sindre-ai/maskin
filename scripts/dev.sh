#!/usr/bin/env bash
set -e

# Load .env for DATABASE_URL
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Set microsandbox as default runtime backend for Mac/Linux
export RUNTIME_BACKEND="${RUNTIME_BACKEND:-microsandbox}"

# Check for KVM availability; fall back to Docker if not present
if [ "$RUNTIME_BACKEND" = "microsandbox" ]; then
  if [ ! -e /dev/kvm ]; then
    echo "Warning: KVM not available, using Docker as runtime backend"
    export RUNTIME_BACKEND=docker
  fi
fi

echo "Using runtime backend: $RUNTIME_BACKEND"

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
exec dotenv -- turbo dev
