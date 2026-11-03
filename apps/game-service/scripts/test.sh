#!/bin/sh
# Runs the game-service tests against a throwaway PostgreSQL container.
set -eu

cd "$(dirname "$0")/.."

container=$(docker run --detach --rm \
  --env POSTGRES_USER=test --env POSTGRES_PASSWORD=test --env POSTGRES_DB=test \
  --publish 127.0.0.1::5432 \
  postgres:17-bookworm)
trap 'docker stop "$container" >/dev/null' EXIT

until docker exec "$container" pg_isready -h 127.0.0.1 -U test -d test >/dev/null 2>&1; do sleep 0.5; done
port=$(docker port "$container" 5432/tcp | head -n 1 | sed 's/.*://')

TEST_DATABASE_URL="postgresql://test:test@127.0.0.1:$port/test" npx tsx --test "$@" test/*.test.ts
