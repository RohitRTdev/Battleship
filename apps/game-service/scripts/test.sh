#!/bin/sh
# Runs the game-service tests against throwaway etcd containers.
set -eu

cd "$(dirname "$0")/.."

start_etcd() {
  docker run --detach --rm --publish 127.0.0.1::2379 quay.io/coreos/etcd:v3.6.15 \
    etcd --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://127.0.0.1:2379
}
# One etcd for the single-cluster tests; a control plane and two data clusters for the sharded ones.
etcd=$(start_etcd)
trap 'docker stop "$etcd" >/dev/null' EXIT
control=$(start_etcd)
data_a=$(start_etcd)
data_b=$(start_etcd)
trap 'docker stop "$etcd" "$control" "$data_a" "$data_b" >/dev/null' EXIT

port() { docker port "$1" "$2/tcp" | head -n 1 | sed 's/.*://'; }

for node in "$etcd" "$control" "$data_a" "$data_b"; do
  until docker exec "$node" etcdctl endpoint health >/dev/null 2>&1; do sleep 0.5; done
done

TEST_ETCD_ENDPOINTS="127.0.0.1:$(port "$etcd" 2379)" \
TEST_ETCD_CONTROL="127.0.0.1:$(port "$control" 2379)" \
TEST_ETCD_CONTROL_CONTAINER="$control" \
TEST_ETCD_DATA_B_CONTAINER="$data_b" \
TEST_ETCD_DATA_CLUSTERS="a=127.0.0.1:$(port "$data_a" 2379);b=127.0.0.1:$(port "$data_b" 2379)" \
  npx tsx --test "$@" test/*.test.ts
