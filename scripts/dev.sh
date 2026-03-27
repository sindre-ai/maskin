#!/usr/bin/env bash
set -e

# Load .env for DATABASE_URL
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

DOCKER_SERVICES="postgres seaweedfs"
if [ "${WHISPER_ENABLED:-}" = "true" ]; then
  DOCKER_SERVICES="${DOCKER_SERVICES} whisper-server"
fi

echo "Starting Docker services (${DOCKER_SERVICES})..."
docker-compose up -d ${DOCKER_SERVICES}

echo "Waiting for PostgreSQL to be ready..."
until docker-compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done
echo "PostgreSQL is ready."

echo "Running database migrations..."
pnpm db:migrate

echo "Starting dev servers..."
exec dotenv -- turbo dev
