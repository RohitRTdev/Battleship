#!/bin/sh
# Runs the game-service tests against throwaway PostgreSQL and etcd containers.
set -eu

cd "$(dirname "$0")/.."

postgres=$(docker run --detach --rm \
  --env POSTGRES_USER=test --env POSTGRES_PASSWORD=test --env POSTGRES_DB=test \
  --publish 127.0.0.1::5432 \
  postgres:17-bookworm)
trap 'docker stop "$postgres" >/dev/null' EXIT
etcd=$(docker run --detach --rm --publish 127.0.0.1::2379 quay.io/coreos/etcd:v3.6.15 \
  etcd --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://127.0.0.1:2379)
trap 'docker stop "$postgres" "$etcd" >/dev/null' EXIT

port() { docker port "$1" "$2/tcp" | head -n 1 | sed 's/.*://'; }

until docker exec "$postgres" pg_isready -h 127.0.0.1 -U test -d test >/dev/null 2>&1; do sleep 0.5; done
until docker exec "$etcd" etcdctl endpoint health >/dev/null 2>&1; do sleep 0.5; done

TEST_DATABASE_URL="postgresql://test:test@127.0.0.1:$(port "$postgres" 5432)/test" \
TEST_ETCD_ENDPOINTS="127.0.0.1:$(port "$etcd" 2379)" \
  npx tsx --test "$@" test/*.test.ts
